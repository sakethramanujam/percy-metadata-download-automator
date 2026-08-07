import { useEffect, useMemo, useRef, useState } from "react";
import Scene from "./Scene";
import MissionPath from "./MissionPath";
import EyeView from "./EyeView";
import {
  Camera,
  MapWaypoint,
  StereoPair,
  Stop,
  fetchCameras,
  fetchHealth,
  fetchImage,
  fetchMap,
  fetchStats,
  fetchStereoPairs,
  fetchStops,
  thumbUrl,
} from "./api";

type ViewMode = "path" | "stop";

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

  // NASA MMGIS map localization
  const [waypoints, setWaypoints] = useState<MapWaypoint[]>([]);
  const [mapAvailable, setMapAvailable] = useState(false);
  const [mapStats, setMapStats] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const h = await fetchHealth();
        if (!h.index) {
          setHealth(h.hint || "Index not built");
          return;
        }
        setHealth(`Index ready · ${h.n_images?.toLocaleString() ?? "?"} images`);
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
        // Start on mission path; densest stop is pre-selected but path view is default
        const best = [...ordered].sort((a, b) => b.n_posed - a.n_posed)[0];
        if (best) setSelectedStop(best);
        setViewMode("path");

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
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));

    setPairsLoading(true);
    fetchStereoPairs(selectedStop.site, selectedStop.drive, { max_pairs: 100 })
      .then((r) => setPairs(r.pairs))
      .catch(() => setPairs([]))
      .finally(() => setPairsLoading(false));
  }, [selectedStop, viewMode]);

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
    return stops
      .filter((s) => {
        if (!q) return true;
        return (
          String(s.stop_id).includes(q) ||
          String(s.site).includes(q) ||
          String(s.sol_min).includes(q) ||
          String(s.sol_max).includes(q)
        );
      })
      .slice(0, 500);
  }, [stops, filter]);

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
    // NASA (x,y,z) → Three (x,z,y)
    const [lx, ly, lz] = selectedPair.left_pos;
    const [rx, ry, rz] = selectedPair.right_pos;
    return [
      [lx, lz, ly] as [number, number, number],
      [rx, rz, ry] as [number, number, number],
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
    if (!selected) return;
    setFlyTo(selected);
    setFlyToken((t) => t + 1);
  }

  function selectStop(s: Stop, enterStop = true) {
    setSelectedStop(s);
    if (enterStop) setViewMode("stop");
  }

  function openMissionPath() {
    setViewMode("path");
    setPlaying(false);
    setEyeMode(false);
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
          </div>
          <input
            placeholder="Filter stops (site, sol, id)"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
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
              Each node is a <strong>(site, drive)</strong> stop ordered by sol.
              Node size ∝ posed images; lateral offset by site.{" "}
              <strong>Not</strong> real Jezero map coordinates.
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
        {viewMode === "path" ? (
          <MissionPath
            stops={filteredStops.length ? filteredStops : stops}
            waypoints={waypoints}
            mapAvailable={mapAvailable}
            selectedStopId={selectedStop?.stop_id ?? null}
            onSelectStop={(s) => selectStop(s, true)}
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
              flyTo={flyTo}
              flyToken={flyToken}
              frameToken={frameToken}
              pairIds={pairIds}
              pairBaseline={pairBaseline}
            />
            <div className="hud">
              {selectedStop
                ? `Stop ${selectedStop.stop_id} · sol ≤ ${solCursor ?? "?"} · ${visibleCameras.length} cams · ${visiblePairs.length} pairs`
                : "Select a stop"}
              <div className="muted">
                Click a camera · then{" "}
                <button
                  type="button"
                  className="linkish"
                  disabled={!selected || selected.pos_x == null}
                  onClick={enterEyeView}
                >
                  Rover eye view
                </button>
                {" · "}
                <button type="button" className="linkish" onClick={openMissionPath}>
                  ← Mission path
                </button>
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
                <button type="button" onClick={flyToSelected}>
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
                  {selected.hfov_deg?.toFixed?.(0) ?? selected.hfov_deg}° ×{" "}
                  {selected.vfov_deg?.toFixed?.(0) ?? selected.vfov_deg}°
                </dd>
                <dt>position</dt>
                <dd>
                  ({selected.pos_x?.toFixed(3)}, {selected.pos_y?.toFixed(3)},{" "}
                  {selected.pos_z?.toFixed(3)})
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
