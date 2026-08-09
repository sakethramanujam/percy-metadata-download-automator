import * as THREE from "three";

/**
 * NASA raw-image camera poses (rover body / site style):
 *   +X forward, +Y right, +Z down
 *
 * Official Perseverance GLB is authored as:
 *   +X right, +Y up, +Z forward, origin near the ground.
 * The RSM / mast sits on the −X side of that model.
 *
 * Stop-view map into the GLB axis system (1:1 meters, no mesh mirror):
 *   three = (−body.y, −body.z, body.x)  // left, up, forward
 *
 * Orientation: look / up / right from CAHVOR + attitude are body-frame unit
 * vectors; the same linear map is applied (pure rotation/reflection, no offset).
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
  up_x?: number | null;
  up_y?: number | null;
  up_z?: number | null;
  right_x?: number | null;
  right_y?: number | null;
  right_z?: number | null;
  instrument?: string | null;
  /**
   * body (default): NASA rover body frame, mapped via body→Three.
   * site_three: already in site EN Three space (X east, Y up, Z −north).
   */
  pose_frame?: "body" | "site_three" | null;
};

function isSiteThree(c: Vec3Like): boolean {
  return c.pose_frame === "site_three";
}

function bodyXYZ(
  c: Vec3Like,
  kind: "pos" | "look" | "up" | "right"
): [number, number, number] {
  if (kind === "pos") {
    return [
      Number(c.pos_x ?? c.x ?? 0),
      Number(c.pos_y ?? c.y ?? 0),
      Number(c.pos_z ?? c.z ?? 0),
    ];
  }
  if (kind === "up") {
    return [
      Number(c.up_x ?? 0),
      Number(c.up_y ?? 0),
      Number(c.up_z ?? -1), // body +Z down → default up −Z
    ];
  }
  if (kind === "right") {
    return [
      Number(c.right_x ?? 0),
      Number(c.right_y ?? 1),
      Number(c.right_z ?? 0),
    ];
  }
  return [
    Number(c.look_x ?? c.x ?? 0),
    Number(c.look_y ?? c.y ?? 0),
    Number(c.look_z ?? c.z ?? 0),
  ];
}

/** Map body (x,y,z) → Three (left, up, forward). */
export function mapBodyToThree(x: number, y: number, z: number): THREE.Vector3 {
  return new THREE.Vector3(-y, -z, x);
}

/** Body-frame point → Three/GLB axes (left, up, forward). */
export function bodyPosToThree(c: Vec3Like): THREE.Vector3 {
  if (isSiteThree(c)) {
    const [x, y, z] = bodyXYZ(c, "pos");
    return new THREE.Vector3(x, y, z);
  }
  const [x, y, z] = bodyXYZ(c, "pos");
  return mapBodyToThree(x, y, z);
}

/** Body-frame direction → Three unit vector. */
export function bodyDirToThree(c: Vec3Like): THREE.Vector3 {
  if (isSiteThree(c)) {
    const [x, y, z] = bodyXYZ(c, "look");
    const v = new THREE.Vector3(x, y, z);
    if (v.lengthSq() < 1e-12) return new THREE.Vector3(0, 0, 1);
    return v.normalize();
  }
  const [x, y, z] = bodyXYZ(c, "look");
  const v = mapBodyToThree(x, y, z);
  if (v.lengthSq() < 1e-12) return new THREE.Vector3(0, 0, 1);
  return v.normalize();
}

export function bodyUpToThree(c: Vec3Like): THREE.Vector3 {
  if (isSiteThree(c)) {
    const [x, y, z] = bodyXYZ(c, "up");
    const v = new THREE.Vector3(x, y, z);
    if (v.lengthSq() < 1e-12) return new THREE.Vector3(0, 1, 0);
    return v.normalize();
  }
  const [x, y, z] = bodyXYZ(c, "up");
  const v = mapBodyToThree(x, y, z);
  if (v.lengthSq() < 1e-12) return new THREE.Vector3(0, 1, 0);
  return v.normalize();
}

