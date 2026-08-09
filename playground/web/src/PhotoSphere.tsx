import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useThree, useFrame } from "@react-three/fiber";
import { useTexture } from "@react-three/drei";
import * as THREE from "three";

/**
 * Immersive photo sphere: equirectangular JPEG mapped inside a sphere.
 * Texture is pose-driven stitch (body frame: az 0 = +X forward).
 *
 * Three.js sphere UVs place u=0 at +X; we flip geometry so the camera
 * sits inside and drag-look matches natural pan.
 */

function SphereMesh({ url }: { url: string }) {
  const tex = useTexture(url);
  useEffect(() => {
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    // Equirect: u=0 left (−180°), u=0.5 forward (0°) in our stitch
    // SphereGeometry puts u=0 at +X after flip — offset so center = forward
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.offset.x = 0.5; // align az 0 (image center) with look forward
    tex.needsUpdate = true;
  }, [tex]);

  return (
    <mesh scale={[-1, 1, 1]}>
      <sphereGeometry args={[500, 96, 64]} />
      <meshBasicMaterial map={tex} side={THREE.FrontSide} toneMapped={false} />
    </mesh>
  );
}

function LookControls({
  yaw,
  pitch,
  setYaw,
  setPitch,
}: {
  yaw: number;
  pitch: number;
  setYaw: (y: number) => void;
  setPitch: (p: number) => void;
}) {
  const { camera, gl } = useThree();
  const dragging = useRef(false);
  const last = useRef({ x: 0, y: 0 });
  const yawRef = useRef(yaw);
  const pitchRef = useRef(pitch);
  yawRef.current = yaw;
  pitchRef.current = pitch;

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
      // Drag right → look right (increase yaw around +Y)
      const sens = 0.005;
      let ny = yawRef.current - dx * sens;
      let np = pitchRef.current - dy * sens;
      np = Math.max(-Math.PI / 2 + 0.05, Math.min(Math.PI / 2 - 0.05, np));
      setYaw(ny);
      setPitch(np);
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const cam = camera as THREE.PerspectiveCamera;
      cam.fov = Math.max(40, Math.min(100, cam.fov + e.deltaY * 0.04));
      cam.updateProjectionMatrix();
    };
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("wheel", onWheel);
    };
  }, [camera, gl, setPitch, setYaw]);

  useFrame(() => {
    // Yaw about world up, pitch about local right — apply look direction
    const cy = Math.cos(yawRef.current);
    const sy = Math.sin(yawRef.current);
    const cp = Math.cos(pitchRef.current);
    const sp = Math.sin(pitchRef.current);
    // Body: +Z three ≈ forward after body map; here sphere is world-aligned
    // Forward at yaw=0,pitch=0 → +Z (into image center after texture offset)
    const dir = new THREE.Vector3(sy * cp, sp, cy * cp);
    camera.position.set(0, 0, 0);
    camera.lookAt(dir);
    camera.up.set(0, 1, 0);
  });

  return null;
}

function LoadingFallback() {
  return (
    <mesh>
      <sphereGeometry args={[500, 32, 16]} />
      <meshBasicMaterial color="#1a2030" side={THREE.BackSide} />
    </mesh>
  );
}

export default function PhotoSphere({
  imageUrl,
  title,
  meta,
  downloadName,
  onClose,
  onFlat,
}: {
  imageUrl: string;
  title?: string;
  meta?: string;
  downloadName?: string;
  onClose: () => void;
  /** Switch to flat 2D pano view */
  onFlat?: () => void;
}) {
  const [yaw, setYaw] = useState(0);
  const [pitch, setPitch] = useState(0);
  const [downloading, setDownloading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Reset look when image changes
  useEffect(() => {
    setYaw(0);
    setPitch(0);
    setErr(null);
  }, [imageUrl]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      const step = 0.08;
      if (e.key === "ArrowLeft") setYaw((y) => y + step);
      if (e.key === "ArrowRight") setYaw((y) => y - step);
      if (e.key === "ArrowUp")
        setPitch((p) => Math.min(Math.PI / 2 - 0.05, p + step));
      if (e.key === "ArrowDown")
        setPitch((p) => Math.max(-Math.PI / 2 + 0.05, p - step));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function downloadPano() {
    setDownloading(true);
    try {
      const r = await fetch(imageUrl);
      if (!r.ok) throw new Error(`download failed: ${r.status}`);
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = downloadName || "photo_sphere.jpg";
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      window.open(imageUrl, "_blank", "noopener,noreferrer");
    } finally {
      setDownloading(false);
    }
  }

  const headingDeg = useMemo(() => {
    // yaw 0 = forward; positive yaw = left in our drag convention... 
    // dir uses sy for X so +yaw turns left → heading CW from forward
    let h = (-yaw * 180) / Math.PI;
    h = ((h % 360) + 360) % 360;
    return h;
  }, [yaw]);

  return (
    <div className="pano-view photo-sphere">
      <div className="pano-chrome top">
        <div>
          <strong>{title || "Photo sphere"}</strong>
          {meta && <span className="muted"> · {meta}</span>}
          <span className="muted">
            {" "}
            · heading {headingDeg.toFixed(0)}° · pitch{" "}
            {((pitch * 180) / Math.PI).toFixed(0)}°
          </span>
        </div>
        <div className="pano-actions">
          {onFlat && (
            <button type="button" onClick={onFlat}>
              Flat view
            </button>
          )}
          <button type="button" onClick={downloadPano} disabled={downloading}>
            {downloading ? "Saving…" : "Download JPEG"}
          </button>
          <button type="button" onClick={onClose}>
            Close (Esc)
          </button>
        </div>
      </div>
      <div className="pano-stage sphere-stage">
        {err ? (
          <div className="status-banner">{err}</div>
        ) : (
          <Canvas
            camera={{ fov: 75, near: 0.1, far: 2000, position: [0, 0, 0.01] }}
            gl={{ antialias: true }}
            onCreated={({ gl }) => {
              gl.setClearColor("#0a0c10");
            }}
          >
            <Suspense fallback={<LoadingFallback />}>
              <SphereMesh url={imageUrl} />
            </Suspense>
            <LookControls
              yaw={yaw}
              pitch={pitch}
              setYaw={setYaw}
              setPitch={setPitch}
            />
          </Canvas>
        )}
      </div>
      <div className="pano-chrome bottom muted">
        Drag to look · ←/→/↑/↓ · scroll = FOV · Esc close · Equirect sphere ·
        body-frame az 0 = forward
      </div>
    </div>
  );
}
