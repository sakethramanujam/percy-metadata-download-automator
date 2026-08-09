import { Component, ReactNode, Suspense, useEffect, useMemo, useState } from "react";
import { useTexture } from "@react-three/drei";
import * as THREE from "three";
import type { PathNode } from "./MissionPath";

/**
 * Ground under the mission traverse.
 * Flat basemap plane at surfaceY so the path/rover sit on the orthophoto.
 */
export default function Terrain({
  nodes,
  padding = 36,
  basemapUrl = null,
  showBasemap = true,
  surfaceY = 0,
}: {
  nodes: PathNode[];
  padding?: number;
  basemapUrl?: string | null;
  showBasemap?: boolean;
  /** World Y of the map surface (path uses a tiny offset above this). */
  surfaceY?: number;
}) {
  const wantBasemap = Boolean(showBasemap && basemapUrl);
  const [failed, setFailed] = useState(false);
  const useBasemap = wantBasemap && !failed;

  useEffect(() => {
    setFailed(false);
  }, [basemapUrl, showBasemap]);

  const { centerXZ, size, geometry } = useMemo(() => {
    if (!nodes.length) {
      return {
        centerXZ: new THREE.Vector2(0, 0),
        size: new THREE.Vector2(40, 40),
        geometry: null as THREE.PlaneGeometry | null,
      };
    }
    let minX = Infinity,
      maxX = -Infinity,
      minZ = Infinity,
      maxZ = -Infinity;
    for (const n of nodes) {
      minX = Math.min(minX, n.position[0]);
      maxX = Math.max(maxX, n.position[0]);
      minZ = Math.min(minZ, n.position[2]);
      maxZ = Math.max(maxZ, n.position[2]);
    }
    const cx = (minX + maxX) / 2;
    const cz = (minZ + maxZ) / 2;
    const w = Math.max(maxX - minX + padding * 2, 20);
    const d = Math.max(maxZ - minZ + padding * 2, 20);
    const segs = useBasemap ? 1 : 48;
    const geometry = new THREE.PlaneGeometry(w, d, segs, segs);
    geometry.rotateX(-Math.PI / 2);
    if (!useBasemap) {
      const pos = geometry.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i);
        const z = pos.getZ(i);
        const n =
          Math.sin(x * 0.35) * Math.cos(z * 0.28) * 0.08 +
          Math.sin(x * 0.9 + z * 0.7) * 0.03;
        pos.setY(i, n);
      }
      pos.needsUpdate = true;
      geometry.computeVertexNormals();
    }
    return {
      centerXZ: new THREE.Vector2(cx, cz),
      size: new THREE.Vector2(w, d),
      geometry,
    };
  }, [nodes, padding, useBasemap]);

  if (!geometry) return null;

  // Plane at exact surfaceY; path sits slightly above
  return (
    <group position={[centerXZ.x, surfaceY, centerXZ.y]}>
      {useBasemap && basemapUrl ? (
        <Suspense fallback={<FallbackGround size={size} />}>
          <TextureErrorBoundary onError={() => setFailed(true)}>
            <BasemapMesh geometry={geometry} url={basemapUrl} />
          </TextureErrorBoundary>
        </Suspense>
      ) : (
        <mesh geometry={geometry} receiveShadow>
          <meshStandardMaterial
            color="#8a5a3a"
            roughness={0.92}
            metalness={0.05}
            flatShading
          />
        </mesh>
      )}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.03, 0]} receiveShadow>
        <planeGeometry args={[size.x * 1.2, size.y * 1.2]} />
        <meshStandardMaterial color="#2a1c12" roughness={1} metalness={0} />
      </mesh>
    </group>
  );
}

function FallbackGround({ size }: { size: THREE.Vector2 }) {
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
      <planeGeometry args={[size.x, size.y]} />
      <meshStandardMaterial color="#6b4423" roughness={1} />
    </mesh>
  );
}

class TextureErrorBoundary extends Component<
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

function BasemapMesh({
  geometry,
  url,
}: {
  geometry: THREE.PlaneGeometry;
  url: string;
}) {
  const texture = useTexture(url);
  useEffect(() => {
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 8;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.flipY = true;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.needsUpdate = true;
  }, [texture]);

  return (
    <mesh geometry={geometry} receiveShadow renderOrder={-1}>
      <meshStandardMaterial
        map={texture}
        roughness={0.98}
        metalness={0}
        color="#ffffff"
        depthWrite
        polygonOffset
        polygonOffsetFactor={1}
        polygonOffsetUnits={1}
      />
    </mesh>
  );
}
