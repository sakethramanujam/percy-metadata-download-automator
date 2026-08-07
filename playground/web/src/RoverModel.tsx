import { useLayoutEffect, useMemo } from "react";
import { useGLTF } from "@react-three/drei";
import * as THREE from "three";

const MODEL_URL = "/models/Perseverance.glb";

export type RoverModelProps = {
  /** World position of rover origin. */
  position?: [number, number, number];
  /**
   * Heading in degrees.
   * - frame "body": keep 0 — cameras already share the GLB body frame.
   * - frame "map": MMGIS yaw (0 ≈ north) in the EN path scene.
   */
  yawDeg?: number | null;
  /**
   * "body" = stop-local cloud: native GLB meters/origin (matches camera RBF mapping).
   * "map" = mission path: scaled + map yaw.
   */
  frame?: "body" | "map";
  /** Map-frame only: desired length in scene units. */
  targetLength?: number;
  scaleMul?: number;
  ground?: boolean;
  visible?: boolean;
};

/**
 * Official NASA/JPL-Caltech Perseverance glTF.
 * https://science.nasa.gov/resource/mars-perseverance-rover-3d-model/
 *
 * Native GLB axes (approx): +X right, +Y up, +Z forward, origin near ground.
 * That matches stop-view camera mapping in coords.ts.
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

    if (frame === "body") {
      // Preserve authoring origin (aligns with body-frame camera positions).
      // Only nudge so the lowest wheel sits on y=0 if slightly buried/floating.
      if (ground) {
        const box = new THREE.Box3().setFromObject(clone);
        if (Number.isFinite(box.min.y) && Math.abs(box.min.y) < 0.5) {
          clone.position.y -= box.min.y;
        }
      }
      return { clone, fitScale: 1 };
    }

    // Map path: fit length and center for schematic visibility
    const box = new THREE.Box3().setFromObject(clone);
    const size = new THREE.Vector3();
    box.getSize(size);
    const nativeLength = Math.max(size.x, size.z, 1e-6);
    const fitScale = targetLength / nativeLength;
    const center = new THREE.Vector3();
    box.getCenter(center);
    const yOff = ground ? -box.min.y : 0;
    clone.position.set(-center.x, yOff, -center.z);
    return { clone, fitScale };
  }, [scene, frame, targetLength, ground]);

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
  // Map path: 0 north, scene +Z south → π + yaw
  // Body: identity — GLB already +Z forward like our camera mapping
  const rotY = frame === "body" ? 0 : Math.PI + yawRad;

  if (!visible) return null;

  return (
    <group
      position={position}
      rotation={[0, rotY, 0]}
      scale={fitScale * scaleMul}
    >
      <primitive object={clone} />
    </group>
  );
}

useGLTF.preload(MODEL_URL);
