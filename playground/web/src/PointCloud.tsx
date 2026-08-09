import { useMemo } from "react";
import * as THREE from "three";
import { bodyTupleToThreeAligned } from "./coords";

export type BodyPointCloud = {
  n: number;
  points: number[][];
  colors?: number[][] | null;
  frame?: string;
};

/**
 * Render a rover-body-frame point cloud in the stop Scene (GLB axes).
 * Body points are mapped with the same body→Three transform as cameras.
 */
export default function PointCloud({
  cloud,
  pointSize = 0.028,
  visible = true,
}: {
  cloud: BodyPointCloud | null;
  pointSize?: number;
  visible?: boolean;
}) {
  const buffers = useMemo(() => {
    if (!cloud?.points?.length) return null;
    const n = cloud.points.length;
    const positions = new Float32Array(n * 3);
    const colors = new Float32Array(n * 3);
    const hasColors = Boolean(cloud.colors && cloud.colors.length === n);
    const depthFallback = new THREE.Color("#7ec8e3");
    const near = new THREE.Color("#ffe082");
    const far = new THREE.Color("#1565c0");

    // Approximate depth range from camera origin for fallback coloring
    let zMin = Infinity;
    let zMax = -Infinity;
    if (!hasColors) {
      for (let i = 0; i < n; i++) {
        const p = cloud.points[i];
        const z = Math.hypot(p[0] ?? 0, p[1] ?? 0, p[2] ?? 0);
        if (z < zMin) zMin = z;
        if (z > zMax) zMax = z;
      }
      if (!Number.isFinite(zMin) || zMax <= zMin) {
        zMin = 0;
        zMax = 1;
      }
    }

    for (let i = 0; i < n; i++) {
      const p = cloud.points[i];
      const [x, y, z] = bodyTupleToThreeAligned([
        p[0] ?? 0,
        p[1] ?? 0,
        p[2] ?? 0,
      ]);
      positions[i * 3] = x;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = z;
      if (hasColors && cloud.colors) {
        const c = cloud.colors[i];
        colors[i * 3] = c[0] ?? 0.7;
        colors[i * 3 + 1] = c[1] ?? 0.7;
        colors[i * 3 + 2] = c[2] ?? 0.7;
      } else {
        const r = Math.hypot(p[0] ?? 0, p[1] ?? 0, p[2] ?? 0);
        const t = Math.min(1, Math.max(0, (r - zMin) / (zMax - zMin || 1)));
        const col = near.clone().lerp(far, t);
        // slight mix with cool accent
        col.lerp(depthFallback, 0.15);
        colors[i * 3] = col.r;
        colors[i * 3 + 1] = col.g;
        colors[i * 3 + 2] = col.b;
      }
    }
    return { positions, colors, n };
  }, [cloud]);

  if (!visible || !buffers) return null;

  return (
    <points frustumCulled={false}>
      <bufferGeometry>
        <bufferAttribute
          attach="attributes-position"
          args={[buffers.positions, 3]}
        />
        <bufferAttribute attach="attributes-color" args={[buffers.colors, 3]} />
      </bufferGeometry>
      <pointsMaterial
        size={pointSize}
        vertexColors
        sizeAttenuation
        transparent
        opacity={0.92}
        depthWrite={false}
      />
    </points>
  );
}
