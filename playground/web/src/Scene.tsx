import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Canvas, ThreeEvent, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls, Line, Html } from "@react-three/drei";
import * as THREE from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import type { Camera } from "./api";
import RoverModel from "./RoverModel";
import PhotoWorld from "./PhotoWorld";
import PointCloud, { type BodyPointCloud } from "./PointCloud";
import {
  bodyDirToThreeAligned as bodyDirToThree,
  bodyPosToThreeAligned as bodyPosToThree,
  bodyRightToThreeAligned as bodyRightToThree,
  bodyUpToThreeAligned as bodyUpToThree,
} from "./coords";

const INSTRUMENT_COLORS: Record<string, string> = {
  NAVCAM_LEFT: "#4fc3f7",
  NAVCAM_RIGHT: "#29b6f6",
  MCZ_LEFT: "#ffb74d",
  MCZ_RIGHT: "#ffa726",
  FRONT_HAZCAM_LEFT_A: "#81c784",
  FRONT_HAZCAM_RIGHT_A: "#66bb6a",
  REAR_HAZCAM_LEFT: "#aed581",
  REAR_HAZCAM_RIGHT: "#9ccc65",
  SUPERCAM_RMI: "#ce93d8",
  SHERLOC_WATSON: "#f48fb1",
  DEFAULT: "#b0bec5",
};

const toThree = bodyPosToThree;
const lookThree = bodyDirToThree;

function colorFor(inst: string) {
  return INSTRUMENT_COLORS[inst] || INSTRUMENT_COLORS.DEFAULT;
}

function RaycasterTuning() {
  const { raycaster } = useThree();
  useEffect(() => {
    raycaster.params.Points = { threshold: 0.12 };
  }, [raycaster]);
  return null;
}

function Cameras({
  cameras,
  selectedId,
  hoveredId,
  pairIds,
  pairBaseline,
  onSelect,
  onHover,
  showRays,
  showFrustums,
}: {
  cameras: Camera[];
  selectedId: string | null;
  hoveredId: string | null;
  pairIds: Set<string>;
  pairBaseline: [[number, number, number], [number, number, number]] | null;
  onSelect: (c: Camera) => void;
  onHover: (c: Camera | null) => void;
  showRays: boolean;
  showFrustums: boolean;
}) {
  const positions = useMemo(() => {
    const arr = new Float32Array(cameras.length * 3);
    const colors = new Float32Array(cameras.length * 3);
    cameras.forEach((c, i) => {
      const p = toThree(c);
      arr[i * 3] = p.x;
      arr[i * 3 + 1] = p.y;
      arr[i * 3 + 2] = p.z;
      const isSel = c.imageid === selectedId;
      const isPair = pairIds.has(c.imageid);
      const isHov = c.imageid === hoveredId;
      const col = new THREE.Color(
        isSel
          ? "#e8a838"
          : isPair
            ? "#4db6ac"
            : isHov
              ? "#ffffff"
              : colorFor(c.instrument)
      );
      colors[i * 3] = col.r;
      colors[i * 3 + 1] = col.g;
      colors[i * 3 + 2] = col.b;
    });
    return { arr, colors };
  }, [cameras, selectedId, hoveredId, pairIds]);

  const selected = cameras.find((c) => c.imageid === selectedId) || null;
  const pairCams = cameras.filter((c) => pairIds.has(c.imageid));

  const rayCams = useMemo(() => {
    if (!showRays) return [] as Camera[];
    if (cameras.length <= 600) return cameras;
    const step = Math.ceil(cameras.length / 600);
    return cameras.filter((_, i) => i % step === 0);
  }, [cameras, showRays]);

  const onPointsClick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    const idx = e.index;
    if (idx != null && cameras[idx]) onSelect(cameras[idx]);
  };

  const onPointsMove = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    const idx = e.index;
    if (idx != null && cameras[idx]) onHover(cameras[idx]);
  };

  return (
    <group>
      <points
        onClick={onPointsClick}
        onPointerMove={onPointsMove}
        onPointerOut={() => onHover(null)}
      >
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[positions.arr, 3]} />
          <bufferAttribute attach="attributes-color" args={[positions.colors, 3]} />
        </bufferGeometry>
        <pointsMaterial size={0.05} vertexColors sizeAttenuation depthWrite={false} />
      </points>

      {rayCams.map((c) => {
        const o = toThree(c);
        const look = lookThree(c);
        const len = 0.4;
        const pts: [number, number, number][] = [
          [o.x, o.y, o.z],
          [o.x + look.x * len, o.y + look.y * len, o.z + look.z * len],
        ];
        return (
          <Line
            key={c.imageid + "-ray"}
            points={pts}
            color={colorFor(c.instrument)}
            lineWidth={1}
            transparent
            opacity={c.imageid === selectedId ? 0.9 : 0.28}
          />
        );
      })}

      {selected && selected.pos_x != null && (
        <SelectedFrustum camera={selected} emphasis />
      )}
      {pairCams.map((c) =>
        c.imageid !== selectedId && c.pos_x != null ? (
          <SelectedFrustum key={c.imageid + "-pair-f"} camera={c} emphasis color="#4db6ac" />
        ) : null
      )}
      {pairBaseline && (
        <Line
          points={pairBaseline}
          color="#4db6ac"
          lineWidth={3}
          transparent
          opacity={0.95}
        />
      )}
      {showFrustums &&
        cameras
          .filter(
            (c) =>
              c.imageid !== selectedId &&
              !pairIds.has(c.imageid) &&
              c.pos_x != null
          )
          .slice(0, 36)
          .map((c) => (
            <SelectedFrustum key={c.imageid + "-f"} camera={c} emphasis={false} />
          ))}

      {hoveredId &&
        hoveredId !== selectedId &&
        (() => {
          const h = cameras.find((c) => c.imageid === hoveredId);
          return h && h.pos_x != null ? <HoverLabel camera={h} /> : null;
        })()}
    </group>
  );
}

