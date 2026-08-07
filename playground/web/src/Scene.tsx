import { useMemo, useRef } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls, Line, Html } from "@react-three/drei";
import * as THREE from "three";
import type { Camera } from "./api";

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

function colorFor(inst: string) {
  return INSTRUMENT_COLORS[inst] || INSTRUMENT_COLORS.DEFAULT;
}

function Cameras({
  cameras,
  selectedId,
  onSelect,
  showRays,
}: {
  cameras: Camera[];
  selectedId: string | null;
  onSelect: (c: Camera) => void;
  showRays: boolean;
}) {
  const positions = useMemo(() => {
    const arr = new Float32Array(cameras.length * 3);
    const colors = new Float32Array(cameras.length * 3);
    cameras.forEach((c, i) => {
      arr[i * 3] = c.pos_x ?? 0;
      arr[i * 3 + 1] = c.pos_z ?? 0; // map Z-up NASA-ish to Y-up three
      arr[i * 3 + 2] = c.pos_y ?? 0;
      const col = new THREE.Color(colorFor(c.instrument));
      colors[i * 3] = col.r;
      colors[i * 3 + 1] = col.g;
      colors[i * 3 + 2] = col.b;
    });
    return { arr, colors };
  }, [cameras]);

  const selected = cameras.find((c) => c.imageid === selectedId) || null;

  return (
    <group>
      <points
        onClick={(e) => {
          e.stopPropagation();
          // pick nearest by projecting is hard; use raycast index if available
          const idx = e.index;
          if (idx != null && cameras[idx]) onSelect(cameras[idx]);
        }}
      >
        <bufferGeometry>
          <bufferAttribute
            attach="attributes-position"
            args={[positions.arr, 3]}
          />
          <bufferAttribute
            attach="attributes-color"
            args={[positions.colors, 3]}
          />
        </bufferGeometry>
        <pointsMaterial size={0.04} vertexColors sizeAttenuation />
      </points>

      {showRays &&
        cameras.slice(0, 800).map((c) => {
          const ox = c.pos_x ?? 0;
          const oy = c.pos_z ?? 0;
          const oz = c.pos_y ?? 0;
          const lx = c.look_x ?? 0;
          const ly = c.look_z ?? 0;
          const lz = c.look_y ?? 0;
          const len = 0.35;
          const pts: [number, number, number][] = [
            [ox, oy, oz],
            [ox + lx * len, oy + ly * len, oz + lz * len],
          ];
          return (
            <Line
              key={c.imageid + "-ray"}
              points={pts}
              color={colorFor(c.instrument)}
              lineWidth={1}
              transparent
              opacity={0.35}
            />
          );
        })}

      {selected && selected.pos_x != null && (
        <SelectedFrustum camera={selected} />
      )}
    </group>
  );
}

