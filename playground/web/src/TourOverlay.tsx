import type { Tour, TourStep } from "./tours";

/**
 * Caption + controls for guided tours. Sits above the 3D viewport.
 */
export default function TourOverlay({
  tour,
  stepIndex,
  step,
  playing,
  onPrev,
  onNext,
  onTogglePlay,
  onClose,
  onJump,
}: {
  tour: Tour;
  stepIndex: number;
  step: TourStep;
  playing: boolean;
  onPrev: () => void;
  onNext: () => void;
  onTogglePlay: () => void;
  onClose: () => void;
  onJump?: (i: number) => void;
}) {
  const n = tour.steps.length;
  const pct = n > 1 ? (100 * stepIndex) / (n - 1) : 0;

  return (
    <div className="tour-overlay" role="region" aria-label="Guided tour">
      <div className="tour-top">
        <div className="tour-brand">
          <span className="tour-kicker">Tour</span>
          <strong>{tour.title}</strong>
          <span className="muted">
            {stepIndex + 1} / {n}
          </span>
        </div>
        <button type="button" className="tour-close" onClick={onClose} title="Exit tour">
          ✕
        </button>
      </div>
      <div className="tour-progress" aria-hidden>
        <div className="tour-progress-bar" style={{ width: `${pct}%` }} />
      </div>
      <div className="tour-body">
        <div className="tour-step-title">{step.title}</div>
        <p className="tour-caption">{step.caption}</p>
        <div className="tour-meta muted">
          {step.type}
          {step.site != null ? ` · site ${step.site}` : ""}
          {step.drive != null ? ` / drive ${step.drive}` : ""}
          {step.sol != null ? ` · sol ${step.sol}` : ""}
        </div>
      </div>
      <div className="tour-controls">
        <button type="button" onClick={onPrev} disabled={stepIndex <= 0}>
          ← Prev
        </button>
        <button type="button" onClick={onTogglePlay}>
          {playing ? "Pause" : "Play"}
        </button>
        <button type="button" onClick={onNext} disabled={stepIndex >= n - 1}>
          Next →
        </button>
        {onJump && (
          <select
            className="tour-jump"
            value={stepIndex}
            onChange={(e) => onJump(Number(e.target.value))}
            title="Jump to step"
          >
            {tour.steps.map((s, i) => (
              <option key={s.id} value={i}>
                {i + 1}. {s.title}
              </option>
            ))}
          </select>
        )}
      </div>
      <div className="tour-hint muted">
        Keys: ← → step · Space play/pause · Esc exit · share URL keeps tour+step
      </div>
    </div>
  );
}
