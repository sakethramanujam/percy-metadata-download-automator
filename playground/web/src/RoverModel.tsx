import { useLayoutEffect, useMemo } from "react";
import { useGLTF } from "@react-three/drei";
import * as THREE from "three";
import { ROVER_MODEL_YAW_OFFSET_DEG } from "./coords";

const MODEL_URL = "/models/Perseverance.glb";

export type RoverModelProps = {
  /** World position of rover origin (body / map frame). */
  position?: [number, number, number];
  /**
   * Heading in degrees.
   * - frame "body": usually 0 (cameras already in body frame).
   * - frame "map": MMGIS yaw, 0 ≈ north (+X east, +Z south).
   */
  yawDeg?: number | null;
  /**
   * "body" = stop-local camera cloud (identity heading + model forward fix).
   * "map" = mission path EN scene with geographic yaw.
   */
  frame?: "body" | "map";
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
  frame = "map",
  targetLength = 0.9,
  scaleMul = 1,
  ground = true,
  visible = true,
}: RoverModelProps) {
  const { scene } = useGLTF(MODEL_URL);

  const { clone, fitScale } = useMemo(() => {
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

    // Center XZ; put wheels on y=0
    const center = new THREE.Vector3();
    box.getCenter(center);
    const yOff = ground ? -box.min.y : 0;
    clone.position.set(-center.x, yOff, -center.z);

    return { clone, fitScale };
  }, [scene, targetLength, ground]);

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

  const yawRad = ((yawDeg ?? 0) * Math.PI) / 180;
  // Map: 0 north, +Z south → rotY = π + yaw
  // Body: cameras use +X forward; glTF often +Z forward → apply offset so mesh +X matches body
  const rotY =
    frame === "body"
      ? yawRad + (ROVER_MODEL_YAW_OFFSET_DEG * Math.PI) / 180
      : Math.PI + yawRad;

  if (!visible) return null;

  return (
    <group position={position} rotation={[0, rotY, 0]} scale={fitScale * scaleMul}>
      <primitive object={clone} />
    </group>
  );
}

useGLTF.preload(MODEL_URL);