function HoverLabel({ camera }: { camera: Camera }) {
  const p = toThree(camera);
  return (
    <Html position={[p.x, p.y + 0.06, p.z]} center style={{ pointerEvents: "none" }}>
      <div className="scene-label">
        {camera.instrument} · sol {camera.sol ?? "?"}
      </div>
    </Html>
  );
}

function SelectedFrustum({
  camera,
  emphasis,
  color: colorOverride,
}: {
  camera: Camera;
  emphasis: boolean;
  color?: string;
}) {
  const origin = toThree(camera);
  const look = lookThree(camera);
  const depth = emphasis ? 0.75 : 0.35;
  const hfov = ((camera.hfov_deg ?? 40) * Math.PI) / 180;
  const vfov = ((camera.vfov_deg ?? 30) * Math.PI) / 180;
  const hw = Math.tan(hfov / 2) * depth;
  const hh = Math.tan(vfov / 2) * depth;

  // Full orientation from CAHVOR H/V + attitude-refined up
  let right = bodyRightToThree(camera);
  let realUp = bodyUpToThree(camera);
  right = new THREE.Vector3().crossVectors(look, realUp);
  if (right.lengthSq() < 1e-8) {
    right = new THREE.Vector3().crossVectors(look, new THREE.Vector3(0, 1, 0));
  }
  right.normalize();
  realUp = new THREE.Vector3().crossVectors(right, look).normalize();
  const center = origin.clone().add(look.clone().multiplyScalar(depth));
  const corners = [
    center.clone().addScaledVector(right, hw).addScaledVector(realUp, hh),
    center.clone().addScaledVector(right, -hw).addScaledVector(realUp, hh),
    center.clone().addScaledVector(right, -hw).addScaledVector(realUp, -hh),
    center.clone().addScaledVector(right, hw).addScaledVector(realUp, -hh),
  ];

  const o = origin.toArray() as [number, number, number];
  const segs: [number, number, number][][] = [
    [o, corners[0].toArray() as [number, number, number]],
    [o, corners[1].toArray() as [number, number, number]],
    [o, corners[2].toArray() as [number, number, number]],
    [o, corners[3].toArray() as [number, number, number]],
    [
      corners[0].toArray() as [number, number, number],
      corners[1].toArray() as [number, number, number],
    ],
    [
      corners[1].toArray() as [number, number, number],
      corners[2].toArray() as [number, number, number],
    ],
    [
      corners[2].toArray() as [number, number, number],
      corners[3].toArray() as [number, number, number],
    ],
    [
      corners[3].toArray() as [number, number, number],
      corners[0].toArray() as [number, number, number],
    ],
  ];

  const color =
    colorOverride || (emphasis ? "#e8a838" : colorFor(camera.instrument));
  const opacity = emphasis || colorOverride ? 1 : 0.22;

  return (
    <group>
      {segs.map((pts, i) => (
        <Line
          key={i}
          points={pts}
          color={color}
          lineWidth={emphasis || colorOverride ? 2 : 1}
          transparent
          opacity={opacity}
        />
      ))}
      {(emphasis || colorOverride) && (
        <>
          <mesh position={origin}>
            <sphereGeometry args={[0.035, 16, 16]} />
            <meshBasicMaterial color={color} />
          </mesh>
          {emphasis && (
            <Html position={[origin.x, origin.y + 0.1, origin.z]} center>
              <div className="scene-label scene-label-active">
                {camera.instrument} · sol {camera.sol ?? "?"}
              </div>
            </Html>
          )}
        </>
      )}
    </group>
  );
}

