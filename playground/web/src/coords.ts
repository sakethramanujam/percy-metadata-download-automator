import * as THREE from "three";

/**
 * NASA Mars 2020 raw-image camera poses are in a rover body / site-local frame
 * consistent with rover navigation: roughly
 *   +X forward, +Y right, +Z down
 * (mast cameras sit near z ≈ -2 m → ~2 m above the origin).
 *
 * Three.js scene: +X right-hand, +Y up, +Z toward camera by default.
 * We map body → Three as:
 *   Three(x, y, z) = (body.x, -body.z, body.y)
 * so +X stays forward, height is -z, and +Y_body becomes +Z_three.
 */

export type Vec3Like = {
  x?: number | null;
  y?: number | null;
  z?: number | null;
  pos_x?: number | null;
  pos_y?: number | null;
  pos_z?: number | null;
  look_x?: number | null;
  look_y?: number | null;
  look_z?: number | null;
};

function bodyXYZ(c: Vec3Like, kind: "pos" | "look"): [number, number, number] {
  if (kind === "pos") {
    return [c.pos_x ?? c.x ?? 0, c.pos_y ?? c.y ?? 0, c.pos_z ?? c.z ?? 0];
  }
  return [c.look_x ?? c.x ?? 0, c.look_y ?? c.y ?? 0, c.look_z ?? c.z ?? 0];
}

/** Body-frame point → Three.js Vector3. */
export function bodyPosToThree(c: Vec3Like): THREE.Vector3 {
  const [x, y, z] = bodyXYZ(c, "pos");
  return new THREE.Vector3(x, -z, y);
}

/** Body-frame direction → Three.js unit Vector3. */
export function bodyDirToThree(c: Vec3Like): THREE.Vector3 {
  const [x, y, z] = bodyXYZ(c, "look");
  const v = new THREE.Vector3(x, -z, y);
  if (v.lengthSq() < 1e-12) return new THREE.Vector3(0, 0, 1);
  return v.normalize();
}

/** Tuple [x,y,z] body → [x,-z,y] three. */
export function bodyTupleToThree(
  t: [number, number, number] | number[]
): [number, number, number] {
  const x = t[0] ?? 0;
  const y = t[1] ?? 0;
  const z = t[2] ?? 0;
  return [x, -z, y];
}

/**
 * glTF model often faces +Z; body +X is forward (Three +X after our map).
 * Rotate model so its forward aligns with body +X: -90° about Y.
 */
export const ROVER_MODEL_YAW_OFFSET_DEG = -90;
