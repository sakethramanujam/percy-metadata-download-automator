import { useLayoutEffect, useMemo } from "react";
import { useGLTF } from "@react-three/drei";
import * as THREE from "three";

const MODEL_URL = "/models/Perseverance.glb";

export type RoverModelProps = {
  /** World position of rover origin (ground contact / body frame). */
  position?: [number, number, number];
  /**
   * Heading in degrees (MMGIS yaw). 0 ≈ north.
   * Scene map frame: +X east, +Z south (−north), +Y up.
   */
  yawDeg?: number | null;
  /** Desired rover length along longest horizontal axis (scene units). */
  targetLength?: number;
  /** Extra uniform scale multiplier after fitting targetLength. */
  scaleMul?: number;
  /** Lift model so bottom of bbox sits near y=0. */
  ground?: boolean;
  visible?: boolean;
};

/**
 * Official NASA/JPL-Caltech Perseverance glTF.
 * https://science.nasa.gov/resource/mars-perseverance-rover-3d-model/
 */
export default function RoverModel({
  position = [0, 0, 0],
  yawDeg = 0,
  targetLength = 0.9,
  scaleMul = 1,
  ground = true,
  visible = true,
}: RoverModelProps) {
  const { scene } = useGLTF(MODEL_URL);

  const { clone, fitScale, yOffset } = useMemo(() => {
    const clone = scene.clone(true);
    clone.traverse((obj) => {
      if ((obj as THREE.Mesh).isMesh) {
        const mesh = obj as THREE.Mesh;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
      }
    });

    const box = new THREE.Box3().setFromObject(clone);
    const size = new THREE.Vector3();
    box.getSize(size);
    const nativeLength = Math.max(size.x, size.z, 1e-6);
    const fitScale = targetLength / nativeLength;
    const yOffset = ground ? -box.min.y : 0;

    // Center XZ in model space
    const center = new THREE.Vector3();
    box.getCenter(center);
    clone.position.set(-center.x, yOffset, -center.z);

    return { clone, fitScale, yOffset };
  }, [scene, targetLength, ground]);

  // Ensure materials update once
  useLayoutEffect(() => {
    clone.traverse((obj) => {
      if ((obj as THREE.Mesh).isMesh) {
        const mesh = obj as THREE.Mesh;
        const mats = Array.isArray(mesh.material)
          ? mesh.material
          : [mesh.material];
        mats.forEach((m) => {
          if (m) m.needsUpdate = true;
        });
      }
    });
  }, [clone]);

  // Map yaw: 0 = north. +Z is south → rotY = π + yaw
  const yawRad = ((yawDeg ?? 0) * Math.PI) / 180;
  const rotY = Math.PI + yawRad;

  if (!visible) return null;

  return (
    <group position={position} rotation={[0, rotY, 0]} scale={fitScale * scaleMul}>
      <primitive object={clone} />
    </group>
  );
}

useGLTF.preload(MODEL_URL);
