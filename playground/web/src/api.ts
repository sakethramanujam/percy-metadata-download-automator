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
  yaw_rad: number | null;
  hfov_deg: number | null;
  vfov_deg: number | null;
  has_pose: boolean;
  model_type: string;
  model_ok: boolean;
  url_small: string | null;
  url_medium: string | null;
  caption: string | null;
  title: string | null;
};

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
