import { useEffect, useMemo, useRef, useState } from "react";
import Scene from "./Scene";
import SiteScene from "./SiteScene";
import MissionPath from "./MissionPath";
import EyeView from "./EyeView";
import PanoView from "./PanoView";
import MapInset from "./MapInset";
import TourOverlay from "./TourOverlay";
import {
  Camera,
  MapWaypoint,
  SiteDrive,
  StereoPair,
  Stop,
  fetchCameras,
  fetchHealth,
  fetchImage,
  fetchMap,
  fetchPanoMeta,
  fetchSiteWorld,
  fetchStats,
  fetchStereoDepth,
  fetchStereoPairs,
  fetchStops,
  panoUrl,
  thumbUrl,
  type PanoSourceSize,
  type StereoPointCloud,
} from "./api";
import { bodyTupleToThreeAligned } from "./coords";
import {
  buildMissionHighlightTour,
  parseTourFromUrl,
  type Tour,
  type TourStep,
} from "./tours";

type ViewMode = "path" | "stop" | "site";

const LAYER_OPTIONS = [
  { id: "NAVCAM", match: (s: string) => s.includes("NAVCAM") },
  { id: "MCZ", match: (s: string) => s.includes("MCZ") },
  { id: "HAZCAM", match: (s: string) => s.includes("HAZCAM") },
  { id: "OTHER", match: (s: string) => !/(NAVCAM|MCZ|HAZCAM)/.test(s) },
];

