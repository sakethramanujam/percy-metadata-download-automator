import {
  Component,
  ReactNode,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useTexture } from "@react-three/drei";
import * as THREE from "three";
import type { Camera } from "./api";
import { thumbUrl } from "./api";
import {
  bodyCamQuatToThreeAligned as bodyCamQuat,
  bodyDirToThreeAligned as bodyDirToThree,
  bodyPosToThreeAligned as bodyPosToThree,
  bodyRightToThreeAligned as bodyRightToThree,
  bodyUpToThreeAligned as bodyUpToThree,
} from "./coords";

const toThree = bodyPosToThree;
const lookThree = bodyDirToThree;

function PhotoPlane({ cam, textureUrl }: { cam: Camera; textureUrl: string }) {
  const texture = useTexture(textureUrl);
  useEffect(() => {
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 8;
  }, [texture]);

  const { origin, look, width, height, dist, quat } = useMemo(() => {
    const origin = toThree(cam);
    const look = lookThree(cam);
    const dist = 1.5;
    const hfov = ((cam.hfov_deg ?? 45) * Math.PI) / 180;
    const vfov = ((cam.vfov_deg ?? 34) * Math.PI) / 180;
    const width = 2 * dist * Math.tan(hfov / 2);
    const height = 2 * dist * Math.tan(vfov / 2);
    const quat = bodyCamQuat(cam);
    return { origin, look, width, height, dist, quat };
  }, [cam]);

  const center = origin.clone().add(look.clone().multiplyScalar(dist));

  return (
    <mesh position={center} quaternion={quat}>
      <planeGeometry args={[width, height]} />
      <meshBasicMaterial map={texture} side={THREE.DoubleSide} toneMapped={false} />
    </mesh>
  );
}

function EyeCamera({
  cam,
  yaw,
  pitch,
}: {
  cam: Camera;
  yaw: number;
  pitch: number;
}) {
  const { camera } = useThree();
  const base = useMemo(() => {
    const origin = toThree(cam);
    const look = lookThree(cam);
    let up = bodyUpToThree(cam);
    let right = bodyRightToThree(cam);
    // Ensure orthonormal
    right = new THREE.Vector3().crossVectors(look, up);
    if (right.lengthSq() < 1e-8) {
      right = new THREE.Vector3().crossVectors(look, new THREE.Vector3(0, 1, 0));
    }
    right.normalize();
    up = new THREE.Vector3().crossVectors(right, look).normalize();
    const fov = cam.vfov_deg ?? cam.hfov_deg ?? 50;
    return { origin, look, right, up, fov };
  }, [cam]);

  useFrame(() => {
    const { origin, look, right, up, fov } = base;
    const qYaw = new THREE.Quaternion().setFromAxisAngle(up, yaw);
    const lookY = look.clone().applyQuaternion(qYaw);
    const rightY = right.clone().applyQuaternion(qYaw);
    const qPitch = new THREE.Quaternion().setFromAxisAngle(rightY, pitch);
    const finalLook = lookY.clone().applyQuaternion(qPitch).normalize();

    camera.position.copy(origin);
    camera.up.copy(up);
    camera.lookAt(origin.clone().add(finalLook));
    if (camera instanceof THREE.PerspectiveCamera) {
      camera.fov = Math.min(Math.max(Number(fov) || 50, 20), 100);
      camera.near = 0.02;
      camera.far = 200;
      camera.updateProjectionMatrix();
    }
  });

  return null;
}

