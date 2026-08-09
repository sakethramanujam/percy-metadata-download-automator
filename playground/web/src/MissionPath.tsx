import { Suspense, useMemo, useRef, useEffect } from "react";
import { Canvas, ThreeEvent, useFrame } from "@react-three/fiber";
import { OrbitControls, Line } from "@react-three/drei";
import * as THREE from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import type { MapWaypoint, Stop } from "./api";
import RoverModel from "./RoverModel";
import Terrain from "./Terrain";

export type PathNode = {
  id: string;
  stop: Stop | null;
  site: number | null;
  drive: number | null;
  sol: number | null;
  position: [number, number, number];
  radius: number;
  hasImages: boolean;
  yawDeg: number | null;
  distTotalM: number | null;
  label: string;
};

/** Path sits just above the flat basemap (y=0) to avoid z-fighting. */
export const MAP_SURFACE_Y = 0;
export const MAP_PATH_Y = 0.04;

function scaleEn(
  easting: number,
  northing: number,
  _elev: number | null | undefined,
  originE: number,
  originN: number,
  metersPerUnit: number,
  /** Flatten onto basemap plane (default). Elev would float the path above the orthophoto. */
  flat = true
): [number, number, number] {
  // X = east, Z = -north (so +Z is south-ish; orbit feels natural)
  const x = (easting - originE) / metersPerUnit;
  const z = -(northing - originN) / metersPerUnit;
  if (flat) return [x, MAP_PATH_Y, z];
  const y =
    _elev != null && _elev > -9000 ? (_elev + 2500) / metersPerUnit : MAP_PATH_Y;
  return [x, y, z];
}

/** Real map layout from MMGIS easting/northing (preferred). */
export function layoutFromWaypoints(
  waypoints: MapWaypoint[],
  stopsByKey: Map<string, Stop>,
  metersPerUnit = 25
): PathNode[] {
  if (!waypoints.length) return [];
  const usable = waypoints.filter(
    (w) => w.easting != null && w.northing != null
  );
  if (!usable.length) return [];

  const originE = usable.reduce((s, w) => s + (w.easting as number), 0) / usable.length;
  const originN = usable.reduce((s, w) => s + (w.northing as number), 0) / usable.length;
  const maxPosed = Math.max(
    1,
    ...usable.map((w) => {
      const st = stopsByKey.get(`${w.site}_${w.drive}`);
      return st?.n_posed ?? 1;
    })
  );

  return usable
    .slice()
    .sort((a, b) => (a.sol ?? 0) - (b.sol ?? 0))
    .map((w) => {
      const key = `${w.site}_${w.drive}`;
      const stop = stopsByKey.get(key) ?? null;
      const posed = stop?.n_posed ?? 0;
      const radius = 0.1 + 0.2 * Math.sqrt(Math.max(posed, 1) / maxPosed);
      const position = scaleEn(
        w.easting as number,
        w.northing as number,
        w.elev_geoid,
        originE,
        originN,
        metersPerUnit,
        true // always on basemap surface
      );
      return {
        id: key,
        stop,
        site: w.site,
        drive: w.drive,
        sol: w.sol,
        position,
        radius,
        hasImages: posed > 0,
        yawDeg: w.yaw_deg,
        distTotalM: w.dist_total_m,
        label: `sol ${w.sol ?? "?"} · ${w.site}/${w.drive}`,
      };
    });
}

/** Build one continuous line through waypoint EN order. */
export function lineThroughWaypoints(
  waypoints: MapWaypoint[],
  metersPerUnit = 25
): [number, number, number][] {
  const usable = waypoints
    .filter((w) => w.easting != null && w.northing != null)
    .slice()
    .sort((a, b) => (a.sol ?? 0) - (b.sol ?? 0));
  if (!usable.length) return [];
  const originE = usable.reduce((s, w) => s + (w.easting as number), 0) / usable.length;
  const originN = usable.reduce((s, w) => s + (w.northing as number), 0) / usable.length;
  return usable.map((w) =>
    scaleEn(
      w.easting as number,
      w.northing as number,
      w.elev_geoid,
      originE,
      originN,
      metersPerUnit,
      true
    )
  );
}

/** Fallback schematic strip when map data missing. */
export function layoutMissionPathSchematic(stops: Stop[]): PathNode[] {
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
  const length = Math.max(ordered.length * 0.55, 8);

  return ordered.map((stop, i) => {
    const sol = stop.sol_min ?? s0;
    const u =
      0.55 * (i / Math.max(ordered.length - 1, 1)) + 0.45 * ((sol - s0) / span);
    const x = (u - 0.5) * length;
    const z = ((stop.site ?? 0) % 7) * 0.35 - 1.0;
    const y = Math.log10(1 + (stop.n_posed || 0)) * 0.15;
    const radius = 0.08 + 0.22 * Math.sqrt((stop.n_posed || 0) / maxPosed);
    return {
      id: stop.stop_id,
      stop,
      site: stop.site,
      drive: stop.drive,
      sol: stop.sol_min,
      position: [x, y, z] as [number, number, number],
      radius,
      hasImages: (stop.n_posed || 0) > 0,
      yawDeg: stop.yaw_deg ?? null,
      distTotalM: stop.dist_total_m ?? null,
      label: `sol ${stop.sol_min ?? "?"} · ${stop.site}/${stop.drive}`,
    };
  });
}

