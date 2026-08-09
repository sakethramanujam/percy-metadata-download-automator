export type Stop = {
  stop_id: string;
  site: number | null;
  drive: number | null;
  n_images: number;
  n_posed: number;
  pose_frac: number;
  sol_min: number | null;
  sol_max: number | null;
  n_sols: number;
  n_instruments: number;
  instruments: Record<string, number>;
  n_navcam: number;
  n_mcz: number;
  n_stereo_capable: number;
  // MMGIS join (optional)
  lon?: number | null;
  lat?: number | null;
  elev_geoid?: number | null;
  easting?: number | null;
  northing?: number | null;
  yaw_deg?: number | null;
  dist_total_m?: number | null;
  rmc?: string | null;
  pano_url?: string | null;
};

export type MapWaypoint = {
  rmc: string | null;
  site: number | null;
  drive: number | null;
  sol: number | null;
  lon: number | null;
  lat: number | null;
  elev_geoid: number | null;
  easting: number | null;
  northing: number | null;
  yaw_deg: number | null;
  dist_total_m: number | null;
  stop_id: string | null;
  pano_url?: string | null;
  pano_is_panoramic?: boolean;
  note?: string | null;
};

export type TraverseSegment = {
  segment_id: number;
  sol: number | null;
  from_rmc: string;
  to_rmc: string;
  length_m: number | null;
  coordinates: number[][];
};

export type Camera = {
  imageid: string;
  sol: number | null;
  site: number | null;
  drive: number | null;
  stop_id: string;
  instrument: string;
  filter_name: string;
  date_taken_utc: string | null;
  mast_az: number | null;
  mast_el: number | null;
  pos_x: number | null;
  pos_y: number | null;
  pos_z: number | null;
  look_x: number | null;
  look_y: number | null;
  look_z: number | null;
  up_x?: number | null;
  up_y?: number | null;
  up_z?: number | null;
  right_x?: number | null;
  right_y?: number | null;
  right_z?: number | null;
  yaw_rad: number | null;
  pitch_rad?: number | null;
  roll_rad?: number | null;
  quat_w?: number | null;
  quat_x?: number | null;
  quat_y?: number | null;
  quat_z?: number | null;
  hfov_deg: number | null;
  vfov_deg: number | null;
  basis_source?: string | null;
  has_pose: boolean;
  model_type: string;
  model_ok: boolean;
  url_small: string | null;
  url_medium: string | null;
  caption: string | null;
  title: string | null;
  /** MMGIS anchor for site-scale multi-drive world */
  drive_easting?: number | null;
  drive_northing?: number | null;
  drive_yaw_deg?: number | null;
  drive_stop_id?: string | null;
  /** body = rover frame; site_three = already in EN site Three meters */
  pose_frame?: "body" | "site_three" | null;
};

export type SiteDrive = {
  site: number;
  drive: number | null;
  stop_id?: string | null;
  sol_min?: number | null;
  sol_max?: number | null;
  n_posed?: number;
  n_images?: number;
  easting?: number | null;
  northing?: number | null;
  yaw_deg?: number | null;
  lon?: number | null;
  lat?: number | null;
  dist_total_m?: number | null;
};

export type SiteWorld = {
  site: number;
  n_drives: number;
  n_drives_mapped: number;
  drives: SiteDrive[];
  cameras: Camera[];
  total_cameras: number;
  returned: number;
  origin_easting: number | null;
  origin_northing: number | null;
  frame: string;
  note?: string;
};

export function fetchSiteWorld(
  site: number,
  opts?: {
    max_drives?: number;
    max_per_drive?: number;
    max_total?: number;
    sol_min?: number;
    sol_max?: number;
  }
) {
  const params = new URLSearchParams({
    max_drives: String(opts?.max_drives ?? 24),
    max_per_drive: String(opts?.max_per_drive ?? 100),
    max_total: String(opts?.max_total ?? 1200),
    posed_only: "true",
  });
  if (opts?.sol_min != null) params.set("sol_min", String(opts.sol_min));
  if (opts?.sol_max != null) params.set("sol_max", String(opts.sol_max));
  return getJson<SiteWorld>(`/api/sites/${site}/world?${params}`);
}

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) {
    const detail = await r.text();
    throw new Error(`${r.status} ${detail}`);
  }
  return r.json() as Promise<T>;
}

export function fetchStops() {
  return getJson<{ stops: Stop[] }>("/api/stops?min_images=1");
}

export function fetchCameras(site: number, drive: number, instruments?: string[]) {
  const params = new URLSearchParams({ posed_only: "true", limit: "4000" });
  (instruments || []).forEach((i) => params.append("instrument", i));
  return getJson<{
    site: number;
    drive: number;
    total: number;
    returned: number;
    cameras: Camera[];
  }>(`/api/stops/${site}/${drive}/cameras?${params}`);
}

export function fetchImage(imageid: string) {
  return getJson<Camera & Record<string, unknown>>(`/api/images/${encodeURIComponent(imageid)}`);
}

export function thumbUrl(
  imageid: string,
  size: "small" | "medium" | "large" | "full" = "small"
) {
  return `/api/images/${encodeURIComponent(imageid)}/thumb?size=${size}`;
}

