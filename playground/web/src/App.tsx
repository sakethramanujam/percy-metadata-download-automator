import { useEffect, useMemo, useState } from "react";
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
  const [solMin, setSolMin] = useState<string>("");
  const [solMax, setSolMax] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
        setStops(s.stops);
        setStats(
          `${st.n_stops} stops · ${st.n_posed.toLocaleString()} posed / ${st.n_images.toLocaleString()} images · sols ${st.sol_min ?? "?"}–${st.sol_max ?? "?"}`
        );
        // auto-select densest posed stop
        const best = [...s.stops].sort((a, b) => b.n_posed - a.n_posed)[0];
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
    fetchCameras(selectedStop.site, selectedStop.drive)
      .then((r) => setCameras(r.cameras))
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [selectedStop]);

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
    const sMin = solMin === "" ? null : Number(solMin);
    const sMax = solMax === "" ? null : Number(solMax);
    return cameras.filter((c) => {
      const inst = c.instrument || "";
      const layerOk = LAYER_OPTIONS.some((l) => layers[l.id] && l.match(inst));
      if (!layerOk) return false;
      if (sMin != null && c.sol != null && c.sol < sMin) return false;
      if (sMax != null && c.sol != null && c.sol > sMax) return false;
      return c.has_pose && c.pos_x != null;
    });
  }, [cameras, layers, solMin, solMax]);

  async function onSelectCamera(c: Camera) {
    setSelected(c);
    try {
      const d = await fetchImage(c.imageid);
      setDetail(d as Camera);
    } catch {
      setDetail(c);
    }
  }

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
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              style={{ width: "50%" }}
              placeholder="sol min"
              value={solMin}
              onChange={(e) => setSolMin(e.target.value)}
            />
            <input
              style={{ width: "50%" }}
              placeholder="sol max"
              value={solMax}
              onChange={(e) => setSolMax(e.target.value)}
            />
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
              onClick={() => setSelectedStop(s)}
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
          onSelect={onSelectCamera}
          showRays={showRays}
        />
        <div className="hud">
          {selectedStop
            ? `Stop ${selectedStop.stop_id} · showing ${visibleCameras.length} / ${cameras.length} cameras`
            : "Select a stop"}
          <div className="muted">Drag to orbit · scroll to zoom · click a point</div>
        </div>
      </main>

      <aside className="panel right">
        <h1>Inspector</h1>
        <div className="inspector">
          {!selected && (
            <div className="empty">
              Click a camera point in the 3D view to inspect metadata and image.
            </div>
          )}
          {selected && (
            <>
              <img
                src={thumbUrl(selected.imageid, "small")}
                alt={selected.imageid}
                onError={(e) => {
                  (e.target as HTMLImageElement).style.opacity = "0.3";
                }}
              />
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
                <dt>position</dt>
                <dd>
                  ({selected.pos_x?.toFixed(3)}, {selected.pos_y?.toFixed(3)},{" "}
                  {selected.pos_z?.toFixed(3)})
                </dd>
                <dt>mast</dt>
                <dd>
                  az {selected.mast_az ?? "?"} · el {selected.mast_el ?? "?"}
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