function PathNodes({
  nodes,
  selectedId,
  onSelect,
  onOpenStop,
}: {
  nodes: PathNode[];
  selectedId: string | null;
  onSelect: (node: PathNode) => void;
  onOpenStop?: (node: PathNode) => void;
}) {
  // No floating HTML cards — they clutter the basemap. Selection details live in the HUD.
  return (
    <group>
      {nodes.map((n) => {
        const active = n.id === selectedId;
        const color = active ? "#e8a838" : n.hasImages ? "#4db6ac" : "#64748b";
        // Compact markers; active slightly larger
        const r = active ? Math.max(n.radius * 0.55, 0.1) : Math.max(n.radius * 0.35, 0.06);
        return (
          <group key={n.id} position={n.position}>
            <mesh
              onClick={(e: ThreeEvent<MouseEvent>) => {
                e.stopPropagation();
                onSelect(n);
              }}
              onDoubleClick={(e: ThreeEvent<MouseEvent>) => {
                e.stopPropagation();
                (onOpenStop ?? onSelect)(n);
              }}
              onPointerOver={(e) => {
                e.stopPropagation();
                document.body.style.cursor = "pointer";
              }}
              onPointerOut={() => {
                document.body.style.cursor = "default";
              }}
            >
              <sphereGeometry args={[r, 14, 14]} />
              <meshStandardMaterial
                color={color}
                emissive={color}
                emissiveIntensity={active ? 0.5 : n.hasImages ? 0.12 : 0.04}
                metalness={0.2}
                roughness={0.45}
              />
            </mesh>
            {n.yawDeg != null && active && (
              <mesh
                rotation={[0, (-n.yawDeg * Math.PI) / 180, 0]}
                position={[0, 0.02, 0]}
              >
                <boxGeometry args={[0.03, 0.03, r * 2.4]} />
                <meshBasicMaterial color="#e2e8f0" />
              </mesh>
            )}
          </group>
        );
      })}
    </group>
  );
}

function PathLine({ points }: { points: [number, number, number][] }) {
  if (points.length < 2) return null;
  return (
    <Line points={points} color="#94a3b8" lineWidth={2} transparent opacity={0.9} />
  );
}

function nodeToStop(n: PathNode): Stop | null {
  if (n.stop) return n.stop;
  if (n.site == null || n.drive == null) return null;
  return {
    stop_id: n.id,
    site: n.site,
    drive: n.drive,
    n_images: 0,
    n_posed: 0,
    pose_frac: 0,
    sol_min: n.sol,
    sol_max: n.sol,
    n_sols: 1,
    n_instruments: 0,
    instruments: {},
    n_navcam: 0,
    n_mcz: 0,
    n_stereo_capable: 0,
    lon: null,
    lat: null,
  };
}

function FramePath({ nodes }: { nodes: PathNode[] }) {
  const controls = useRef<OrbitControlsImpl>(null);
  const done = useRef(false);

  useEffect(() => {
    done.current = false;
  }, [nodes.length, nodes[0]?.id, nodes[nodes.length - 1]?.id]);

  useFrame(() => {
    if (done.current || !controls.current || nodes.length === 0) return;
    const box = new THREE.Box3();
    nodes.forEach((n) => box.expandByPoint(new THREE.Vector3(...n.position)));
    const center = new THREE.Vector3();
    const size = new THREE.Vector3();
    box.getCenter(center);
    box.getSize(size);
    const dist = Math.max(size.length() * 0.85, 8);
    controls.current.target.copy(center);
    controls.current.object.position.set(
      center.x,
      center.y + dist * 0.55,
      center.z + dist * 0.7
    );
    controls.current.update();
    done.current = true;
  });

  return (
    <OrbitControls
      ref={controls}
      makeDefault
      enableDamping
      maxDistance={400}
      minDistance={1}
    />
  );
}