export function fetchHealth() {
  return getJson<{ ok: boolean; index: boolean; n_images?: number; hint?: string }>(
    "/api/health"
  );
}

export function fetchStats() {
  return getJson<{
    n_images: number;
    n_posed: number;
    n_stops: number;
    sol_min: number | null;
    sol_max: number | null;
    instruments: Record<string, number>;
  }>("/api/stats");
}

export type StereoPair = {
  id: string;
  sol: number | null;
  family: string;
  left_imageid: string;
  right_imageid: string;
  left_instrument: string;
  right_instrument: string;
  left_filter: string;
  right_filter: string;
  score: number;
  baseline_m: number | null;
  dt_sclk: number | null;
  look_angle_deg: number | null;
  left_pos: [number, number, number] | null;
  right_pos: [number, number, number] | null;
  left_look: [number, number, number] | null;
  right_look: [number, number, number] | null;
};

export function fetchMap() {
  return getJson<{
    available: boolean;
    n_waypoints: number;
    n_traverse_segments: number;
    n_stops: number;
    n_stops_with_map: number;
    waypoints: MapWaypoint[];
    traverse: TraverseSegment[];
    current?: {
      site?: number;
      drive?: number;
      sol?: number;
      lon?: number;
      lat?: number;
      dist_total_m?: number;
    } | null;
    manifest?: Record<string, unknown>;
  }>("/api/map");
}

export type PanoSourceSize = "small" | "medium" | "large" | "full";

/** Pose-driven cylindrical pano for a stop (returns image URL + optional meta). */
export function panoUrl(
  site: number,
  drive: number,
  opts?: {
    max_frames?: number;
    out_width?: number;
    size?: PanoSourceSize;
  }
) {
  const params = new URLSearchParams({
    max_frames: String(opts?.max_frames ?? 40),
    out_width: String(opts?.out_width ?? 4096),
    size: opts?.size ?? "medium",
  });
  return `/api/stops/${site}/${drive}/pano?${params}`;
}

export function fetchPanoMeta(
  site: number,
  drive: number,
  opts?: {
    max_frames?: number;
    out_width?: number;
    size?: PanoSourceSize;
  }
) {
  const params = new URLSearchParams({
    max_frames: String(opts?.max_frames ?? 40),
    out_width: String(opts?.out_width ?? 4096),
    size: opts?.size ?? "medium",
    meta_only: "true",
  });
  return getJson<{
    site: number;
    drive: number;
    n_frames: number;
    frames: Array<{
      imageid: string;
      instrument: string;
      sol: number | null;
      az_deg: number;
      el_deg: number;
    }>;
    width: number;
    height: number;
    az_span_deg: number;
    el_span_deg: number;
    method: string;
    frame: string;
    elapsed_ms: number;
    source_size?: string;
    source_max_side?: number;
    note: string;
  }>(`/api/stops/${site}/${drive}/pano?${params}`);
}

export function fetchStereoPairs(
  site: number,
  drive: number,
  opts?: { sol_min?: number; sol_max?: number; max_pairs?: number }
) {
  const params = new URLSearchParams({
    max_pairs: String(opts?.max_pairs ?? 80),
  });
  if (opts?.sol_min != null) params.set("sol_min", String(opts.sol_min));
  if (opts?.sol_max != null) params.set("sol_max", String(opts.sol_max));
  return getJson<{
    site: number;
    drive: number;
    n_pairs: number;
    pairs: StereoPair[];
  }>(`/api/stops/${site}/${drive}/stereo-pairs?${params}`);
}

export type StereoPointCloud = {
  n: number;
  points: number[][];
  colors?: number[][] | null;
  frame?: string;
  origin?: number[];
  shape?: number[];
  left_imageid?: string;
  note?: string;
};

export type StereoDepthResult = {
  pair_id: string;
  left_imageid: string;
  right_imageid: string;
  baseline_m: number | null;
  shape: number[];
  stats: {
    n_valid?: number;
    n_pixels?: number;
    valid_frac?: number;
    disp_min?: number | null;
    disp_max?: number | null;
    disp_mean?: number | null;
    disp_median?: number | null;
  };
  preview_data_url: string;
  approx_depth_m_median?: number | null;
  backend?: string;
  device?: string;
  elapsed_ms?: number;
  point_cloud?: StereoPointCloud | null;
  note?: string;
};

/** Stereo depth: disparity preview + optional body-frame point cloud. */
export function fetchStereoDepth(
  site: number,
  drive: number,
  pairId: string,
  opts?: {
    size?: "small" | "medium";
    pointCloud?: boolean;
    maxPoints?: number;
    preferGpu?: boolean;
  }
) {
  const params = new URLSearchParams({
    pair_id: pairId,
    size: opts?.size ?? "small",
    point_cloud: opts?.pointCloud === false ? "false" : "true",
    max_points: String(opts?.maxPoints ?? 20000),
    prefer_gpu: opts?.preferGpu === false ? "false" : "true",
  });
  return getJson<StereoDepthResult>(
    `/api/stops/${site}/${drive}/stereo-depth?${params}`
  );
}