export function bodyRightToThree(c: Vec3Like): THREE.Vector3 {
  if (isSiteThree(c)) {
    const [x, y, z] = bodyXYZ(c, "right");
    const v = new THREE.Vector3(x, y, z);
    if (v.lengthSq() < 1e-12) {
      return new THREE.Vector3()
        .crossVectors(bodyDirToThree(c), bodyUpToThree(c))
        .normalize();
    }
    return v.normalize();
  }
  const [x, y, z] = bodyXYZ(c, "right");
  const v = mapBodyToThree(x, y, z);
  if (v.lengthSq() < 1e-12) {
    // recover from look × up
    return new THREE.Vector3().crossVectors(bodyDirToThree(c), bodyUpToThree(c)).normalize();
  }
  return v.normalize();
}

/**
 * Full camera orientation as a Three.js quaternion.
 * Maps body camera axes (right, up, -look) to Three world axes of a plane
 * whose local +Z faces the scene (toward origin of view / image normal).
 *
 * Plane local: +X right, +Y up, +Z out of image toward camera center.
 * World: right_three, up_three, -look_three (out of image toward viewer at origin).
 */
export function bodyCamQuatToThree(c: Vec3Like): THREE.Quaternion {
  let look = bodyDirToThree(c);
  let up = bodyUpToThree(c);
  let right = bodyRightToThree(c);

  // Re-orthonormalize in Three space (handles missing components)
  look = look.normalize();
  // Make up perpendicular to look
  up = up.sub(look.clone().multiplyScalar(up.dot(look)));
  if (up.lengthSq() < 1e-10) up = new THREE.Vector3(0, 1, 0);
  up.normalize();
  right = new THREE.Vector3().crossVectors(look, up).normalize();
  up = new THREE.Vector3().crossVectors(right, look).normalize();

  // Columns of rotation matrix = Three axes of camera/plane frame
  // plane +X = right, +Y = up, +Z = -look (faces toward camera position from plane center)
  const m = new THREE.Matrix4().makeBasis(right, up, look.clone().multiplyScalar(-1));
  return new THREE.Quaternion().setFromRotationMatrix(m);
}

/** Tuple [x,y,z] body → Three tuple. */
export function bodyTupleToThree(
  t: [number, number, number] | number[]
): [number, number, number] {
  const x = t[0] ?? 0;
  const y = t[1] ?? 0;
  const z = t[2] ?? 0;
  return [-y, -z, x];
}

/**
 * Small rigid nudge after the axis map so fixed hazcams sit near mesh hardpoints.
 */
export const BODY_TO_GLB_OFFSET = new THREE.Vector3(0.02, 0.04, -0.12);

export function bodyPosToThreeAligned(c: Vec3Like): THREE.Vector3 {
  // site_three already includes map placement + GLB offset
  if (isSiteThree(c)) return bodyPosToThree(c);
  return bodyPosToThree(c).add(BODY_TO_GLB_OFFSET);
}

export function bodyDirToThreeAligned(c: Vec3Like): THREE.Vector3 {
  return bodyDirToThree(c);
}

export function bodyUpToThreeAligned(c: Vec3Like): THREE.Vector3 {
  return bodyUpToThree(c);
}

export function bodyRightToThreeAligned(c: Vec3Like): THREE.Vector3 {
  return bodyRightToThree(c);
}

export function bodyCamQuatToThreeAligned(c: Vec3Like): THREE.Quaternion {
  return bodyCamQuatToThree(c);
}

export function bodyTupleToThreeAligned(
  t: [number, number, number] | number[],
  _instrument?: string | null
): [number, number, number] {
  const [x, y, z] = bodyTupleToThree(t);
  return [
    x + BODY_TO_GLB_OFFSET.x,
    y + BODY_TO_GLB_OFFSET.y,
    z + BODY_TO_GLB_OFFSET.z,
  ];
}

/** Pass-through for points already in site Three meters. */
export function siteThreeTuple(
  t: [number, number, number] | number[]
): [number, number, number] {
  return [t[0] ?? 0, t[1] ?? 0, t[2] ?? 0];
}
