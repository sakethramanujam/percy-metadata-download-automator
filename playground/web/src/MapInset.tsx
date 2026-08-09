import { useMemo } from "react";
import type { MapWaypoint, Stop } from "./api";

/**
 * Compact map context for stop view.
 * Stop cameras live in rover body frame; the basemap is geographic (lon/lat).
 * This inset keeps the Jezero location visible without mixing coordinate systems
 * in the main 3D scene.
 */
export default function MapInset({
  waypoints,
  selectedStop,
  basemapLayer = "ctx",
  onOpenPath,
}: {
  waypoints: MapWaypoint[];
  selectedStop: Stop | null;
  basemapLayer?: string;
  onOpenPath?: () => void;
}) {
  const geo = useMemo(() => {
    const usable = waypoints.filter(
      (w) => w.lon != null && w.lat != null && Number.isFinite(w.lon) && Number.isFinite(w.lat)
    );
    if (!usable.length) return null;
    const lons = usable.map((w) => w.lon as number);
    const lats = usable.map((w) => w.lat as number);
    const pad = 0.08;
    const lonMin = Math.min(...lons) - pad;
    const lonMax = Math.max(...lons) + pad;
    const latMin = Math.min(...lats) - pad;
    const latMax = Math.max(...lats) + pad;
    const toXY = (lon: number, lat: number) => {
      const x = ((lon - lonMin) / (lonMax - lonMin || 1)) * 100;
      // SVG y down: north (max lat) at top
      const y = (1 - (lat - latMin) / (latMax - latMin || 1)) * 100;
      return [x, y] as [number, number];
    };
    const ordered = [...usable].sort((a, b) => (a.sol ?? 0) - (b.sol ?? 0));
    const path = ordered
      .map((w) => {
        const [x, y] = toXY(w.lon as number, w.lat as number);
        return `${x},${y}`;
      })
      .join(" ");

    let marker: [number, number] | null = null;
    if (selectedStop?.site != null && selectedStop?.drive != null) {
      const hit =
        ordered.find(
          (w) => w.site === selectedStop.site && w.drive === selectedStop.drive
        ) ||
        (selectedStop.lon != null && selectedStop.lat != null
          ? ({ lon: selectedStop.lon, lat: selectedStop.lat } as MapWaypoint)
          : null);
      if (hit?.lon != null && hit?.lat != null) {
        marker = toXY(hit.lon, hit.lat);
      }
    }

    return { path, marker, basemapUrl: `/api/map/basemap?layer=${encodeURIComponent(basemapLayer)}&width=1024&height=1024&pad_deg=0.08` };
  }, [waypoints, selectedStop, basemapLayer]);

  if (!geo) {
    return (
      <div className="map-inset empty-inset" title="No map waypoints">
        <span className="muted">No map data</span>
      </div>
    );
  }

  return (
    <button
      type="button"
      className="map-inset"
      onClick={onOpenPath}
      title="Open mission path (map frame). Stop view is rover body frame."
    >
      <img src={geo.basemapUrl} alt="" className="map-inset-img" />
      <svg
        className="map-inset-svg"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
      >
        <polyline
          points={geo.path}
          fill="none"
          stroke="rgba(148, 163, 184, 0.95)"
          strokeWidth="0.7"
        />
        {geo.marker && (
          <circle
            cx={geo.marker[0]}
            cy={geo.marker[1]}
            r="2.2"
            fill="#e8a838"
            stroke="#0b0f14"
            strokeWidth="0.5"
          />
        )}
      </svg>
      <div className="map-inset-label">
        Map · you are here
        {selectedStop?.site != null && (
          <span>
            {" "}
            · {selectedStop.site}/{selectedStop.drive}
          </span>
        )}
      </div>
    </button>
  );
}
