import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";

/**
 * Photo sphere / equirect viewer.
 * Renders via portal to document.body so nothing in the app grid can clip it.
 * Default = flat equirect (always visible). 3D is opt-in.
 */

function SphereScene({
  texture,
  yaw,
  pitch,
}: {
  texture: THREE.Texture;
  yaw: number;
  pitch: number;
}) {
  const { camera } = useThree();
  useFrame(() => {
    const cy = Math.cos(yaw);
    const sy = Math.sin(yaw);
    const cp = Math.cos(pitch);
    const sp = Math.sin(pitch);
    camera.position.set(0, 0, 0);
    camera.up.set(0, 1, 0);
    // Look along unit direction (not at origin)
    const t = new THREE.Vector3(sy * cp, sp, cy * cp);
    camera.lookAt(t);
  });

  return (
    <mesh>
      {/* Inside of sphere: BackSide + no scale flip */}
      <sphereGeometry args={[500, 64, 40]} />
      <meshBasicMaterial
        map={texture}
        side={THREE.BackSide}
        toneMapped={false}
      />
    </mesh>
  );
}

function GlSphere({
  imageUrl,
  yaw,
  pitch,
  onFail,
}: {
  imageUrl: string;
  yaw: number;
  pitch: number;
  onFail: (m: string) => void;
}) {
  const [tex, setTex] = useState<THREE.Texture | null>(null);
  const ref = useRef<THREE.Texture | null>(null);

  useEffect(() => {
    let dead = false;
    const img = new Image();
    // Never set crossOrigin on blob: URLs
    if (/^https?:/i.test(imageUrl)) img.crossOrigin = "anonymous";
    img.onload = () => {
      if (dead) return;
      try {
        const max = 2048;
        let w = img.naturalWidth;
        let h = img.naturalHeight;
        if (Math.max(w, h) > max) {
          const s = max / Math.max(w, h);
          w = Math.round(w * s);
          h = Math.round(h * s);
        }
        const c = document.createElement("canvas");
        c.width = w;
        c.height = h;
        const ctx = c.getContext("2d");
        if (!ctx) throw new Error("no 2d context");
        ctx.drawImage(img, 0, 0, w, h);
        const t = new THREE.CanvasTexture(c);
        t.colorSpace = THREE.SRGBColorSpace;
        t.flipY = true;
        t.needsUpdate = true;
        if (ref.current) ref.current.dispose();
        ref.current = t;
        setTex(t);
      } catch (e) {
        onFail(e instanceof Error ? e.message : String(e));
      }
    };
    img.onerror = () => onFail("texture image decode failed");
    img.src = imageUrl;
    return () => {
      dead = true;
      if (ref.current) {
        ref.current.dispose();
        ref.current = null;
      }
    };
  }, [imageUrl, onFail]);

  if (!tex) {
    return null;
  }
  return <SphereScene texture={tex} yaw={yaw} pitch={pitch} />;
}