export default function App() {
  const [health, setHealth] = useState<string>("");
  const [stops, setStops] = useState<Stop[]>([]);
  const [stats, setStats] = useState<string>("");
  const [filter, setFilter] = useState("");
  const [viewMode, setViewMode] = useState<ViewMode>("path");
  const [selectedStop, setSelectedStop] = useState<Stop | null>(null);
  const [cameras, setCameras] = useState<Camera[]>([]);
  const [selected, setSelected] = useState<Camera | null>(null);
  const [detail, setDetail] = useState<Camera | null>(null);
  const [layers, setLayers] = useState<Record<string, boolean>>({
    NAVCAM: true,
    MCZ: true,
    HAZCAM: true,
    OTHER: false,
  });
  const [showRays, setShowRays] = useState(true);
  const [showFrustums, setShowFrustums] = useState(false);
  /** FOV-matched image planes at camera poses for this stop */
  const [showPhotoWorld, setShowPhotoWorld] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flyToken, setFlyToken] = useState(0);
  const [flyTo, setFlyTo] = useState<Camera | null>(null);

  // Timeline: progressive reveal up to solCursor within stop sol range
  const [solCursor, setSolCursor] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const playRef = useRef<number | null>(null);

  // Stereo pairs
  const [pairs, setPairs] = useState<StereoPair[]>([]);
  const [selectedPair, setSelectedPair] = useState<StereoPair | null>(null);
  const [pairsLoading, setPairsLoading] = useState(false);

  // First-person rover eye view
  const [eyeMode, setEyeMode] = useState(false);
  // Pose-stitched site panorama
  const [panoMode, setPanoMode] = useState(false);
  const [panoLoading, setPanoLoading] = useState(false);
  const [panoMeta, setPanoMeta] = useState<string | null>(null);
  const [panoError, setPanoError] = useState<string | null>(null);
  const [panoSrc, setPanoSrc] = useState<string | null>(null);
  const [panoSize, setPanoSize] = useState<PanoSourceSize>("medium");

  // NASA MMGIS map localization
  const [waypoints, setWaypoints] = useState<MapWaypoint[]>([]);
  const [mapAvailable, setMapAvailable] = useState(false);
  const [mapStats, setMapStats] = useState("");
  const [posedOnlyStops, setPosedOnlyStops] = useState(true);
  // CTX covers full Jezero traverse; HiRISE is higher-res but only near landing
  const [basemapLayer, setBasemapLayer] = useState<"ctx" | "hirise" | "hrsc" | "base">(
    "ctx"
  );
  const [showBasemap, setShowBasemap] = useState(true);
  const [depthPreview, setDepthPreview] = useState<string | null>(null);
  const [depthMeta, setDepthMeta] = useState<string | null>(null);
  const [depthLoading, setDepthLoading] = useState(false);
  const [pointCloud, setPointCloud] = useState<StereoPointCloud | null>(null);
  const [showPointCloud, setShowPointCloud] = useState(true);
  // Site-scale multi-drive world
  const [siteDrives, setSiteDrives] = useState<SiteDrive[]>([]);
  const [siteCameras, setSiteCameras] = useState<Camera[]>([]);
  const [siteOriginE, setSiteOriginE] = useState<number | null>(null);
  const [siteOriginN, setSiteOriginN] = useState<number | null>(null);
  const [siteLoading, setSiteLoading] = useState(false);
  const [siteNote, setSiteNote] = useState<string | null>(null);
  // Guided tour
  const [activeTour, setActiveTour] = useState<Tour | null>(null);
  const [tourStep, setTourStep] = useState(0);
  const [tourPlaying, setTourPlaying] = useState(false);
  const tourTimer = useRef<number | null>(null);
  const applyTourStepRef = useRef<(step: TourStep) => void>(() => {});
  const bootstrapped = useRef(false);
  const pendingTour = useRef<{ tourId: string; step: number } | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const h = await fetchHealth();
        if (!h.index) {
          setHealth(h.hint || "Index not built");
          return;
        }
        const gpu = (h as { gpu?: { cuda?: boolean; name?: string; vram_mb?: number } })
          .gpu;
        const gpuTxt =
          gpu?.cuda && gpu.name
            ? ` · GPU ${gpu.name}${gpu.vram_mb ? ` ${gpu.vram_mb}MB` : ""}`
            : "";
        setHealth(
          `Index ready · ${h.n_images?.toLocaleString() ?? "?"} images${gpuTxt}`
        );
        const [s, st] = await Promise.all([fetchStops(), fetchStats()]);
        // Chronological path order
        const ordered = [...s.stops].sort((a, b) => {
          const sa = a.sol_min ?? 1e9;
          const sb = b.sol_min ?? 1e9;
          if (sa !== sb) return sa - sb;
          return (a.site ?? 0) - (b.site ?? 0) || (a.drive ?? 0) - (b.drive ?? 0);
        });
        setStops(ordered);
        setStats(
          `${st.n_stops} stops · ${st.n_posed.toLocaleString()} posed / ${st.n_images.toLocaleString()} images · sols ${st.sol_min ?? "?"}–${st.sol_max ?? "?"}`
        );

        // Deep link: ?view=path|stop&site=&drive=&image=
        const params = new URLSearchParams(window.location.search);
        const viewParam = params.get("view");
        const siteParam = params.get("site");
        const driveParam = params.get("drive");
        const imageParam = params.get("image");
        const tourFromUrl = parseTourFromUrl();
        if (tourFromUrl) pendingTour.current = tourFromUrl;
        let resolved: Stop | null = null;
        if (siteParam != null && driveParam != null) {
          const site = Number(siteParam);
          const drive = Number(driveParam);
          resolved =
            ordered.find((x) => x.site === site && x.drive === drive) ?? null;
        }
        if (!resolved) {
          resolved =
            [...ordered].sort((a, b) => b.n_posed - a.n_posed)[0] ?? null;
        }
        if (resolved) setSelectedStop(resolved);
        if (viewParam === "stop" && resolved) {
          setViewMode("stop");
        } else if (viewParam === "site" && resolved?.site != null) {
          setViewMode("site");
        } else {
          setViewMode("path");
        }
        if (imageParam && resolved) {
          // Cameras load when stop view opens; stash imageid for later select
          (window as unknown as { __percyPendingImage?: string }).__percyPendingImage =
            imageParam;
        }
        bootstrapped.current = true;
        // Resume deep-linked tour once stops are ready
        if (tourFromUrl?.tourId === "mission-highlights") {
          const tour = buildMissionHighlightTour(ordered);
          setActiveTour(tour);
          setTourStep(
            Math.min(tourFromUrl.step, Math.max(0, tour.steps.length - 1))
          );
        }

        try {
          const m = await fetchMap();
          setMapAvailable(m.available);
          setWaypoints(m.waypoints || []);
          const cur = m.current;
          setMapStats(
            m.available
              ? `Map: ${m.n_waypoints} waypoints · ${m.n_stops_with_map}/${m.n_stops} stops joined` +
                  (cur?.sol != null ? ` · rover sol ${cur.sol}` : "") +
                  (cur?.dist_total_m != null
                    ? ` · ${(cur.dist_total_m / 1000).toFixed(1)} km`
                    : "")
              : "Map: not loaded (run python -m playground.pipeline.fetch_mmgis)"
          );
        } catch {
          setMapAvailable(false);
          setMapStats("Map: unavailable");
        }
      } catch (e) {
        setError(String(e));
      }
    })();
  }, []);

  // Keep URL in sync for shareable deep links
  useEffect(() => {
    if (!bootstrapped.current) return;
    const params = new URLSearchParams();
    params.set("view", viewMode);
    if (selectedStop?.site != null) params.set("site", String(selectedStop.site));
    if (selectedStop?.drive != null) params.set("drive", String(selectedStop.drive));
    if (selected?.imageid) params.set("image", selected.imageid);
    if (activeTour) {
      params.set("tour", activeTour.id);
      params.set("step", String(tourStep));
    }
    const qs = params.toString();
    const next = `${window.location.pathname}?${qs}`;
    if (next !== `${window.location.pathname}${window.location.search}`) {
      window.history.replaceState(null, "", next);
    }
  }, [viewMode, selectedStop, selected, activeTour, tourStep]);

  useEffect(() => {
    if (viewMode !== "stop") return;
    if (!selectedStop || selectedStop.site == null || selectedStop.drive == null) return;
    setLoading(true);
    setError(null);
    setSelected(null);
    setDetail(null);
    setFlyTo(null);
    setPlaying(false);
    setSelectedPair(null);
    setPairs([]);
    setPointCloud(null);
    setDepthPreview(null);
    setDepthMeta(null);
    setEyeMode(false);
    fetchCameras(selectedStop.site, selectedStop.drive)
      .then((r) => {
        setCameras(r.cameras);
        const sols = r.cameras
          .map((c) => c.sol)
          .filter((s): s is number => s != null);
        if (sols.length) {
          setSolCursor(Math.max(...sols));
        } else {
          setSolCursor(selectedStop.sol_max ?? null);
        }
        // Deep-link / tour image select
        const pending = (window as unknown as { __percyPendingImage?: string })
          .__percyPendingImage;
        if (pending) {
          const hit = r.cameras.find((c) => c.imageid === pending);
          if (hit) {
            setSelected(hit);
            setFlyTo(hit);
            setFlyToken((t) => t + 1);
            const wantEye = (window as unknown as { __percyPendingEye?: boolean })
              .__percyPendingEye;
            if (wantEye) {
              setEyeMode(true);
              delete (window as unknown as { __percyPendingEye?: boolean })
                .__percyPendingEye;
            }
          }
          delete (window as unknown as { __percyPendingImage?: string })
            .__percyPendingImage;
        }
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));

    setPairsLoading(true);
    fetchStereoPairs(selectedStop.site, selectedStop.drive, { max_pairs: 100 })
      .then((r) => setPairs(r.pairs))
      .catch(() => setPairs([]))
      .finally(() => setPairsLoading(false));
  }, [selectedStop, viewMode]);

  // Site-scale multi-drive world
  useEffect(() => {
    if (viewMode !== "site") return;
    if (selectedStop?.site == null) return;
    const site = selectedStop.site;
    setSiteLoading(true);
    setError(null);
    setEyeMode(false);
    setPanoMode(false);
    setSelected(null);
    setDetail(null);
    fetchSiteWorld(site, { max_drives: 24, max_per_drive: 80, max_total: 1000 })
      .then((r) => {
        setSiteDrives(r.drives || []);
        setSiteCameras(r.cameras || []);
        setSiteOriginE(r.origin_easting);
        setSiteOriginN(r.origin_northing);
        setSiteNote(
          `site ${r.site} · ${r.n_drives} drives (${r.n_drives_mapped} mapped) · ` +
            `${r.returned}/${r.total_cameras} cams` +
            (r.note ? ` · ${r.note}` : "")
        );
      })
      .catch((e) => {
        setError(String(e));
        setSiteDrives([]);
        setSiteCameras([]);
        setSiteNote(null);
      })
      .finally(() => setSiteLoading(false));
  }, [viewMode, selectedStop?.site]);

  const solRange = useMemo(() => {
    const sols = cameras
      .map((c) => c.sol)
      .filter((s): s is number => s != null);
    if (!sols.length) {
      return {
        min: selectedStop?.sol_min ?? 0,
        max: selectedStop?.sol_max ?? 0,
      };
    }
    return { min: Math.min(...sols), max: Math.max(...sols) };
  }, [cameras, selectedStop]);

  // Playback along sol cursor
  useEffect(() => {
    if (!playing) {
      if (playRef.current) window.clearInterval(playRef.current);
      playRef.current = null;
      return;
    }
    playRef.current = window.setInterval(() => {
      setSolCursor((cur) => {
        const c = cur ?? solRange.min;
        if (c >= solRange.max) {
          setPlaying(false);
          return solRange.max;
        }
        return Math.min(solRange.max, c + 1);
      });
    }, 700);
    return () => {
      if (playRef.current) window.clearInterval(playRef.current);
    };
  }, [playing, solRange.min, solRange.max]);

  const filteredStops = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const tokens = q.split(/[\s,;/]+/).filter(Boolean);
    return stops
      .filter((s) => {
        if (posedOnlyStops && (s.n_posed ?? 0) <= 0) return false;
        if (!tokens.length) return true;
        const hay = [
          s.stop_id,
          s.site,
          s.drive,
          s.sol_min,
          s.sol_max,
          s.rmc,
        ]
          .map((x) => String(x ?? "").toLowerCase())
          .join(" ");
        // All tokens must match; "9 0" or "site 9 drive 0" work
        return tokens.every((t) => hay.includes(t));
      })
      .slice(0, 500);
  }, [stops, filter, posedOnlyStops]);

  const visibleCameras = useMemo(() => {
    return cameras.filter((c) => {
      const inst = c.instrument || "";
      const layerOk = LAYER_OPTIONS.some((l) => layers[l.id] && l.match(inst));
      if (!layerOk) return false;
      if (solCursor != null && c.sol != null && c.sol > solCursor) return false;
      return c.has_pose && c.pos_x != null;
    });
  }, [cameras, layers, solCursor]);

  const solHistogram = useMemo(() => {
    const map = new Map<number, number>();
    for (const c of cameras) {
      if (c.sol == null || !c.has_pose) continue;
      const inst = c.instrument || "";
      if (!LAYER_OPTIONS.some((l) => layers[l.id] && l.match(inst))) continue;
      map.set(c.sol, (map.get(c.sol) || 0) + 1);
    }
    return map;
  }, [cameras, layers]);

  const frameToken = `${selectedStop?.stop_id ?? "none"}:${cameras.length}`;

  const visiblePairs = useMemo(() => {
    if (solCursor == null) return pairs;
    return pairs.filter((p) => p.sol == null || p.sol <= solCursor);
  }, [pairs, solCursor]);

  const pairIds = useMemo(() => {
    const s = new Set<string>();
    if (!selectedPair) return s;
    s.add(selectedPair.left_imageid);
    s.add(selectedPair.right_imageid);
    return s;
  }, [selectedPair]);

  const pairBaseline = useMemo(() => {
    if (!selectedPair?.left_pos || !selectedPair?.right_pos) return null;
    // Same body→GLB mapping / mast hardpoints as Scene rays
    return [
      bodyTupleToThreeAligned(
        selectedPair.left_pos,
        selectedPair.left_instrument
      ),
      bodyTupleToThreeAligned(
        selectedPair.right_pos,
        selectedPair.right_instrument
      ),
    ] as [[number, number, number], [number, number, number]];
  }, [selectedPair]);

  const eyePlaylist = useMemo(() => {
    // Chronological list of currently visible posed cameras for next/prev
    return [...visibleCameras].sort((a, b) => {
      const sa = a.sol ?? 0;
      const sb = b.sol ?? 0;
      if (sa !== sb) return sa - sb;
      return String(a.imageid).localeCompare(String(b.imageid));
    });
  }, [visibleCameras]);

  const eyeIndex = useMemo(() => {
    if (!selected) return -1;
    return eyePlaylist.findIndex((c) => c.imageid === selected.imageid);
  }, [eyePlaylist, selected]);

  async function onSelectCamera(c: Camera, fly = false, enterEye = false) {
    setSelected(c);
    // If this camera belongs to a pair, select that pair
    const hit = pairs.find(
      (p) => p.left_imageid === c.imageid || p.right_imageid === c.imageid
    );
    if (hit) setSelectedPair(hit);
    if (fly && !enterEye) {
      setFlyTo(c);
      setFlyToken((t) => t + 1);
    }
    if (enterEye) setEyeMode(true);
    try {
      const d = await fetchImage(c.imageid);
      setDetail(d as Camera);
    } catch {
      setDetail(c);
    }
  }

  function enterEyeView() {
    if (!selected || selected.pos_x == null) return;
    setEyeMode(true);
  }

  function eyeStep(delta: number) {
    if (eyePlaylist.length === 0) return;
    let idx = eyeIndex;
    if (idx < 0) idx = 0;
    const next = Math.max(0, Math.min(eyePlaylist.length - 1, idx + delta));
    const cam = eyePlaylist[next];
    if (cam) onSelectCamera(cam, false, true);
  }

  function onSelectPair(p: StereoPair) {
    setSelectedPair(p);
    setPointCloud(null);
    setDepthPreview(null);
    setDepthMeta(null);
    const left = cameras.find((c) => c.imageid === p.left_imageid);
    const right = cameras.find((c) => c.imageid === p.right_imageid);
    const cam = left || right;
    if (cam) {
      setSelected(cam);
      setFlyTo(cam);
      setFlyToken((t) => t + 1);
      fetchImage(cam.imageid)
        .then((d) => setDetail(d as Camera))
        .catch(() => setDetail(cam));
    }
  }

  function exportPairsJson() {
    const blob = new Blob([JSON.stringify({ pairs: visiblePairs }, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `stereo-pairs-${selectedStop?.stop_id ?? "stop"}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function flyToSelected() {
    // Animate the stop-view orbit camera behind the selected camera pose
    // and aim along its look vector (see Scene CameraController).
    if (!selected || selected.pos_x == null) return;
    setEyeMode(false);
    setPanoMode(false);
    setFlyTo(selected);
    setFlyToken((t) => t + 1);
  }

  function selectStop(s: Stop, enterStop = true) {
    setSelectedStop(s);
    setDepthPreview(null);
    setDepthMeta(null);
    setPanoMode(false);
    setPanoSrc(null);
    setPanoError(null);
    if (enterStop) setViewMode("stop");
  }

  function openMissionPath() {
    setViewMode("path");
    setPlaying(false);
    setEyeMode(false);
    setPanoMode(false);
  }

  function openSiteWorld() {
    if (selectedStop?.site == null) return;
    setPlaying(false);
    setEyeMode(false);
    setPanoMode(false);
    setViewMode("site");
  }

  function resolveStop(site?: number | null, drive?: number | null): Stop | null {
    if (site == null) return null;
    if (drive != null) {
      return stops.find((s) => s.site === site && s.drive === drive) ?? null;
    }
    return stops.find((s) => s.site === site) ?? null;
  }

  function applyTourStep(step: TourStep) {
    setEyeMode(false);
    setPanoMode(false);
    setPlaying(false);
    if (step.type === "path") {
      setViewMode("path");
      const hit = resolveStop(step.site, step.drive);
      if (hit) setSelectedStop(hit);
      return;
    }
    if (step.type === "site") {
      const hit = resolveStop(step.site, step.drive);
      if (hit) setSelectedStop(hit);
      setViewMode("site");
      return;
    }
    // stop | camera | eye | pano
    const hit = resolveStop(step.site, step.drive);
    if (hit) {
      setSelectedStop(hit);
      setViewMode("stop");
    }
    if (step.imageid) {
      (window as unknown as { __percyPendingImage?: string }).__percyPendingImage =
        step.imageid;
      // If cameras already loaded for this stop, select immediately
      const cam = cameras.find((c) => c.imageid === step.imageid);
      if (cam) {
        setSelected(cam);
        setFlyTo(cam);
        setFlyToken((t) => t + 1);
        if (step.type === "eye") setEyeMode(true);
      } else if (step.type === "eye") {
        // eye after cameras load
        (window as unknown as { __percyPendingEye?: boolean }).__percyPendingEye =
          true;
      }
    }
    if (step.type === "pano" && hit?.site != null && hit.drive != null) {
      // fire-and-forget pano open
      void openSitePano(panoSize);
    }
  }
  applyTourStepRef.current = applyTourStep;

  function startMissionTour() {
    const tour = buildMissionHighlightTour(stops.length ? stops : pathStops);
    setActiveTour(tour);
    setTourStep(0);
    setTourPlaying(false);
    applyTourStep(tour.steps[0]);
  }

  function exitTour() {
    setActiveTour(null);
    setTourPlaying(false);
    setTourStep(0);
    if (tourTimer.current) {
      window.clearTimeout(tourTimer.current);
      tourTimer.current = null;
    }
  }

  function goTourStep(next: number) {
    if (!activeTour) return;
    const i = Math.max(0, Math.min(activeTour.steps.length - 1, next));
    setTourStep(i);
    applyTourStep(activeTour.steps[i]);
  }

  // Apply step when tour starts / step changes from deep link after bootstrap
  useEffect(() => {
    if (!activeTour || !bootstrapped.current) return;
    const step = activeTour.steps[tourStep];
    if (step) applyTourStepRef.current(step);
    // only re-apply when tour id or step index changes externally
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTour?.id, tourStep]);

  // Auto-advance when tour is playing
  useEffect(() => {
    if (!activeTour || !tourPlaying) {
      if (tourTimer.current) {
        window.clearTimeout(tourTimer.current);
        tourTimer.current = null;
      }
      return;
    }
    const step = activeTour.steps[tourStep];
    const dwell = step?.dwellMs && step.dwellMs > 0 ? step.dwellMs : 4500;
    tourTimer.current = window.setTimeout(() => {
      if (tourStep >= activeTour.steps.length - 1) {
        setTourPlaying(false);
        return;
      }
      goTourStep(tourStep + 1);
    }, dwell);
    return () => {
      if (tourTimer.current) window.clearTimeout(tourTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTour, tourPlaying, tourStep]);

  // Keyboard for tour
  useEffect(() => {
    if (!activeTour) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        exitTour();
      } else if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        e.preventDefault();
        goTourStep(tourStep + 1);
      } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        e.preventDefault();
        goTourStep(tourStep - 1);
      } else if (e.key === " " || e.code === "Space") {
        e.preventDefault();
        setTourPlaying((p) => !p);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTour, tourStep]);

  async function openSitePano(size: PanoSourceSize = panoSize) {
    if (!selectedStop || selectedStop.site == null || selectedStop.drive == null) {
      return;
    }
    setPanoLoading(true);
    setPanoError(null);
    setPanoMeta(null);
    try {
      const site = selectedStop.site;
      const drive = selectedStop.drive;
      // Higher source tiers → wider output for detail
      const outW =
        size === "full" ? 8192 : size === "large" ? 6144 : size === "medium" ? 4096 : 3072;
      const maxFrames = size === "full" || size === "large" ? 32 : 40;
      const meta = await fetchPanoMeta(site, drive, {
        max_frames: maxFrames,
        out_width: outW,
        size,
      });
      setPanoMeta(
        `${meta.n_frames} frames · ${size}` +
          (meta.source_max_side ? `≤${meta.source_max_side}px` : "") +
          ` · az ${meta.az_span_deg.toFixed(0)}° · ${meta.elapsed_ms.toFixed(0)} ms`
      );
      setPanoSrc(
        panoUrl(site, drive, { max_frames: maxFrames, out_width: outW, size }) +
          `&t=${meta.n_frames}-${size}`
      );
      setPanoMode(true);
      setEyeMode(false);
    } catch (e) {
      setPanoError(String(e));
    } finally {
      setPanoLoading(false);
    }
  }

  async function runStereoDepth() {
    if (!selectedPair || selectedStop?.site == null || selectedStop?.drive == null) {
      return;
    }
    setDepthLoading(true);
    setDepthPreview(null);
    setDepthMeta(null);
    setPointCloud(null);
    try {
      const r = await fetchStereoDepth(
        selectedStop.site,
        selectedStop.drive,
        selectedPair.id,
        { pointCloud: true, maxPoints: 20000, size: "small" }
      );
      setDepthPreview(r.preview_data_url);
      const st = r.stats || {};
      const cloud = r.point_cloud ?? null;
      setPointCloud(cloud);
      setShowPointCloud(true);
      const nPts = cloud?.n ?? 0;
      const frame = cloud?.frame ?? "?";
      setDepthMeta(
        `disparity valid ${(100 * (st.valid_frac ?? 0)).toFixed(0)}% · ` +
          `median ${st.disp_median != null ? Number(st.disp_median).toFixed(1) : "?"} px` +
          (r.approx_depth_m_median != null
            ? ` · ~${Number(r.approx_depth_m_median).toFixed(1)} m (rough)`
            : "") +
          (nPts > 0 ? ` · cloud ${nPts.toLocaleString()} pts (${frame})` : " · no cloud") +
          (r.backend ? ` · ${r.backend}` : "") +
          (r.device ? ` @ ${r.device}` : "") +
          (r.elapsed_ms != null ? ` · ${Number(r.elapsed_ms).toFixed(0)} ms` : "")
      );
    } catch (e) {
      setDepthMeta(String(e));
      setPointCloud(null);
    } finally {
      setDepthLoading(false);
    }
  }

  const pathStops = useMemo(() => stops.slice(0, 200), [stops]);

  return (
    <div className="app">
      <aside className="panel">
        <h1>Percy Metadata Playground</h1>
        <div className="toolbar">
          <div className="muted">{health || "Connecting…"}</div>
          <div className="muted">{stats}</div>
          <div className="muted">{mapStats}</div>
          <div className="view-toggle">
            <button
              type="button"
              className={viewMode === "path" ? "active" : ""}
              onClick={openMissionPath}
            >
              Mission path
            </button>
            <button
              type="button"
              className={viewMode === "stop" ? "active" : ""}
              disabled={!selectedStop}
              onClick={() => selectedStop && setViewMode("stop")}
            >
              Stop cameras
            </button>
            <button
              type="button"
              className={viewMode === "site" ? "active" : ""}
              disabled={selectedStop?.site == null}
              onClick={openSiteWorld}
              title="All drives at this site in shared EN frame"
            >
              Site world
            </button>
            <button
              type="button"
              className={activeTour ? "active" : ""}
              disabled={!stops.length}
              onClick={() => (activeTour ? exitTour() : startMissionTour())}
              title="Guided sol-ordered tour with shareable deep links"
            >
              {activeTour ? "Exit tour" : "Guided tour"}
            </button>
          </div>
          <input
            placeholder="Search stops: site drive sol  ·  e.g. 9 0"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <label className="inline-check">
            <input
              type="checkbox"
              checked={posedOnlyStops}
              onChange={(e) => setPosedOnlyStops(e.target.checked)}
            />
            Posed only
          </label>
          {viewMode === "stop" && (
            <>
              <div className="layers">
                {LAYER_OPTIONS.map((l) => (
                  <label key={l.id}>
                    <input
                      type="checkbox"
                      checked={!!layers[l.id]}
                      onChange={(e) =>
                        setLayers((prev) => ({ ...prev, [l.id]: e.target.checked }))
                      }
                    />
                    {l.id}
                  </label>
                ))}
                <label>
                  <input
                    type="checkbox"
                    checked={showPhotoWorld}
                    onChange={(e) => setShowPhotoWorld(e.target.checked)}
                  />
                  Photo world
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={showRays}
                    onChange={(e) => setShowRays(e.target.checked)}
                  />
                  Rays
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={showFrustums}
                    onChange={(e) => setShowFrustums(e.target.checked)}
                  />
                  Frustums
                </label>
                <label title="Stereo body-frame cloud from depth on selected pair">
                  <input
                    type="checkbox"
                    checked={showPointCloud}
                    disabled={!pointCloud}
                    onChange={(e) => setShowPointCloud(e.target.checked)}
                  />
                  Point cloud
                  {pointCloud ? ` (${pointCloud.n.toLocaleString()})` : ""}
                </label>
              </div>

              <h2 style={{ margin: "4px 0 0" }}>Sol timeline</h2>
              <div className="timeline">
                <div className="timeline-meta">
                  <span>
                    sol {solCursor ?? "—"} / {solRange.max || "—"}
                  </span>
                  <span className="muted">
                    showing {visibleCameras.length} / {cameras.length}
                  </span>
                </div>
                <input
                  type="range"
                  min={solRange.min}
                  max={Math.max(solRange.min, solRange.max)}
                  step={1}
                  value={solCursor ?? solRange.min}
                  disabled={!cameras.length}
                  onChange={(e) => {
                    setPlaying(false);
                    setSolCursor(Number(e.target.value));
                  }}
                />
                <div
                  className="timeline-hist"
                  title="Posed cameras per sol (active layers)"
                >
                  {Array.from(
                    { length: Math.max(1, solRange.max - solRange.min + 1) },
                    (_, i) => {
                      const sol = solRange.min + i;
                      const n = solHistogram.get(sol) || 0;
                      const maxN = Math.max(1, ...solHistogram.values());
                      const h = Math.round((n / maxN) * 100);
                      const active = solCursor != null && sol <= solCursor;
                      return (
                        <div
                          key={sol}
                          className={"hist-bar" + (active ? " on" : "")}
                          style={{ height: `${Math.max(n ? 8 : 2, h)}%` }}
                          title={`sol ${sol}: ${n}`}
                        />
                      );
                    }
                  )}
                </div>
                <div className="timeline-actions">
                  <button type="button" onClick={() => setSolCursor(solRange.min)}>
                    Start
                  </button>
                  <button
                    type="button"
                    onClick={() => setPlaying((p) => !p)}
                    disabled={!cameras.length}
                  >
                    {playing ? "Pause" : "Play"}
                  </button>
                  <button type="button" onClick={() => setSolCursor(solRange.max)}>
                    End
                  </button>
                </div>
              </div>
            </>
          )}
          {viewMode === "path" && (
            <div className="empty" style={{ padding: "8px 0" }}>
              {mapAvailable ? (
                <>
                  Real Jezero traverse (MMGIS) with{" "}
                  <a
                    href="https://maps.planet.fu-berlin.de/jezero/"
                    target="_blank"
                    rel="noreferrer"
                  >
                    FU Berlin
                  </a>{" "}
                  orbital basemap. Click = place rover; <strong>double-click</strong>{" "}
                  = cameras.
                  <div className="basemap-controls">
                    <label className="inline-check">
                      <input
                        type="checkbox"
                        checked={showBasemap}
                        onChange={(e) => setShowBasemap(e.target.checked)}
                      />
                      Orbital basemap
                    </label>
                    <select
                      value={basemapLayer}
                      disabled={!showBasemap}
                      onChange={(e) =>
                        setBasemapLayer(
                          e.target.value as "ctx" | "hirise" | "hrsc" | "base"
                        )
                      }
                      title="FU Berlin WMS layer — CTX covers full route; HiRISE is partial"
                    >
                      <option value="ctx">CTX (full route)</option>
                      <option value="hrsc">HRSC (wide region)</option>
                      <option value="hirise">HiRISE (landing only)</option>
                      <option value="base">Base HSV</option>
                    </select>
                  </div>
                </>
              ) : (
                <>
                  Schematic path (map missing — run{" "}
                  <code>python -m playground.pipeline.fetch_mmgis</code>). Each
                  node is a <strong>(site, drive)</strong> stop ordered by sol.
                </>
              )}
            </div>
          )}
        </div>
        {viewMode === "stop" && (
          <>
            <h2>
              Stereo pairs{" "}
              <span className="muted">
                {pairsLoading ? "…" : `${visiblePairs.length}/${pairs.length}`}
              </span>
            </h2>
            <div className="pair-list">
              {pairsLoading && <div className="empty">Matching L/R pairs…</div>}
              {!pairsLoading && visiblePairs.length === 0 && (
                <div className="empty">
                  No stereo pairs for this stop / sol range.
                </div>
              )}
              {visiblePairs.slice(0, 40).map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={
                    "pair-item" + (selectedPair?.id === p.id ? " active" : "")
                  }
                  onClick={() => onSelectPair(p)}
                >
                  <div className="title">
                    {p.family} · sol {p.sol ?? "?"} · score {p.score.toFixed(0)}
                  </div>
                  <div className="meta">
                    baseline{" "}
                    {p.baseline_m != null ? `${p.baseline_m.toFixed(3)} m` : "?"} ·
                    Δt {p.dt_sclk != null ? `${p.dt_sclk.toFixed(1)}s` : "?"} · look
                    Δ{" "}
                    {p.look_angle_deg != null
                      ? `${p.look_angle_deg.toFixed(1)}°`
                      : "?"}
                  </div>
                </button>
              ))}
              {pairs.length > 0 && (
                <button
                  type="button"
                  className="export-btn"
                  onClick={exportPairsJson}
                >
                  Export pairs JSON
                </button>
              )}
              {selectedPair && (
                <button
                  type="button"
                  className="export-btn"
                  disabled={depthLoading}
                  onClick={runStereoDepth}
                >
                  {depthLoading
                    ? "Computing depth + cloud…"
                    : "Stereo depth + 3D cloud"}
                </button>
              )}
              {pointCloud && (
                <button
                  type="button"
                  className="export-btn"
                  onClick={() => setShowPointCloud((v) => !v)}
                >
                  {showPointCloud ? "Hide point cloud" : "Show point cloud"} (
                  {pointCloud.n.toLocaleString()} pts)
                </button>
              )}
              {depthMeta && <div className="muted depth-meta">{depthMeta}</div>}
              {depthPreview && (
                <img
                  className="depth-preview"
                  src={depthPreview}
                  alt="Disparity preview"
                />
              )}
            </div>
          </>
        )}

        <h2>Stops</h2>
        <div className="stop-list">
          {filteredStops.length === 0 && (
            <div className="empty">
              No stops loaded. Build the index:
              <br />
              <code>python -m playground.pipeline.build_index</code>
            </div>
          )}
          {filteredStops.map((s) => (
            <button
              key={s.stop_id}
              className={
                "stop-item" +
                (selectedStop?.stop_id === s.stop_id ? " active" : "")
              }
              onClick={() => selectStop(s)}
            >
              <div className="title">
                site {s.site} · drive {s.drive}
              </div>
              <div className="meta">
                sols {s.sol_min ?? "?"}–{s.sol_max ?? "?"} · {s.n_posed}/{s.n_images}{" "}
                posed · MCZ {s.n_mcz} · NAV {s.n_navcam}
              </div>
            </button>
          ))}
        </div>
      </aside>

      <main className="viewport">
        {error && <div className="status-banner">{error}</div>}
        {loading && viewMode === "stop" && (
          <div className="status-banner">Loading cameras…</div>
        )}
        {siteLoading && viewMode === "site" && (
          <div className="status-banner">Loading site multi-drive world…</div>
        )}
        {activeTour && activeTour.steps[tourStep] && (
          <TourOverlay
            tour={activeTour}
            stepIndex={tourStep}
            step={activeTour.steps[tourStep]}
            playing={tourPlaying}
            onPrev={() => goTourStep(tourStep - 1)}
            onNext={() => goTourStep(tourStep + 1)}
            onTogglePlay={() => setTourPlaying((p) => !p)}
            onClose={exitTour}
            onJump={(i) => goTourStep(i)}
          />
        )}
        {viewMode === "path" ? (
          <MissionPath
            stops={filteredStops.length ? filteredStops : stops}
            waypoints={waypoints}
            mapAvailable={mapAvailable}
            selectedStopId={selectedStop?.stop_id ?? null}
            onSelectStop={(s) => selectStop(s, false)}
            onOpenStop={(s) => selectStop(s, true)}
            showBasemap={showBasemap}
            basemapLayer={basemapLayer}
          />
        ) : viewMode === "site" ? (
          <>
            <SiteScene
              site={selectedStop?.site ?? 0}
              drives={siteDrives}
              cameras={siteCameras}
              originEasting={siteOriginE}
              originNorthing={siteOriginN}
              selectedId={selected?.imageid ?? null}
              focusDrive={selectedStop?.drive ?? null}
              onSelect={(c) => {
                setSelected(c);
                fetchImage(c.imageid)
                  .then((d) => setDetail(d as Camera))
                  .catch(() => setDetail(c));
                // Sync selected stop to this drive when possible
                if (c.site != null && c.drive != null) {
                  const hit = stops.find(
                    (s) => s.site === c.site && s.drive === c.drive
                  );
                  if (hit) setSelectedStop(hit);
                }
              }}
              showPhotoWorld={showPhotoWorld}
              showRays={showRays}
              maxPlanes={60}
            />
            <div className="hud">
              {siteNote ??
                (selectedStop
                  ? `Site ${selectedStop.site} multi-drive world`
                  : "Select a stop to open its site")}
              <div className="muted">
                Shared EN frame (X east, Y up, Z −north) · body poses + MMGIS
                anchors ·{" "}
                <button type="button" className="linkish" onClick={openMissionPath}>
                  ← Mission path
                </button>
                {" · "}
                <button
                  type="button"
                  className="linkish"
                  disabled={!selectedStop}
                  onClick={() => selectedStop && setViewMode("stop")}
                >
                  Stop cameras
                </button>
                {selected && (
                  <>
                    {" · "}
                    <button
                      type="button"
                      className="linkish"
                      onClick={() => selectedStop && setViewMode("stop")}
                    >
                      Open drive {selected.drive} body frame
                    </button>
                  </>
                )}
              </div>
            </div>
          </>
        ) : panoMode && panoSrc ? (
          <PanoView
            imageUrl={panoSrc}
            title={
              selectedStop
                ? `Pano · site ${selectedStop.site} / drive ${selectedStop.drive}`
                : "Site panorama"
            }
            meta={panoMeta ?? undefined}
            onClose={() => setPanoMode(false)}
          />
        ) : eyeMode && selected && selected.pos_x != null ? (
          <EyeView
            camera={selected}
            imageSize="medium"
            onClose={() => setEyeMode(false)}
            onPrev={() => eyeStep(-1)}
            onNext={() => eyeStep(1)}
            hasPrev={eyeIndex > 0}
            hasNext={eyeIndex >= 0 && eyeIndex < eyePlaylist.length - 1}
            indexLabel={
              eyeIndex >= 0
                ? `${eyeIndex + 1} / ${eyePlaylist.length}`
                : `1 / ${eyePlaylist.length}`
            }
          />
        ) : (
          <>
            <Scene
              cameras={visibleCameras}
              selectedId={selected?.imageid ?? null}
              onSelect={(c) => onSelectCamera(c, true)}
              showRays={showRays}
              showFrustums={showFrustums}
              showPhotoWorld={showPhotoWorld}
              flyTo={flyTo}
              flyToken={flyToken}
              frameToken={frameToken}
              pairIds={pairIds}
              pairBaseline={pairBaseline}
              roverYawDeg={selectedStop?.yaw_deg ?? null}
              showRover
              pointCloud={pointCloud}
              showPointCloud={showPointCloud}
            />
            {/* Basemap lives in geographic EN; stop 3D is rover body frame — keep map as inset */}
            {mapAvailable && waypoints.length > 0 && showBasemap && (
              <MapInset
                waypoints={waypoints}
                selectedStop={selectedStop}
                basemapLayer={basemapLayer}
                onOpenPath={openMissionPath}
              />
            )}
            <div className="hud">
              {selectedStop
                ? `Stop ${selectedStop.stop_id} · body frame · sol ≤ ${solCursor ?? "?"} · ${visibleCameras.length} cams · ${visiblePairs.length} pairs`
                : "Select a stop"}
              <div className="muted">
                {showPhotoWorld
                  ? "Photo world: image planes at true poses · "
                  : ""}
                Map stays in the corner (body ≠ map coords) ·{" "}
                <button
                  type="button"
                  className="linkish"
                  disabled={!selected || selected.pos_x == null}
                  onClick={enterEyeView}
                >
                  Rover eye view
                </button>
                {" · "}
                <button
                  type="button"
                  className="linkish"
                  disabled={
                    panoLoading ||
                    !selectedStop ||
                    selectedStop.site == null ||
                    selectedStop.drive == null
                  }
                  onClick={() => openSitePano(panoSize)}
                >
                  {panoLoading ? "Stitching pano…" : "Site panorama"}
                </button>
                <select
                  className="pano-size-select"
                  value={panoSize}
                  disabled={panoLoading}
                  title="NASA product size for pano sources"
                  onChange={(e) => setPanoSize(e.target.value as PanoSourceSize)}
                >
                  <option value="small">small (fast)</option>
                  <option value="medium">medium</option>
                  <option value="large">large</option>
                  <option value="full">full (slow / heavy)</option>
                </select>
                {" · "}
                <button type="button" className="linkish" onClick={openMissionPath}>
                  ← Mission path
                </button>
                {" · "}
                <button
                  type="button"
                  className="linkish"
                  disabled={selectedStop?.site == null}
                  onClick={openSiteWorld}
                >
                  Site multi-drive world
                </button>
                {panoError && (
                  <div className="depth-meta" style={{ color: "#f0a0a0" }}>
                    {panoError}
                  </div>
                )}
              </div>
            </div>
          </>
        )}
        <div className="path-strip" title="Mission path (stops ordered by first sol)">
          {pathStops.map((s) => (
            <button
              key={s.stop_id}
              type="button"
              className={
                "path-chip" + (selectedStop?.stop_id === s.stop_id ? " active" : "")
              }
              onClick={() => selectStop(s, true)}
            >
              <span className="path-sol">s{s.sol_min ?? "?"}</span>
              <span>
                {s.site}/{s.drive}
              </span>
              <span className="path-n">{s.n_posed}</span>
            </button>
          ))}
        </div>
      </main>

      <aside className="panel right">
        <h1>Inspector</h1>
        <div className="inspector">
          {!selected && (
            <div className="empty">
              Click a camera point in the 3D view to inspect metadata and image.
              Use <strong>Play</strong> on the sol timeline to reveal coverage over
              time.
            </div>
          )}
          {selectedPair && (
            <div className="stereo-panel">
              <div className="stereo-title">
                Stereo · {selectedPair.family} · sol {selectedPair.sol ?? "?"} ·
                score {selectedPair.score.toFixed(0)}
              </div>
              <div className="stereo-pair">
                <div>
                  <div className="muted">L · {selectedPair.left_instrument}</div>
                  <img
                    src={thumbUrl(selectedPair.left_imageid, "small")}
                    alt={selectedPair.left_imageid}
                  />
                </div>
                <div>
                  <div className="muted">R · {selectedPair.right_instrument}</div>
                  <img
                    src={thumbUrl(selectedPair.right_imageid, "small")}
                    alt={selectedPair.right_imageid}
                  />
                </div>
              </div>
              <div className="meta" style={{ marginTop: 6 }}>
                baseline{" "}
                {selectedPair.baseline_m != null
                  ? `${selectedPair.baseline_m.toFixed(3)} m`
                  : "?"}{" "}
                · Δt{" "}
                {selectedPair.dt_sclk != null
                  ? `${selectedPair.dt_sclk.toFixed(2)} s`
                  : "?"}
              </div>
            </div>
          )}
          {selected && (
            <>
              {!selectedPair && (
                <img
                  key={selected.imageid}
                  src={thumbUrl(selected.imageid, "small")}
                  alt={selected.imageid}
                  onError={(e) => {
                    (e.target as HTMLImageElement).style.opacity = "0.3";
                  }}
                />
              )}
              <div className="inspector-actions">
                <button
                  type="button"
                  onClick={enterEyeView}
                  disabled={selected.pos_x == null}
                  title="First-person view through this image"
                >
                  Rover eye view
                </button>
                <button
                  type="button"
                  onClick={flyToSelected}
                  disabled={selected.pos_x == null}
                  title="Orbit camera to this rover camera's pose and look direction"
                >
                  Fly to camera
                </button>
              </div>
              <dl>
                <dt>imageid</dt>
                <dd>{selected.imageid}</dd>
                <dt>instrument</dt>
                <dd>{detail?.instrument || selected.instrument}</dd>
                <dt>filter</dt>
                <dd>{detail?.filter_name || selected.filter_name}</dd>
                <dt>sol</dt>
                <dd>{selected.sol}</dd>
                <dt>model</dt>
                <dd>
                  {selected.model_type}
                  {selected.model_ok ? " ✓" : ""}
                </dd>
                <dt>FOV</dt>
                <dd>
                  {selected.hfov_deg?.toFixed?.(1) ?? selected.hfov_deg}° ×{" "}
                  {selected.vfov_deg?.toFixed?.(1) ?? selected.vfov_deg}°
                  {selected.basis_source
                    ? ` · ${selected.basis_source}`
                    : ""}
                </dd>
                <dt>position</dt>
                <dd>
                  ({selected.pos_x?.toFixed(3)}, {selected.pos_y?.toFixed(3)},{" "}
                  {selected.pos_z?.toFixed(3)})
                </dd>
                <dt>look</dt>
                <dd>
                  ({fmt3(selected.look_x)}, {fmt3(selected.look_y)},{" "}
                  {fmt3(selected.look_z)})
                </dd>
                <dt>up</dt>
                <dd>
                  ({fmt3(selected.up_x)}, {fmt3(selected.up_y)},{" "}
                  {fmt3(selected.up_z)})
                </dd>
                <dt>attitude</dt>
                <dd>
                  yaw {fmtDeg(selected.yaw_rad)} · pitch{" "}
                  {fmtDeg(selected.pitch_rad)} · roll {fmtDeg(selected.roll_rad)}
                </dd>
                <dt>mast</dt>
                <dd>
                  az {fmt(selected.mast_az)} · el {fmt(selected.mast_el)}
                </dd>
                <dt>title</dt>
                <dd>{detail?.title || selected.title}</dd>
                <dt>caption</dt>
                <dd>{detail?.caption || selected.caption}</dd>
              </dl>
              {(detail?.url_medium || selected.url_medium) && (
                <p className="muted" style={{ marginTop: 12 }}>
                  <a
                    href={detail?.url_medium || selected.url_medium || "#"}
                    target="_blank"
                    rel="noreferrer"
                    style={{ color: "var(--accent2)" }}
                  >
                    Open medium image on NASA
                  </a>
                </p>
              )}
            </>
          )}
        </div>
      </aside>
    </div>
  );
}

function fmt(v: number | null | undefined) {
  if (v == null || Number.isNaN(Number(v))) return "?";
  return Number(v).toFixed(1);
}

function fmt3(v: number | null | undefined) {
  if (v == null || Number.isNaN(Number(v))) return "?";
  return Number(v).toFixed(3);
}

function fmtDeg(rad: number | null | undefined) {
  if (rad == null || Number.isNaN(Number(rad))) return "?";
  return `${((Number(rad) * 180) / Math.PI).toFixed(1)}°`;
}
