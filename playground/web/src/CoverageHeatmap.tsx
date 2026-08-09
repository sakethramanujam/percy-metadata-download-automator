import type { CoverageResult } from "./api";

/**
 * Compact az×el coverage panel for stop view (body-frame pose sphere).
 */
export default function CoverageHeatmap({
  data,
  loading,
  error,
  onRefresh,
}: {
  data: CoverageResult | null;
  loading?: boolean;
  error?: string | null;
  onRefresh?: () => void;
}) {
  if (loading) {
    return (
      <div className="coverage-panel">
        <div className="muted">Computing coverage…</div>
      </div>
    );
  }
  if (error) {
    return (
      <div className="coverage-panel">
        <div className="depth-meta" style={{ color: "#f0a0a0" }}>
          {error}
        </div>
        {onRefresh && (
          <button type="button" className="export-btn" onClick={onRefresh}>
            Retry coverage
          </button>
        )}
      </div>
    );
  }
  if (!data) {
    return (
      <div className="coverage-panel">
        <div className="muted">No coverage yet</div>
        {onRefresh && (
          <button type="button" className="export-btn" onClick={onRefresh}>
            Load coverage
          </button>
        )}
      </div>
    );
  }

  const st = data.stats;
  const fam = Object.entries(data.by_family || {})
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${v}`)
    .join(" · ");

  return (
    <div className="coverage-panel">
      <div className="coverage-stats">
        <div>
          <strong>{st.n_posed}</strong> posed looks
        </div>
        <div className="muted">
          look cells {(100 * st.coverage_look_frac).toFixed(1)}% · useful band{" "}
          {(100 * st.coverage_useful_frac).toFixed(1)}%
          {st.coverage_fov_frac != null
            ? ` · FOV soft ${(100 * st.coverage_fov_frac).toFixed(1)}%`
            : ""}
        </div>
        {fam && <div className="muted coverage-fam">{fam}</div>}
      </div>
      {data.preview_data_url && (
        <div className="coverage-img-wrap" title="az −180…180 (fwd center) · el sky↑ ground↓">
          <img
            className="coverage-img"
            src={data.preview_data_url}
            alt="Azimuth-elevation coverage heatmap"
          />
          <div className="coverage-axis">
            <span>← aft</span>
            <span>fwd</span>
            <span>aft →</span>
          </div>
          <div className="coverage-axis-el muted">sky ↑ · ground ↓ · crosshair = forward / horizon</div>
        </div>
      )}
      <div className="muted depth-meta">{data.note}</div>
      {onRefresh && (
        <button type="button" className="export-btn" onClick={onRefresh}>
          Refresh coverage
        </button>
      )}
    </div>
  );
}
