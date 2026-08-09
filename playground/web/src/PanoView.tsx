import { useEffect, useRef, useState } from "react";

/**
 * Drag-to-look cylindrical / equirect panorama viewer.
 * Image is produced by pose-driven stitch (body-frame look/up/FOV).
 */
export default function PanoView({
  imageUrl,
  title,
  meta,
  downloadName,
  onClose,
}: {
  imageUrl: string;
  title?: string;
  meta?: string;
  /** Suggested download filename (e.g. pano_3_0_equirect.jpg) */
  downloadName?: string;
  onClose: () => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [offset, setOffset] = useState(0.5); // 0..1 horizontal scroll center
  const [dragging, setDragging] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const lastX = useRef(0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowLeft") setOffset((o) => Math.max(0, o - 0.04));
      if (e.key === "ArrowRight") setOffset((o) => Math.min(1, o + 0.04));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    setOffset(0.5);
  }, [imageUrl]);

  const onPointerDown = (e: React.PointerEvent) => {
    setDragging(true);
    lastX.current = e.clientX;
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  };
  const onPointerUp = (e: React.PointerEvent) => {
    setDragging(false);
    try {
      (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
    } catch {
      /* ignore */
    }
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragging || !wrapRef.current) return;
    const dx = e.clientX - lastX.current;
    lastX.current = e.clientX;
    const w = wrapRef.current.clientWidth || 1;
    // Drag right → look left (scroll image right)
    setOffset((o) => Math.min(1, Math.max(0, o - dx / (w * 2.5))));
  };

  async function downloadPano() {
    setDownloading(true);
    try {
      const r = await fetch(imageUrl);
      if (!r.ok) throw new Error(`download failed: ${r.status}`);
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = downloadName || "pano.jpg";
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      // fall back to opening image in a new tab
      window.open(imageUrl, "_blank", "noopener,noreferrer");
    } finally {
      setDownloading(false);
    }
  }

  // object-position: percentage for the focal point of the wide image
  const pos = `${(offset * 100).toFixed(2)}% 50%`;

  return (
    <div className="pano-view">
      <div className="pano-chrome top">
        <div>
          <strong>{title || "Site panorama"}</strong>
          {meta && <span className="muted"> · {meta}</span>}
        </div>
        <div className="pano-actions">
          <button type="button" onClick={downloadPano} disabled={downloading}>
            {downloading ? "Saving…" : "Download JPEG"}
          </button>
          <button type="button" onClick={onClose}>
            Close (Esc)
          </button>
        </div>
      </div>
      <div
        ref={wrapRef}
        className={"pano-stage" + (dragging ? " dragging" : "")}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
        onPointerMove={onPointerMove}
      >
        <img
          src={imageUrl}
          alt="Pose-stitched panorama"
          draggable={false}
          style={{ objectPosition: pos }}
        />
      </div>
      <div className="pano-chrome bottom muted">
        Drag to look · ←/→ · Esc close · Download JPEG for equirect/VR tools ·
        Pose look/up/FOV (body frame)
      </div>
    </div>
  );
}