function DragLook({
  setYaw,
  setPitch,
}: {
  setYaw: (v: number | ((p: number) => number)) => void;
  setPitch: (v: number | ((p: number) => number)) => void;
}) {
  const dragging = useRef(false);
  const last = useRef({ x: 0, y: 0 });
  const { gl } = useThree();

  useEffect(() => {
    const el = gl.domElement;
    const onDown = (e: PointerEvent) => {
      dragging.current = true;
      last.current = { x: e.clientX, y: e.clientY };
      el.setPointerCapture(e.pointerId);
    };
    const onUp = (e: PointerEvent) => {
      dragging.current = false;
      try {
        el.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    };
    const onMove = (e: PointerEvent) => {
      if (!dragging.current) return;
      const dx = e.clientX - last.current.x;
      const dy = e.clientY - last.current.y;
      last.current = { x: e.clientX, y: e.clientY };
      const sens = 0.005;
      setYaw((y) => y - dx * sens);
      setPitch((p) => Math.max(-1.1, Math.min(1.1, p - dy * sens)));
    };
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointerleave", onUp);
    el.addEventListener("pointermove", onMove);
    return () => {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointerleave", onUp);
      el.removeEventListener("pointermove", onMove);
    };
  }, [gl, setYaw, setPitch]);

  return null;
}

class LoadCatch extends Component<
  { children: ReactNode; onError: () => void },
  { err: boolean }
> {
  state = { err: false };
  static getDerivedStateFromError() {
    return { err: true };
  }
  componentDidCatch() {
    this.props.onError();
  }
  render() {
    if (this.state.err) return null;
    return this.props.children;
  }
}

/**
 * First-person view through a selected rover camera image.
 * Drag to look around; the photo is a FOV-matched plane in the scene.
 */
export default function EyeView({
  camera,
  imageSize = "medium",
  onClose,
  onPrev,
  onNext,
  hasPrev,
  hasNext,
  indexLabel,
}: {
  camera: Camera;
  imageSize?: "small" | "medium" | "large";
  onClose: () => void;
  onPrev: () => void;
  onNext: () => void;
  hasPrev: boolean;
  hasNext: boolean;
  indexLabel: string;
}) {
  const [yaw, setYaw] = useState(0);
  const [pitch, setPitch] = useState(0);
  const [texError, setTexError] = useState(false);
  const size = imageSize === "large" ? "large" : imageSize;
  const url = thumbUrl(camera.imageid, size as "small" | "medium" | "large");

  useEffect(() => {
    setYaw(0);
    setPitch(0);
    setTexError(false);
  }, [camera.imageid]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowLeft" || e.key === "a" || e.key === "A") onPrev();
      if (e.key === "ArrowRight" || e.key === "d" || e.key === "D") onNext();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, onPrev, onNext]);

  return (
    <div className="eye-view">
      <Canvas
        camera={{ fov: 50, near: 0.02, far: 200, position: [0, 0, 0.1] }}
        style={{ background: "#05080c" }}
      >
        <color attach="background" args={["#05080c"]} />
        <ambientLight intensity={1} />
        <EyeCamera cam={camera} yaw={yaw} pitch={pitch} />
        <DragLook setYaw={setYaw} setPitch={setPitch} />
        {!texError && (
          <Suspense fallback={null}>
            <LoadCatch onError={() => setTexError(true)}>
              <PhotoPlane cam={camera} textureUrl={url} />
            </LoadCatch>
          </Suspense>
        )}
      </Canvas>

      <div className="eye-chrome top">
        <div>
          <strong>Rover eye view</strong>
          <span className="muted">
            {" "}
            · {camera.instrument} · sol {camera.sol ?? "?"} · {indexLabel}
          </span>
        </div>
        <button type="button" onClick={onClose}>
          Exit (Esc)
        </button>
      </div>

      <div className="eye-chrome bottom">
        <button type="button" disabled={!hasPrev} onClick={onPrev}>
          ← Prev
        </button>
        <div className="eye-hint muted">
          Drag to look · ←/→ or A/D step images · Esc exit
          {texError ? " · image failed to load" : ""}
        </div>
        <button type="button" disabled={!hasNext} onClick={onNext}>
          Next →
        </button>
      </div>

      <div className="eye-meta">
        <div>{camera.title || camera.imageid}</div>
        <div className="muted">
          FOV ~{Number(camera.hfov_deg ?? 0).toFixed(0)}° ×{" "}
          {Number(camera.vfov_deg ?? 0).toFixed(0)}° · {camera.filter_name}
        </div>
      </div>
    </div>
  );
}
