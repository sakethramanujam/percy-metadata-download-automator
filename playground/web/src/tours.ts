import type { Camera, Stop } from "./api";

/**
 * Guided mission tours — scripted path → stop → camera (optional eye/pano)
 * with captions and shareable deep links (?tour=&step=).
 */

export type TourStepType =
  | "path"
  | "stop"
  | "camera"
  | "eye"
  | "pano"
  | "site";

export type TourStep = {
  id: string;
  type: TourStepType;
  title: string;
  caption: string;
  site?: number | null;
  drive?: number | null;
  imageid?: string | null;
  sol?: number | null;
  /** Optional dwell before auto-advance (ms). 0 = wait for user. */
  dwellMs?: number;
};

export type Tour = {
  id: string;
  title: string;
  description: string;
  steps: TourStep[];
};

/** Build a sol-ordered highlight tour from available stops. */
export function buildMissionHighlightTour(
  stops: Stop[],
  opts?: {
    maxStops?: number;
    minPosed?: number;
    preferMapped?: boolean;
  }
): Tour {
  const maxStops = opts?.maxStops ?? 12;
  const minPosed = opts?.minPosed ?? 8;
  const preferMapped = opts?.preferMapped !== false;

  let pool = stops.filter((s) => (s.n_posed || 0) >= minPosed);
  if (preferMapped) {
    const mapped = pool.filter((s) => s.easting != null || s.lon != null);
    if (mapped.length >= 4) pool = mapped;
  }
  pool = [...pool].sort((a, b) => {
    const sa = a.sol_min ?? 0;
    const sb = b.sol_min ?? 0;
    if (sa !== sb) return sa - sb;
    return (b.n_posed || 0) - (a.n_posed || 0);
  });

  // Spread across mission: pick evenly by sol rank, preferring high n_posed
  const picked: Stop[] = [];
  if (pool.length <= maxStops) {
    picked.push(...pool);
  } else {
    // Score by posed density; take top per sol-bucket
    const buckets = maxStops;
    const solMin = pool[0].sol_min ?? 0;
    const solMax = pool[pool.length - 1].sol_min ?? solMin + 1;
    for (let b = 0; b < buckets; b++) {
      const lo = solMin + ((solMax - solMin) * b) / buckets;
      const hi = solMin + ((solMax - solMin) * (b + 1)) / buckets;
      const inBucket = pool.filter((s) => {
        const sol = s.sol_min ?? 0;
        return sol >= lo && (b === buckets - 1 ? sol <= hi : sol < hi);
      });
      if (!inBucket.length) continue;
      inBucket.sort((a, b) => (b.n_posed || 0) - (a.n_posed || 0));
      const best = inBucket[0];
      if (!picked.find((p) => p.stop_id === best.stop_id)) picked.push(best);
    }
    // fill if sparse
    for (const s of pool) {
      if (picked.length >= maxStops) break;
      if (!picked.find((p) => p.stop_id === s.stop_id)) picked.push(s);
    }
    picked.sort((a, b) => (a.sol_min ?? 0) - (b.sol_min ?? 0));
  }

  const steps: TourStep[] = [
    {
      id: "intro",
      type: "path",
      title: "Mission path",
      caption:
        "Jezero crater traverse from MMGIS localization. Each waypoint is a (site, drive) stop. Follow sols along the path.",
      dwellMs: 0,
    },
  ];

  for (const s of picked) {
    const solLabel =
      s.sol_min != null
        ? s.sol_max != null && s.sol_max !== s.sol_min
          ? `sols ${s.sol_min}–${s.sol_max}`
          : `sol ${s.sol_min}`
        : "sol ?";
    steps.push({
      id: `path-${s.stop_id}`,
      type: "path",
      title: `Approach ${s.site}/${s.drive}`,
      caption: `Path highlight · site ${s.site} drive ${s.drive} · ${solLabel} · ${s.n_posed} posed images.`,
      site: s.site,
      drive: s.drive,
      sol: s.sol_min,
      dwellMs: 0,
    });
    steps.push({
      id: `stop-${s.stop_id}`,
      type: "stop",
      title: `Stop ${s.site}/${s.drive}`,
      caption: `Body-frame cameras at this stop (${solLabel}). Photo world shows FOV-matched planes at true CAHVOR poses.`,
      site: s.site,
      drive: s.drive,
      sol: s.sol_min,
      dwellMs: 0,
    });
    // Site world once per unique site (first time we hit it)
    const siteAlready = steps.some(
      (st) => st.type === "site" && st.site === s.site
    );
    if (!siteAlready && (s.n_posed || 0) >= 20) {
      steps.push({
        id: `site-${s.site}`,
        type: "site",
        title: `Site ${s.site} multi-drive`,
        caption: `All mapped drives at site ${s.site} in a shared easting/northing frame — compare outcrops across drives.`,
        site: s.site,
        drive: s.drive,
        dwellMs: 0,
      });
    }
  }

  steps.push({
    id: "outro",
    type: "path",
    title: "End of tour",
    caption:
      "Tour complete. Explore freely: open any stop, run stereo depth + point cloud, or stitch a site panorama.",
    dwellMs: 0,
  });

  return {
    id: "mission-highlights",
    title: "Mission highlights",
    description: `Sol-ordered tour of ${picked.length} high-coverage stops along the Perseverance traverse.`,
    steps,
  };
}

/** Attach a best camera (if available) after stop steps for richer tours. */
export function enrichTourWithCameras(
  tour: Tour,
  camerasByStop: Map<string, Camera[]>
): Tour {
  const steps: TourStep[] = [];
  for (const step of tour.steps) {
    steps.push(step);
    if (step.type !== "stop" || step.site == null || step.drive == null) continue;
    const key = `${step.site}_${step.drive}`;
    const cams = camerasByStop.get(key) || [];
    const best =
      cams.find((c) => (c.instrument || "").toUpperCase().includes("NAVCAM")) ||
      cams.find((c) => c.has_pose && c.pos_x != null) ||
      cams[0];
    if (best) {
      steps.push({
        id: `cam-${best.imageid}`,
        type: "camera",
        title: `${best.instrument} · sol ${best.sol ?? "?"}`,
        caption: `Fly to ${best.instrument} (${best.imageid.slice(0, 24)}…). Use Rover eye view for first-person FOV.`,
        site: step.site,
        drive: step.drive,
        imageid: best.imageid,
        sol: best.sol,
        dwellMs: 0,
      });
    }
  }
  return { ...tour, steps };
}

export function tourDeepLink(tourId: string, stepIndex: number): string {
  const params = new URLSearchParams(window.location.search);
  params.set("tour", tourId);
  params.set("step", String(stepIndex));
  return `${window.location.pathname}?${params.toString()}`;
}

export function parseTourFromUrl(): { tourId: string; step: number } | null {
  const params = new URLSearchParams(window.location.search);
  const tour = params.get("tour");
  if (!tour) return null;
  const step = Number(params.get("step") ?? "0");
  return { tourId: tour, step: Number.isFinite(step) ? Math.max(0, step) : 0 };
}
