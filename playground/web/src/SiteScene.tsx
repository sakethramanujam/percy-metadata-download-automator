import { Suspense, useMemo, useState } from "react";
import { Canvas } from "@react-three/fiber";
import { OrbitControls, Line, Html } from "@react-three/drei";
import * as THREE from "three";
import type { Camera } from "./api";
import type { SiteDrive } from "./api";
import RoverModel from "./RoverModel";
import PhotoWorld from "./PhotoWorld";
import {
  camerasToSiteFrame,
  drivePosToSite,
  pickSiteWorldCameras,
  type SiteOrigin,
} from "./siteFrame";
import {
  bodyDirToThreeAligned as bodyDirToThree,
  bodyPosToThreeAligned as bodyPosToThree,
} from "./coords";

/**
 * Site-scale multi-drive photo world.
 * Places each drive's body-frame cameras into shared EN site meters
 * (X east, Y up, Z −north) using MMGIS anchors.
 */
export default function SiteScene({
  site,
  drives,
  cameras,
  originEasting,
  originNorthing,
  selectedId,
  focusDrive,
  onSelect,
  showPhotoWorld = true,
  maxPlanes = 60,
  showRays = false,
}: {
  site: number;
  drives: SiteDrive[];
  cameras: Camera[];
  originEasting: number | null;
  originNorthing: number | null;
  selectedId: string | null;
  focusDrive?: number | null;
  onSelect: (c: Camera) => void;
  showPhotoWorld?: boolean;
  maxPlanes?: number;
  showRays?: boolean;
}) {
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  const origin: SiteOrigin | null =
    originEasting != null && originNorthing != null
      ? { easting: originEasting, northing: originNorthing }
      : null;

  const siteCams = useMemo(
    () => camerasToSiteFrame(cameras, originEasting, originNorthing),
    [cameras, originEasting, originNorthing]
  );

  const worldCams = useMemo(
    () => pickSiteWorldCameras(siteCams, Math.max(maxPlanes * 2, 80)),
    [siteCams, maxPlanes]
  );

  const pathPts = useMemo(() => {
    if (!origin) return [] as [number, number, number][];
    const mapped = drives
      .filter((d) => d.easting != null && d.northing != null)
      .sort((a, b) => (a.sol_min ?? 0) - (b.sol_min ?? 0));
    return mapped.map((d) => {
      const p = drivePosToSite(d.easting as number, d.northing as number, origin);
      return [p.x, 0.05, p.z] as [number, number, number];
    });
  }, [drives, origin]);

  // Framing distance from origin to farthest drive
  const span = useMemo(() => {
    if (!pathPts.length) return 8;
    let m = 4;
    for (const p of pathPts) {
      m = Math.max(m, Math.hypot(p[0], p[2]));
    }
    return m;
  }, [pathPts]);

  const camDist = Math.min(80, Math.max(12, span * 1.6));

  return (
    <Canvas
      camera={{
        position: [camDist * 0.55, camDist * 0.45, camDist * 0.55],
        fov: 50,
        near: 0.1,
        far: 5000,
      }}
    >
      <color attach="background" args={["#0a1018"]} />
      <ambientLight intensity={0.8} />
      <directionalLight position={[20, 40, 10]} intensity={0.9} />
      <hemisphereLight args={["#c5d4e8", "#3d2918", 0.4]} />
      <gridHelper args={[Math.max(40, span * 3), 40, "#1e3a4a", "#12202a"]} />
      <axesHelper args={[5]} />

      {/* Local traverse polyline */}
      {pathPts.length > 1 && (
        <Line points={pathPts} color="#f0c040" lineWidth={2} transparent opacity={0.85} />
      )}

      {/* Drive markers + small rovers */}
      {origin &&
        drives.map((d) => {
          if (d.easting == null || d.northing == null || d.drive == null) return null;
          const p = drivePosToSite(d.easting, d.northing, origin);
          const active = focusDrive != null && d.drive === focusDrive;
          return (
            <group key={`drive-${d.drive}`} position={[p.x, 0, p.z]}>
              <mesh position={[0, 0.08, 0]}>
                <sphereGeometry args={[active ? 0.35 : 0.22, 12, 12]} />
                <meshStandardMaterial
                  color={active ? "#e8a838" : "#4db6ac"}
                  emissive={active ? "#a07020" : "#1a4a44"}
                  emissiveIntensity={0.4}
                />
              </mesh>
              <Suspense fallback={null}>
                <RoverModel
                  position={[0, 0, 0]}
                  yawDeg={d.yaw_deg}
                  frame="map"
                  targetLength={active ? 1.4 : 0.9}
                  ground
                />
              </Suspense>
              <Html position={[0, 1.2, 0]} center style={{ pointerEvents: "none" }}>
                <div className="scene-label">
                  {site}/{d.drive}
                  {d.sol_min != null ? ` · sol ${d.sol_min}` : ""}
                </div>
              </Html>
            </group>
          );
        })}

      <PhotoWorld
        cameras={worldCams}
        selectedId={selectedId}
        onSelect={onSelect}
        enabled={showPhotoWorld}
        maxPlanes={maxPlanes}
        planeDist={1.4}
      />

      {showRays &&
        worldCams.slice(0, 80).map((c) => {
          const o = bodyPosToThree(c);
          const look = bodyDirToThree(c);
          const len = 2.5;
          return (
            <Line
              key={c.imageid + "-sr"}
              points={[
                [o.x, o.y, o.z],
                [o.x + look.x * len, o.y + look.y * len, o.z + look.z * len],
              ]}
              color={c.imageid === selectedId ? "#e8a838" : "#5a7a8a"}
              lineWidth={1}
              transparent
              opacity={c.imageid === selectedId ? 0.9 : 0.25}
            />
          );
        })}

      {/* Camera centers as points */}
      <SiteCameraPoints
        cameras={worldCams}
        selectedId={selectedId}
        hoveredId={hoveredId}
        onSelect={onSelect}
        onHover={setHoveredId}
      />

      <OrbitControls
        makeDefault
        maxPolarAngle={Math.PI * 0.49}
        minDistance={2}
        maxDistance={Math.max(200, span * 8)}
        target={[0, 0.5, 0]}
      />
    </Canvas>
  );
}

