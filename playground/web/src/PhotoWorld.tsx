import { Component, ReactNode, Suspense, useEffect, useMemo } from "react";
import { useTexture } from "@react-three/drei";
import * as THREE from "three";
import type { Camera } from "./api";
import { thumbUrl } from "./api";
import {
  bodyCamQuatToThreeAligned as bodyCamQuat,
  bodyDirToThreeAligned as bodyDirToThree,
  bodyPosToThreeAligned as bodyPosToThree,
} from "./coords";

const toThree = bodyPosToThree;
const lookThree = bodyDirToThree;

/**
 * Pick a diverse subset of posed cameras to build a readable 3D photo world
 * without loading hundreds of textures.
 */
export function pickWorldCameras(cameras: Camera[], maxN = 40): Camera[] {
  const posed = cameras.filter(
    (c) => c.has_pose && c.pos_x != null && c.look_x != null
  );
  if (posed.length <= maxN) return posed;

  const rank = (inst: string) => {
    const u = inst.toUpperCase();
    if (u.includes("NAVCAM")) return 0;
    if (u.includes("MCZ") || u.includes("MASTCAM")) return 1;
    if (u.includes("HAZCAM")) return 2;
    if (u.includes("SUPERCAM")) return 3;
    return 4;
  };

  const sorted = [...posed].sort((a, b) => {
    const ra = rank(a.instrument || "");
    const rb = rank(b.instrument || "");
    if (ra !== rb) return ra - rb;
    const sa = a.sol ?? 0;
    const sb = b.sol ?? 0;
    if (sa !== sb) return sa - sb;
    return String(a.imageid).localeCompare(String(b.imageid));
  });

  // Greedy angular diversity on look vectors in Three space
  const picked: Camera[] = [];
  const looks: THREE.Vector3[] = [];
  const minDot = 0.92; // reject near-duplicates first pass

  for (const c of sorted) {
    if (picked.length >= maxN) break;
    const look = lookThree(c);
    let ok = true;
    for (const L of looks) {
      if (look.dot(L) > minDot) {
        ok = false;
        break;
      }
    }
    if (ok) {
      picked.push(c);
      looks.push(look);
    }
  }

  // Fill remaining slots by stride through leftover
  if (picked.length < maxN) {
    const have = new Set(picked.map((c) => c.imageid));
    for (const c of sorted) {
      if (picked.length >= maxN) break;
      if (have.has(c.imageid)) continue;
      picked.push(c);
      have.add(c.imageid);
    }
  }
  return picked;
}

function PhotoBillboard({
  cam,
  selected,
  dist,
  onSelect,
}: {
  cam: Camera;
  selected: boolean;
  dist: number;
  onSelect: (c: Camera) => void;
}) {
  const url = thumbUrl(cam.imageid, "small");
  const texture = useTexture(url);
  useEffect(() => {
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.needsUpdate = true;
  }, [texture]);

  const { center, quat, width, height } = useMemo(() => {
    const origin = toThree(cam);
    const look = lookThree(cam);
    const hfov = ((cam.hfov_deg ?? 45) * Math.PI) / 180;
    const vfov = ((cam.vfov_deg ?? 34) * Math.PI) / 180;
    const width = 2 * dist * Math.tan(hfov / 2);
    const height = 2 * dist * Math.tan(vfov / 2);
    // Full CAHVOR/attitude basis (roll included)
    const quat = bodyCamQuat(cam);
    const center = origin.clone().add(look.clone().multiplyScalar(dist));
    return { center, quat, width, height };
  }, [cam, dist]);

  return (
    <group position={center} quaternion={quat}>
      <mesh
        onClick={(e) => {
          e.stopPropagation();
          onSelect(cam);
        }}
        onPointerOver={(e) => {
          e.stopPropagation();
          document.body.style.cursor = "pointer";
        }}
        onPointerOut={() => {
          document.body.style.cursor = "default";
        }}
      >
        <planeGeometry args={[width, height]} />
        <meshBasicMaterial
          map={texture}
          side={THREE.DoubleSide}
          toneMapped={false}
          transparent
          opacity={selected ? 1 : 0.88}
          depthWrite
        />
      </mesh>
      {/* thin frame */}
      <lineSegments>
        <edgesGeometry
          args={[new THREE.PlaneGeometry(width, height)]}
        />
        <lineBasicMaterial
          color={selected ? "#e8a838" : "#94a3b8"}
          transparent
          opacity={selected ? 0.95 : 0.35}
        />
      </lineSegments>
    </group>
  );
}

class PlaneCatch extends Component<
  { children: ReactNode },
  { err: boolean }
> {
  state = { err: false };
  static getDerivedStateFromError() {
    return { err: true };
  }
  render() {
    if (this.state.err) return null;
    return this.props.children;
  }
}

/**
 * 3D photo world: FOV-matched image planes at true body-frame poses for a site/stop.
 */
export default function PhotoWorld({
  cameras,
  selectedId,
  onSelect,
  maxPlanes = 40,
  planeDist = 1.1,
  enabled = true,
}: {
  cameras: Camera[];
  selectedId: string | null;
  onSelect: (c: Camera) => void;
  maxPlanes?: number;
  planeDist?: number;
  enabled?: boolean;
}) {
  const subset = useMemo(
    () => (enabled ? pickWorldCameras(cameras, maxPlanes) : []),
    [cameras, maxPlanes, enabled]
  );

  if (!enabled || subset.length === 0) return null;

  return (
    <group name="photo-world">
      {subset.map((c) => (
        <Suspense key={c.imageid} fallback={null}>
          <PlaneCatch>
            <PhotoBillboard
              cam={c}
              selected={c.imageid === selectedId}
              dist={planeDist}
              onSelect={onSelect}
            />
          </PlaneCatch>
        </Suspense>
      ))}
    </group>
  );
}
