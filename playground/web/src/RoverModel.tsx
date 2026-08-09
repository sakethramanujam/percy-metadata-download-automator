import { useLayoutEffect, useMemo } from "react";
import { useGLTF } from "@react-three/drei";
import * as THREE from "three";

const MODEL_URL = "/models/Perseverance.glb";

export type RoverModelProps = {
  position?: [number, number, number];
  /**
   * Heading in degrees.
   * - body: 0 (cameras share GLB frame)
   * - map: MMGIS yaw, 0 ≈ north
   */
  yawDeg?: number | null;
  frame?: "body" | "map";
  targetLength?: number;
  scaleMul?: number;
  ground?: boolean;
  visible?: boolean;
};

/**
 * NASA/JPL-Caltech Perseverance glTF.
 * https://science.nasa.gov/resource/mars-perseverance-rover-3d-model/
 *
 * Body frame: static mesh at native meters/origin (no mast/arm articulation,
 * no re-center). Camera rays use true poses in coords.ts.
 * Map frame: fit length + geographic yaw for the traverse view only.
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
      // Static 1:1 with authored GLB. Do not scale, re-center, ground-nudge,
      // or animate mast/arm — images were taken at many articulations; the
      // mesh is a single rest pose.
      return { clone, fitScale: 1 };
    }

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
  const rotY = frame === "body" ? 0 : Math.PI + yawRad;
  const s = fitScale * scaleMul;

  if (!visible) return null;

  return (
    <group position={position} rotation={[0, rotY, 0]} scale={s}>
      <primitive object={clone} />
    </group>
  );
}

useGLTF.preload(MODEL_URL);