function SiteCameraPoints({
  cameras,
  selectedId,
  hoveredId,
  onSelect,
  onHover,
}: {
  cameras: Camera[];
  selectedId: string | null;
  hoveredId: string | null;
  onSelect: (c: Camera) => void;
  onHover: (id: string | null) => void;
}) {
  const { arr, colors } = useMemo(() => {
    const arr = new Float32Array(cameras.length * 3);
    const colors = new Float32Array(cameras.length * 3);
    cameras.forEach((c, i) => {
      const p = bodyPosToThree(c);
      arr[i * 3] = p.x;
      arr[i * 3 + 1] = p.y;
      arr[i * 3 + 2] = p.z;
      const col = new THREE.Color(
        c.imageid === selectedId
          ? "#e8a838"
          : c.imageid === hoveredId
            ? "#ffffff"
            : "#7eb8d4"
      );
      colors[i * 3] = col.r;
      colors[i * 3 + 1] = col.g;
      colors[i * 3 + 2] = col.b;
    });
    return { arr, colors };
  }, [cameras, selectedId, hoveredId]);

  return (
    <points
      onClick={(e) => {
        e.stopPropagation();
        const idx = e.index;
        if (idx != null && cameras[idx]) onSelect(cameras[idx]);
      }}
      onPointerMove={(e) => {
        e.stopPropagation();
        const idx = e.index;
        if (idx != null && cameras[idx]) onHover(cameras[idx].imageid);
      }}
      onPointerOut={() => onHover(null)}
    >
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[arr, 3]} />
        <bufferAttribute attach="attributes-color" args={[colors, 3]} />
      </bufferGeometry>
      <pointsMaterial size={0.12} vertexColors sizeAttenuation depthWrite={false} />
    </points>
  );
}
