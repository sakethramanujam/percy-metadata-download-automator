import { useEffect, useMemo, useRef, useState } from "react";
import Scene from "./Scene";
import {
  Camera,
  Stop,
  fetchCameras,
  fetchHealth,
  fetchImage,
  fetchStats,
  fetchStops,
  thumbUrl,
} from "./api";

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
        const best = [...ordered].sort((a, b) => b.n_posed - a.n_posed)[0];
        if (best) setSelectedStop(best);
      } catch (e) {
        setError(String(e));
      }
    })();
  }, []);

  useEffect(() => {
    if (!selectedStop || selectedStop.site == null || selectedStop.drive == null) return;
    setLoading(true);
    setError(null);
    setSelected(null);
    setDetail(null);
    setFlyTo(null);
    setPlaying(false);
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
  }, [selectedStop]);

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

  async function onSelectCamera(c: Camera, fly = false) {
    setSelected(c);
    if (fly) {
      setFlyTo(c);
      setFlyToken((t) => t + 1);
    }
    try {
      const d = await fetchImage(c.imageid);
      setDetail(d as Camera);
    } catch {
      setDetail(c);
    }
  }

  function flyToSelected() {
    if (!selected) return;
    setFlyTo(selected);
    setFlyToken((t) => t + 1);
  }

  function selectStop(s: Stop) {
    setSelectedStop(s);
  }

  const pathStops = useMemo(() => stops.slice(0, 200), [stops]);

  return (
    <div className="app">
      <aside className="panel">
        <h1>Percy Metadata Playground</h1>
        <div className="toolbar">
          <div className="muted">{health || "Connecting…"}</div>
          <div className="muted">{stats}</div>
          <input
            placeholder="Filter stops (site, sol, id)"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
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
            <div className="timeline-hist" title="Posed cameras per sol (active layers)">
              {Array.from({ length: Math.max(1, solRange.max - solRange.min + 1) }, (_, i) => {
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
              })}
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
        </div>
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
        {loading && <div className="status-banner">Loading cameras…</div>}
        <Scene
          cameras={visibleCameras}
          selectedId={selected?.imageid ?? null}
          onSelect={(c) => onSelectCamera(c, true)}
          showRays={showRays}
          showFrustums={showFrustums}
          flyTo={flyTo}
          flyToken={flyToken}
          frameToken={frameToken}
        />
        <div className="hud">
          {selectedStop
            ? `Stop ${selectedStop.stop_id} · sol ≤ ${solCursor ?? "?"} · ${visibleCameras.length} cameras`
            : "Select a stop"}
          <div className="muted">
            Drag orbit · scroll zoom · hover / click points · Play walks sols
          </div>
        </div>
        <div className="path-strip" title="Mission path (stops ordered by first sol)">
          {pathStops.map((s) => (
            <button
              key={s.stop_id}
              type="button"
              className={
                "path-chip" + (selectedStop?.stop_id === s.stop_id ? " active" : "")
              }
              onClick={() => selectStop(s)}
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
          {selected && (
            <>
              <img
                key={selected.imageid}
                src={thumbUrl(selected.imageid, "small")}
                alt={selected.imageid}
                onError={(e) => {
                  (e.target as HTMLImageElement).style.opacity = "0.3";
                }}
              />
              <div className="inspector-actions">
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