export default function MissionPath({
  stops,
  waypoints,
  selectedStopId,
  onSelectStop,
  onOpenStop,
  mapAvailable,
  basemapLayer = "ctx",
  showBasemap = true,
}: {
  stops: Stop[];
  waypoints?: MapWaypoint[];
  selectedStopId: string | null;
  /** Single click: select / place rover (stay on path). */
  onSelectStop: (stop: Stop) => void;
  /** Double-click: open stop camera view. */
  onOpenStop?: (stop: Stop) => void;
  mapAvailable?: boolean;
  /** FU Berlin Jezero WMS layer key: ctx | hirise | hrsc | base */
  basemapLayer?: string;
  showBasemap?: boolean;
}) {
  const stopsByKey = useMemo(() => {
    const m = new Map<string, Stop>();
    stops.forEach((s) => m.set(s.stop_id, s));
    return m;
  }, [stops]);

  const useMap = Boolean(mapAvailable && waypoints && waypoints.length > 0);

  const nodes = useMemo(() => {
    if (useMap && waypoints) {
      return layoutFromWaypoints(waypoints, stopsByKey);
    }
    return layoutMissionPathSchematic(stops);
  }, [useMap, waypoints, stopsByKey, stops]);

  const pathLine = useMemo(() => {
    if (useMap && waypoints) return lineThroughWaypoints(waypoints);
    return nodes.map((n) => n.position);
  }, [useMap, waypoints, nodes]);

  const nWithImages = nodes.filter((n) => n.hasImages).length;
  const current = nodes[nodes.length - 1];

  const selectedNode = useMemo(() => {
    if (selectedStopId) {
      const hit = nodes.find((n) => n.id === selectedStopId);
      if (hit) return hit;
    }
    // default: latest waypoint (current rover location)
    return current ?? null;
  }, [nodes, selectedStopId, current]);

  // Path uses ~25 m / scene unit → exaggerate rover for map readability
  const roverLength = useMap ? 0.85 : 0.85;

  // Stable basemap URL (must not change on stop selection or Suspense remounts wipe the texture)
  const basemapUrl = useMemo(() => {
    if (!(showBasemap && useMap)) return null;
    return `/api/map/basemap?layer=${encodeURIComponent(basemapLayer)}&width=2048&height=2048&pad_deg=0.08`;
  }, [showBasemap, useMap, basemapLayer]);

  const roverPos: [number, number, number] | null = selectedNode
    ? [selectedNode.position[0], MAP_SURFACE_Y, selectedNode.position[2]]
    : null;

  return (
    <div className="mission-path-wrap">
      <Canvas camera={{ position: [0, 12, 18], fov: 50, near: 0.1, far: 2000 }}>
        <color attach="background" args={["#1a1410"]} />
        <fog attach="fog" args={["#1a1410", 80, 320]} />
        <ambientLight intensity={0.6} />
        <directionalLight position={[8, 14, 6]} intensity={1.1} castShadow />
        <hemisphereLight args={["#c4a882", "#3d2b1f", 0.45]} />
        {/* Basemap outside rover Suspense so GLB load never unmounts the map */}
        {nodes.length > 0 && (
          <Terrain
            nodes={nodes}
            padding={useMap ? 36 : 12}
            surfaceY={MAP_SURFACE_Y}
            showBasemap={Boolean(basemapUrl)}
            basemapUrl={basemapUrl}
          />
        )}
        {!(showBasemap && useMap) && (
          <gridHelper args={[200, 40, "#5c4030", "#3d2b1f"]} position={[0, -0.05, 0]} />
        )}
        <PathLine points={pathLine} />
        <PathNodes
          nodes={nodes}
          selectedId={selectedStopId}
          onSelect={(n) => {
            const stop = nodeToStop(n);
            if (stop) onSelectStop(stop);
          }}
          onOpenStop={(n) => {
            const stop = nodeToStop(n);
            if (stop) (onOpenStop ?? onSelectStop)(stop);
          }}
        />
        {roverPos && (
          <Suspense fallback={null}>
            <RoverModel
              position={roverPos}
              yawDeg={selectedNode?.yawDeg}
              frame="map"
              targetLength={roverLength}
              ground
            />
          </Suspense>
        )}
        <FramePath nodes={nodes} />
      </Canvas>
      <div className="hud mission-hud">
        <strong>{useMap ? "Jezero traverse (map)" : "Mission path (schematic)"}</strong>
        {" · "}
        {nodes.length} waypoints · {nWithImages} with image index
        {current?.distTotalM != null && (
          <> · ~{(current.distTotalM / 1000).toFixed(1)} km driven</>
        )}
        {selectedNode && (
          <>
            {" · "}
            rover @ sol {selectedNode.sol ?? "?"} ({selectedNode.site}/
            {selectedNode.drive})
            {selectedNode.hasImages && (
              <span className="muted"> · click again / Open stop for cameras</span>
            )}
          </>
        )}
        <div className="muted">
          Click a node to place the rover; double-click for cameras. Model:
          NASA/JPL-Caltech. Basemap: FU Berlin / maps.planet.fu-berlin.de (CTX).
        </div>
      </div>
    </div>
  );
}