function SelectedFrustum({ camera }: { camera: Camera }) {
  const ox = camera.pos_x ?? 0;
  const oy = camera.pos_z ?? 0;
  const oz = camera.pos_y ?? 0;
  const look = new THREE.Vector3(
    camera.look_x ?? 0,
    camera.look_z ?? 0,
    camera.look_y ?? 0
  ).normalize();
  const depth = 0.6;
  const hfov = ((camera.hfov_deg ?? 40) * Math.PI) / 180;
  const vfov = ((camera.vfov_deg ?? 30) * Math.PI) / 180;
  const hw = Math.tan(hfov / 2) * depth;
  const hh = Math.tan(vfov / 2) * depth;

  // build a simple local frame from look
  const up = new THREE.Vector3(0, 1, 0);
  let right = new THREE.Vector3().crossVectors(look, up);
  if (right.lengthSq() < 1e-6) {
    right = new THREE.Vector3().crossVectors(look, new THREE.Vector3(1, 0, 0));
  }
  right.normalize();
  const realUp = new THREE.Vector3().crossVectors(right, look).normalize();
  const origin = new THREE.Vector3(ox, oy, oz);
  const center = origin.clone().add(look.clone().multiplyScalar(depth));
  const corners = [
    center.clone().add(right.clone().multiplyScalar(hw)).add(realUp.clone().multiplyScalar(hh)),
    center.clone().add(right.clone().multiplyScalar(-hw)).add(realUp.clone().multiplyScalar(hh)),
    center.clone().add(right.clone().multiplyScalar(-hw)).add(realUp.clone().multiplyScalar(-hh)),
    center.clone().add(right.clone().multiplyScalar(hw)).add(realUp.clone().multiplyScalar(-hh)),
  ];

  const segs: [number, number, number][][] = [
    [origin.toArray() as [number, number, number], corners[0].toArray() as [number, number, number]],
    [origin.toArray() as [number, number, number], corners[1].toArray() as [number, number, number]],
    [origin.toArray() as [number, number, number], corners[2].toArray() as [number, number, number]],
    [origin.toArray() as [number, number, number], corners[3].toArray() as [number, number, number]],
    [corners[0].toArray() as [number, number, number], corners[1].toArray() as [number, number, number]],
    [corners[1].toArray() as [number, number, number], corners[2].toArray() as [number, number, number]],
    [corners[2].toArray() as [number, number, number], corners[3].toArray() as [number, number, number]],
    [corners[3].toArray() as [number, number, number], corners[0].toArray() as [number, number, number]],
  ];

  return (
    <group>
      {segs.map((pts, i) => (
        <Line key={i} points={pts} color="#e8a838" lineWidth={2} />
      ))}
      <mesh position={[ox, oy, oz]}>
        <sphereGeometry args={[0.03, 12, 12]} />
        <meshBasicMaterial color="#e8a838" />
      </mesh>
      <Html position={[ox, oy + 0.08, oz]} center>
        <div
          style={{
            background: "rgba(0,0,0,0.7)",
            color: "#fff",
            padding: "2px 6px",
            borderRadius: 4,
            fontSize: 11,
            whiteSpace: "nowrap",
          }}
        >
          {camera.instrument} · sol {camera.sol ?? "?"}
        </div>
      </Html>
    </group>
  );
}

function GroundGrid() {
  return (
    <>
      <gridHelper args={[20, 40, "#334155", "#1e293b"]} />
      <axesHelper args={[1]} />
    </>
  );
}

function AutoFrame({ cameras }: { cameras: Camera[] }) {
  const controls = useRef<any>(null);
  const done = useRef(false);
  useFrame(() => {
    if (done.current || !controls.current || cameras.length === 0) return;
    const box = new THREE.Box3();
    cameras.forEach((c) => {
      if (c.pos_x == null) return;
      box.expandByPoint(new THREE.Vector3(c.pos_x, c.pos_z ?? 0, c.pos_y ?? 0));
    });
    if (box.isEmpty()) return;
    const center = new THREE.Vector3();
    box.getCenter(center);
    const size = new THREE.Vector3();
    box.getSize(size);
    const dist = Math.max(size.length() * 1.2, 1.5);
    controls.current.target.copy(center);
    controls.current.object.position.set(center.x + dist * 0.6, center.y + dist * 0.5, center.z + dist * 0.6);
    controls.current.update();
    done.current = true;
  });
  // reset when camera set identity changes
  const key = cameras[0]?.stop_id + ":" + cameras.length;
  if ((AutoFrame as any)._key !== key) {
    (AutoFrame as any)._key = key;
    done.current = false;
  }
  return <OrbitControls ref={controls} makeDefault maxDistance={50} />;
}

export default function Scene({
  cameras,
  selectedId,
  onSelect,
  showRays,
}: {
  cameras: Camera[];
  selectedId: string | null;
  onSelect: (c: Camera) => void;
  showRays: boolean;
}) {
  return (
    <Canvas camera={{ position: [2, 2, 2], fov: 50, near: 0.01, far: 200 }}>
      <color attach="background" args={["#0b0f14"]} />
      <ambientLight intensity={0.6} />
      <directionalLight position={[5, 8, 3]} intensity={0.8} />
      <GroundGrid />
      <Cameras
        cameras={cameras}
        selectedId={selectedId}
        onSelect={onSelect}
        showRays={showRays}
      />
      <AutoFrame cameras={cameras} />
    </Canvas>
  );
}
