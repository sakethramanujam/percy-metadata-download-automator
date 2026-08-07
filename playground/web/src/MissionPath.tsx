import { useMemo, useRef, useEffect } from "react";
import { Canvas, ThreeEvent, useFrame } from "@react-three/fiber";
import { OrbitControls, Line, Html } from "@react-three/drei";
import * as THREE from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import type { Stop } from "./api";

export type PathNode = {
  stop: Stop;
  position: [number, number, number];
  radius: number;
};

/** Layout stops along a mission strip by sol (schematic — not map coordinates). */
export function layoutMissionPath(stops: Stop[]): PathNode[] {
  if (!stops.length) return [];
  const ordered = [...stops].sort((a, b) => {
    const sa = a.sol_min ?? 1e9;
    const sb = b.sol_min ?? 1e9;
    if (sa !== sb) return sa - sb;
    return (a.site ?? 0) - (b.site ?? 0) || (a.drive ?? 0) - (b.drive ?? 0);
  });

  const sols = ordered.map((s) => s.sol_min ?? 0);
  const s0 = Math.min(...sols);
  const s1 = Math.max(...sols);
  const span = Math.max(s1 - s0, 1);
  const maxPosed = Math.max(1, ...ordered.map((s) => s.n_posed || 1));

  // Total path length scales with count so dense missions stay navigable
  const length = Math.max(ordered.length * 0.55, 8);

  return ordered.map((stop, i) => {
    const sol = stop.sol_min ?? s0;
    // Mix index + sol so long dwells don't collapse nodes
    const u = 0.55 * (i / Math.max(ordered.length - 1, 1)) + 0.45 * ((sol - s0) / span);
    const x = (u - 0.5) * length;
    // Lateral wobble by site id so site changes are visible
    const z = ((stop.site ?? 0) % 7) * 0.35 - 1.0;
    const y = Math.log10(1 + (stop.n_posed || 0)) * 0.15;
    const radius = 0.08 + 0.22 * Math.sqrt((stop.n_posed || 0) / maxPosed);
    return {
      stop,
      position: [x, y, z],
      radius,
    };
  });
}

function PathNodes({
  nodes,
  selectedId,
  onSelect,
}: {
  nodes: PathNode[];
  selectedId: string | null;
  onSelect: (stop: Stop) => void;
}) {
  return (
    <group>
      {nodes.map((n) => {
        const active = n.stop.stop_id === selectedId;
        const color = active ? "#e8a838" : "#4db6ac";
        return (
          <group key={n.stop.stop_id} position={n.position}>
            <mesh
              onClick={(e: ThreeEvent<MouseEvent>) => {
                e.stopPropagation();
                onSelect(n.stop);
              }}
              onPointerOver={(e) => {
                e.stopPropagation();
                document.body.style.cursor = "pointer";
              }}
              onPointerOut={() => {
                document.body.style.cursor = "default";
              }}
            >
              <sphereGeometry args={[n.radius, 20, 20]} />
              <meshStandardMaterial
                color={color}
                emissive={color}
                emissiveIntensity={active ? 0.45 : 0.15}
                metalness={0.2}
                roughness={0.45}
              />
            </mesh>
            <Html position={[0, n.radius + 0.12, 0]} center style={{ pointerEvents: "none" }}>
              <div className={"path3d-label" + (active ? " active" : "")}>
                <strong>sol {n.stop.sol_min ?? "?"}</strong>
                <span>
                  {n.stop.site}/{n.stop.drive}
                </span>
                <span className="muted">{n.stop.n_posed} posed</span>
              </div>
            </Html>
          </group>
        );
      })}
    </group>
  );
}

function PathLine({ nodes }: { nodes: PathNode[] }) {
  const points = useMemo(
    () => nodes.map((n) => n.position as [number, number, number]),
    [nodes]
  );
  if (points.length < 2) return null;
  return <Line points={points} color="#64748b" lineWidth={2} transparent opacity={0.85} />;
}

function FramePath({ nodes }: { nodes: PathNode[] }) {
  const controls = useRef<OrbitControlsImpl>(null);
  const done = useRef(false);

  useEffect(() => {
    done.current = false;
  }, [nodes.length]);

  useFrame(() => {
    if (done.current || !controls.current || nodes.length === 0) return;
    const box = new THREE.Box3();
    nodes.forEach((n) => box.expandByPoint(new THREE.Vector3(...n.position)));
    const center = new THREE.Vector3();
    const size = new THREE.Vector3();
    box.getCenter(center);
    box.getSize(size);
    const dist = Math.max(size.length() * 0.9, 6);
    controls.current.target.copy(center);
    controls.current.object.position.set(
      center.x,
      center.y + dist * 0.55,
      center.z + dist * 0.75
    );
    controls.current.update();
    done.current = true;
  });

  return (
    <OrbitControls
      ref={controls}
      makeDefault
      enableDamping
      maxDistance={120}
      minDistance={1}
    />
  );
}

export default function MissionPath({
  stops,
  selectedStopId,
  onSelectStop,
}: {
  stops: Stop[];
  selectedStopId: string | null;
  onSelectStop: (stop: Stop) => void;
}) {
  const nodes = useMemo(() => layoutMissionPath(stops), [stops]);
  const nSites = useMemo(
    () => new Set(stops.map((s) => s.site)).size,
    [stops]
  );

  return (
    <div className="mission-path-wrap">
      <Canvas camera={{ position: [0, 8, 12], fov: 50, near: 0.1, far: 500 }}>
        <color attach="background" args={["#0b0f14"]} />
        <ambientLight intensity={0.55} />
        <directionalLight position={[8, 14, 6]} intensity={0.9} />
        <gridHelper args={[80, 40, "#334155", "#1e293b"]} />
        <Html position={[0, 0.02, nodes.length ? nodes[0].position[2] - 2 : -3]} center>
          <div className="path3d-axis-label">
            early sols ← schematic mission path (not map coords) → later sols
          </div>
        </Html>
        <PathLine nodes={nodes} />
        <PathNodes
          nodes={nodes}
          selectedId={selectedStopId}
          onSelect={onSelectStop}
        />
        <FramePath nodes={nodes} />
      </Canvas>
      <div className="hud mission-hud">
        <strong>Mission path</strong> · {nodes.length} stops · {nSites} sites
        <div className="muted">
          Schematic layout by sol (not map coordinates). Click a node to open local
          camera cloud.
        </div>
      </div>
    </div>
  );
}