function GroundGrid() {
  return (
    <>
      <gridHelper args={[30, 60, "#334155", "#1e293b"]} />
      <axesHelper args={[1.2]} />
    </>
  );
}

function CameraController({
  cameras,
  flyTo,
  flyToken,
  frameToken,
}: {
  cameras: Camera[];
  flyTo: Camera | null;
  flyToken: number;
  frameToken: string;
}) {
  const controls = useRef<OrbitControlsImpl>(null);
  const framedFor = useRef<string>("");
  const anim = useRef<{
    t: number;
    fromPos: THREE.Vector3;
    toPos: THREE.Vector3;
    fromTarget: THREE.Vector3;
    toTarget: THREE.Vector3;
  } | null>(null);
  // Queue fly in a ref so React StrictMode double-effects still animate once
  const pendingFly = useRef<{ token: number; cam: Camera } | null>(null);
  const startedToken = useRef(0);

  useEffect(() => {
    if (!controls.current || cameras.length === 0) return;
    if (framedFor.current === frameToken) return;
    framedFor.current = frameToken;

    const box = new THREE.Box3();
    cameras.forEach((c) => {
      if (c.pos_x == null) return;
      box.expandByPoint(toThree(c));
    });
    if (box.isEmpty()) return;
    const center = new THREE.Vector3();
    const size = new THREE.Vector3();
    box.getCenter(center);
    box.getSize(size);
    const dist = Math.max(size.length() * 1.15, 1.8);
    const cam = controls.current.object;
    cam.position.set(
      center.x + dist * 0.55,
      center.y + dist * 0.45,
      center.z + dist * 0.55
    );
    controls.current.target.copy(center);
    controls.current.update();
  }, [cameras, frameToken]);

  useEffect(() => {
    // Intended: move the orbit camera behind the selected rover camera and
    // look along its look vector (so you see the photo plane / frustum head-on).
    if (!flyTo || flyToken <= 0) return;
    if (flyTo.pos_x == null) return;
    pendingFly.current = { token: flyToken, cam: flyTo };
  }, [flyTo, flyToken]);

  useFrame((_, dt) => {
    const ctl = controls.current;
    if (!ctl) return;

    // Start a queued fly as soon as OrbitControls exists
    const pending = pendingFly.current;
    if (pending && pending.token !== startedToken.current) {
      startedToken.current = pending.token;
      pendingFly.current = null;

      const target = toThree(pending.cam);
      const look = lookThree(pending.cam);
      // Stand behind the camera, slightly above, looking past the origin along look
      const back = look.clone().multiplyScalar(-2.2);
      const toPos = target
        .clone()
        .add(back)
        .add(new THREE.Vector3(0, 0.7, 0));
      const toTarget = target.clone().add(look.clone().multiplyScalar(1.2));

      anim.current = {
        t: 0,
        fromPos: ctl.object.position.clone(),
        toPos,
        fromTarget: ctl.target.clone(),
        toTarget,
      };
    }

    if (!anim.current) return;
    anim.current.t = Math.min(1, anim.current.t + dt * 1.4);
    const t = 1 - Math.pow(1 - anim.current.t, 3);
    ctl.object.position.lerpVectors(
      anim.current.fromPos,
      anim.current.toPos,
      t
    );
    ctl.target.lerpVectors(
      anim.current.fromTarget,
      anim.current.toTarget,
      t
    );
    ctl.update();
    if (anim.current.t >= 1) anim.current = null;
  });

  return (
    <OrbitControls
      ref={controls}
      makeDefault
      maxDistance={80}
      minDistance={0.05}
      enableDamping
      dampingFactor={0.08}
    />
  );
}