export default function PhotoSphere({
  imageUrl,
  title,
  meta,
  downloadName,
  onClose,
  onFlat,
}: {
  imageUrl: string;
  title?: string;
  meta?: string;
  downloadName?: string;
  onClose: () => void;
  onFlat?: () => void;
}) {
  const [yaw, setYaw] = useState(0);
  const [pitch, setPitch] = useState(0);
  const [mode3d, setMode3d] = useState(false);
  const [glError, setGlError] = useState<string | null>(null);
  const [imgOk, setImgOk] = useState(false);
  const [imgErr, setImgErr] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const drag = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    setYaw(0);
    setPitch(0);
    setMode3d(false);
    setGlError(null);
    setImgOk(false);
    setImgErr(null);
  }, [imageUrl]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
      const s = 0.1;
      if (e.key === "ArrowLeft") setYaw((y) => y + s);
      if (e.key === "ArrowRight") setYaw((y) => y - s);
      if (e.key === "ArrowUp") setPitch((p) => Math.min(1.1, p + s));
      if (e.key === "ArrowDown") setPitch((p) => Math.max(-1.1, p - s));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Prevent body scroll under overlay
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  const onPtrDown = (e: React.PointerEvent) => {
    drag.current = { x: e.clientX, y: e.clientY };
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  };
  const onPtrUp = (e: React.PointerEvent) => {
    drag.current = null;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    } catch {
      /* ignore */
    }
  };
  const onPtrMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    const dx = e.clientX - drag.current.x;
    const dy = e.clientY - drag.current.y;
    drag.current = { x: e.clientX, y: e.clientY };
    setYaw((y) => y - dx * 0.005);
    setPitch((p) => Math.max(-1.1, Math.min(1.1, p - dy * 0.004)));
  };

  async function downloadPano() {
    setDownloading(true);
    try {
      const r = await fetch(imageUrl);
      const blob = await r.blob();
      const u = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = u;
      a.download = downloadName || "photo_sphere.jpg";
      a.click();
      URL.revokeObjectURL(u);
    } catch {
      window.open(imageUrl, "_blank");
    } finally {
      setDownloading(false);
    }
  }

  let hdg = ((-yaw * 180) / Math.PI) % 360;
  if (hdg < 0) hdg += 360;
  // object-position: pan equirect (center = yaw 0)
  const objX = `${50 - (hdg / 360) * 100}%`;
  const objY = `${50 + (pitch / 1.1) * 30}%`;

  const ui = (
    <div className="ps-root" role="dialog" aria-modal="true" aria-label="Photo sphere">
      <header className="ps-bar ps-bar-top">
        <div className="ps-title">
          <strong>{title || "Photo sphere"}</strong>
          {meta ? <span className="muted"> · {meta}</span> : null}
          <span className="muted">
            {" "}
            · {mode3d ? "3D" : "flat"} · hdg {hdg.toFixed(0)}°
          </span>
        </div>
        <div className="ps-actions">
          <button
            type="button"
            disabled={!imgOk || !!glError}
            onClick={() => {
              setGlError(null);
              setMode3d((v) => !v);
            }}
          >
            {mode3d ? "Flat view" : "3D sphere"}
          </button>
          {onFlat && (
            <button type="button" onClick={onFlat}>
              Classic 2D
            </button>
          )}
          <button type="button" onClick={downloadPano} disabled={downloading}>
            {downloading ? "…" : "Download"}
          </button>
          <button type="button" className="ps-close" onClick={onClose}>
            Close (Esc)
          </button>
        </div>
      </header>

      <div
        className="ps-stage"
        onPointerDown={onPtrDown}
        onPointerUp={onPtrUp}
        onPointerCancel={onPtrUp}
        onPointerMove={onPtrMove}
      >
        {/* Flat equirect — always rendered under 3D */}
        <img
          className="ps-img"
          src={imageUrl}
          alt="Equirectangular panorama"
          draggable={false}
          style={{
            objectPosition: `${objX} ${objY}`,
            // hide flat only when 3D is active and working
            opacity: mode3d && !glError ? 0 : 1,
            visibility: mode3d && !glError ? "hidden" : "visible",
          }}
          onLoad={() => setImgOk(true)}
          onError={() =>
            setImgErr("Image failed to display. Use Download to inspect the JPEG.")
          }
        />

        {!imgOk && !imgErr && (
          <div className="ps-msg">Loading panorama image…</div>
        )}
        {imgErr && <div className="ps-msg ps-err">{imgErr}</div>}

        {mode3d && imgOk && !glError && (
          <div className="ps-gl">
            <Canvas
              camera={{ position: [0, 0, 0.1], fov: 75, near: 0.1, far: 2000 }}
              dpr={1}
              gl={{ antialias: true, alpha: false }}
              onCreated={({ gl }) => gl.setClearColor("#111820")}
            >
              <GlSphere
                imageUrl={imageUrl}
                yaw={yaw}
                pitch={pitch}
                onFail={(m) => {
                  setGlError(m);
                  setMode3d(false);
                }}
              />
            </Canvas>
          </div>
        )}

        {glError && (
          <div className="ps-toast">3D failed: {glError} — showing flat</div>
        )}
      </div>

      <footer className="ps-bar ps-bar-bot muted">
        Drag to look · arrows pan · Esc close
        {imgOk ? ` · image OK` : ""}
        {imageUrl.startsWith("blob:") ? " · blob" : ""}
      </footer>
    </div>
  );

  return createPortal(ui, document.body);
}
