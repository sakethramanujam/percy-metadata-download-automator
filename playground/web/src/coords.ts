import * as THREE from "three";

/**
 * NASA raw-image camera poses (site/rover body style):
 *   +X forward, +Y right, +Z down
 * (mast optics ≈ z = -2 m → 2 m above the origin).
 *
 * Official Perseverance GLB (NASA/JPL) is authored roughly as:
 *   +X right, +Y up, +Z forward, origin near the ground under the chassis.
 *
 * Stop-view Three.js uses the **same** axes as the GLB so the mesh and rays share a frame:
 *   Three(x, y, z) = (body.y, -body.z, body.x)   // right, up, forward
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
    return [Number(c.pos_x ?? c.x ?? 0), Number(c.pos_y ?? c.y ?? 0), Number(c.pos_z ?? c.z ?? 0)];
  }
  return [Number(c.look_x ?? c.x ?? 0), Number(c.look_y ?? c.y ?? 0), Number(c.look_z ?? c.z ?? 0)];
}

/** Body-frame point → Three/GLB axes. */
export function bodyPosToThree(c: Vec3Like): THREE.Vector3 {
  const [x, y, z] = bodyXYZ(c, "pos");
  // right, up, forward
  return new THREE.Vector3(y, -z, x);
}

/** Body-frame direction → Three unit vector. */
export function bodyDirToThree(c: Vec3Like): THREE.Vector3 {
  const [x, y, z] = bodyXYZ(c, "look");
  const v = new THREE.Vector3(y, -z, x);
  if (v.lengthSq() < 1e-12) return new THREE.Vector3(0, 0, 1);
  return v.normalize();
}

/** Tuple [x,y,z] body → Three tuple. */
export function bodyTupleToThree(
  t: [number, number, number] | number[]
): [number, number, number] {
  const x = t[0] ?? 0;
  const y = t[1] ?? 0;
  const z = t[2] ?? 0;
  return [y, -z, x];
}