export default function Scene({
  cameras,
  selectedId,
  onSelect,
  showRays,
  showFrustums,
  flyTo,
  flyToken,
  frameToken,
  pairIds,
  pairBaseline,
  showRover = true,
  showPhotoWorld = true,
  photoWorldMax = 40,
  pointCloud = null,
  showPointCloud = true,
}: {
  cameras: Camera[];
  selectedId: string | null;
  onSelect: (c: Camera) => void;
  showRays: boolean;
  showFrustums: boolean;
  flyTo: Camera | null;
  flyToken: number;
  frameToken: string;
  pairIds?: Set<string>;
  pairBaseline?: [[number, number, number], [number, number, number]] | null;
  /** Unused in stop view: cameras are body-frame, not map-yawed. */
  roverYawDeg?: number | null;
  showRover?: boolean;
  /** Place FOV-matched image planes at each camera pose (site photo world). */
  showPhotoWorld?: boolean;
  photoWorldMax?: number;
  /** Stereo body-frame cloud from selected L/R pair. */
  pointCloud?: BodyPointCloud | null;
  showPointCloud?: boolean;
}) {
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const pairSet = pairIds ?? new Set<string>();

  // Camera poses share the GLB authoring frame (meters). Rover stays at origin.
  const roverPos: [number, number, number] = [0, 0, 0];

  // When photo world is on, dial back dense rays so the images read clearly
  const raysOn = showRays && !showPhotoWorld;

  return (
    <Canvas
      camera={{ position: [3.5, 2.2, 4], fov: 50, near: 0.01, far: 300 }}
      onPointerMissed={() => setHoveredId(null)}
    >
      <color attach="background" args={["#0b0f14"]} />
      <ambientLight intensity={0.75} />
      <directionalLight position={[5, 8, 3]} intensity={0.85} />
      <hemisphereLight args={["#c5d4e8", "#4a3728", 0.35]} />
      <RaycasterTuning />
      <GroundGrid />
      <axesHelper args={[1.5]} />
      {showRover && (
        <Suspense fallback={null}>
          <RoverModel
            position={roverPos}
            yawDeg={0}
            frame="body"
            ground
          />
        </Suspense>
      )}
      <PhotoWorld
        cameras={cameras}
        selectedId={selectedId}
        onSelect={onSelect}
        enabled={showPhotoWorld}
        maxPlanes={photoWorldMax}
      />
      <PointCloud cloud={pointCloud} visible={showPointCloud} />
      <Cameras
        cameras={cameras}
        selectedId={selectedId}
        hoveredId={hoveredId}
        pairIds={pairSet}
        pairBaseline={pairBaseline ?? null}
        onSelect={onSelect}
        onHover={(c) => setHoveredId(c?.imageid ?? null)}
        showRays={raysOn}
        showFrustums={showFrustums}
      />
      <CameraController
        cameras={cameras}
        flyTo={flyTo}
        flyToken={flyToken}
        frameToken={frameToken}
      />
    </Canvas>
  );
}
