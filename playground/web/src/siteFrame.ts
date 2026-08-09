import * as THREE from "three";
import type { Camera } from "./api";
import { BODY_TO_GLB_OFFSET, mapBodyToThree } from "./coords";

/**
 * Site frame matches MissionPath map layout (meters):
 *   X = east, Y = up, Z = −north
 *
 * Each drive is anchored by MMGIS (easting, northing, yaw_deg).
 * Body-frame camera poses are mapped through the GLB/body three axes,
 * then rotated by map heading and translated to the drive EN position.
 *
 * RoverModel map rotation uses Y = π + yaw (yaw 0 ≈ north).
 */

export type DriveAnchor = {
  drive: number | null;
  easting: number | null;
  northing: number | null;
  yaw_deg: number | null;
  stop_id?: string | null;
};

export type SiteOrigin = {
  easting: number;
  northing: number;
};

/** Drive EN → site Three position (flat ground). */
export function drivePosToSite(
  easting: number,
  northing: number,
  origin: SiteOrigin,
  surfaceY = 0
): THREE.Vector3 {
  return new THREE.Vector3(
    easting - origin.easting,
    surfaceY,
    -(northing - origin.northing)
  );
}

/** Same rotation as RoverModel frame="map". */
export function mapYawQuaternion(yawDeg: number): THREE.Quaternion {
  const yawRad = (yawDeg * Math.PI) / 180;
  return new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(0, 1, 0),
    Math.PI + yawRad
  );
}

/**
 * Place a body-frame point (already in body meters) into site Three space.
 */
export function bodyPointToSite(
  bodyX: number,
  bodyY: number,
  bodyZ: number,
  easting: number,
  northing: number,
  yawDeg: number,
  origin: SiteOrigin,
  applyGlbOffset = true
): THREE.Vector3 {
  const local = mapBodyToThree(bodyX, bodyY, bodyZ);
  if (applyGlbOffset) local.add(BODY_TO_GLB_OFFSET);
  local.applyQuaternion(mapYawQuaternion(yawDeg));
  return local.add(drivePosToSite(easting, northing, origin));
}

/** Direction only (no translation / offset). */
export function bodyDirToSite(
  bodyX: number,
  bodyY: number,
  bodyZ: number,
  yawDeg: number
): THREE.Vector3 {
  const local = mapBodyToThree(bodyX, bodyY, bodyZ);
  if (local.lengthSq() < 1e-12) return new THREE.Vector3(0, 0, 1);
  local.normalize();
  local.applyQuaternion(mapYawQuaternion(yawDeg));
  return local.normalize();
}

/**
 * Rewrite a body-frame Camera into site_three pose_frame for PhotoWorld/Scene.
 * Missing map anchors → leave body frame (all drives pile at origin).
 */
export function cameraToSiteFrame(
  cam: Camera,
  origin: SiteOrigin | null
): Camera {
  const e = cam.drive_easting;
  const n = cam.drive_northing;
  const yaw = cam.drive_yaw_deg ?? 0;
  if (
    origin == null ||
    e == null ||
    n == null ||
    !Number.isFinite(e) ||
    !Number.isFinite(n)
  ) {
    return { ...cam, pose_frame: "body" };
  }

  const pos = bodyPointToSite(
    Number(cam.pos_x ?? 0),
    Number(cam.pos_y ?? 0),
    Number(cam.pos_z ?? 0),
    e,
    n,
    yaw,
    origin
  );
  const look = bodyDirToSite(
    Number(cam.look_x ?? 0),
    Number(cam.look_y ?? 0),
    Number(cam.look_z ?? 0),
    yaw
  );
  const up = bodyDirToSite(
    Number(cam.up_x ?? 0),
    Number(cam.up_y ?? 0),
    Number(cam.up_z ?? -1),
    yaw
  );
  const right = bodyDirToSite(
    Number(cam.right_x ?? 0),
    Number(cam.right_y ?? 1),
    Number(cam.right_z ?? 0),
    yaw
  );
  const lookN =
    look.lengthSq() > 1e-12 ? look : new THREE.Vector3(0, 0, 1);

  return {
    ...cam,
    pos_x: pos.x,
    pos_y: pos.y,
    pos_z: pos.z,
    look_x: lookN.x,
    look_y: lookN.y,
    look_z: lookN.z,
    up_x: up.x,
    up_y: up.y,
    up_z: up.z,
    right_x: right.x,
    right_y: right.y,
    right_z: right.z,
    pose_frame: "site_three",
  };
}

export function camerasToSiteFrame(
  cameras: Camera[],
  originEasting: number | null | undefined,
  originNorthing: number | null | undefined
): Camera[] {
  if (
    originEasting == null ||
    originNorthing == null ||
    !Number.isFinite(originEasting) ||
    !Number.isFinite(originNorthing)
  ) {
    return cameras.map((c) => ({ ...c, pose_frame: "body" as const }));
  }
  const origin: SiteOrigin = {
    easting: originEasting,
    northing: originNorthing,
  };
  return cameras.map((c) => cameraToSiteFrame(c, origin));
}

/** Prefer navcam + angular diversity, balanced across drives. */
export function pickSiteWorldCameras(cameras: Camera[], maxN = 60): Camera[] {
  if (cameras.length <= maxN) return cameras;
  const byDrive = new Map<number, Camera[]>();
  for (const c of cameras) {
    const d = c.drive ?? -1;
    if (!byDrive.has(d)) byDrive.set(d, []);
    byDrive.get(d)!.push(c);
  }
  const drives = [...byDrive.keys()].sort((a, b) => a - b);
  const perDrive = Math.max(2, Math.ceil(maxN / Math.max(1, drives.length)));
  const rank = (inst: string) => {
    const u = (inst || "").toUpperCase();
    if (u.includes("NAVCAM")) return 0;
    if (u.includes("MCZ") || u.includes("MASTCAM")) return 1;
    if (u.includes("HAZCAM")) return 2;
    return 3;
  };
  const picked: Camera[] = [];
  for (const d of drives) {
    const list = (byDrive.get(d) || []).sort((a, b) => {
      const ra = rank(a.instrument);
      const rb = rank(b.instrument);
      if (ra !== rb) return ra - rb;
      return (a.sol ?? 0) - (b.sol ?? 0);
    });
    const take = list.slice(0, perDrive);
    picked.push(...take);
  }
  if (picked.length > maxN) {
    // stride down
    const out: Camera[] = [];
    for (let i = 0; i < maxN; i++) {
      out.push(picked[Math.floor((i * (picked.length - 1)) / (maxN - 1))]);
    }
    return out;
  }
  if (picked.length < maxN) {
    const have = new Set(picked.map((c) => c.imageid));
    for (const c of cameras) {
      if (picked.length >= maxN) break;
      if (have.has(c.imageid)) continue;
      picked.push(c);
      have.add(c.imageid);
    }
  }
  return picked;
}
