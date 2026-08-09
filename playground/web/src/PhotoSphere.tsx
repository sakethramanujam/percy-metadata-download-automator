import {
  Component,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";

/**
 * Photo sphere viewer.
 *
 * Default path is a flat equirect drag-viewer (always visible).
 * Optional WebGL sphere is layered on top when it initializes successfully.
 * Never depends on WebGL for a non-blank screen.
 */

class SphereErrorBoundary extends Component<
  { children: ReactNode; onError: (msg: string) => void },
  { crashed: boolean }
> {
  state = { crashed: false };
  static getDerivedStateFromError() {
    return { crashed: true };
  }
  componentDidCatch(err: Error) {
    this.props.onError(err?.message || String(err));
  }
  render() {
    if (this.state.crashed) return null;
    return this.props.children;
  }
}

function SphereMesh({ map }: { map: THREE.Texture }) {
  return (
    <mesh scale={[-1, 1, 1]}>
      <sphereGeometry args={[500, 60, 40]} />
      <meshBasicMaterial map={map} side={THREE.FrontSide} toneMapped={false} />
    </mesh>
  );
}

function OrbitLook({
  yaw,
  pitch,
}: {
  yaw: number;
  pitch: number;
}) {
  const { camera } = useThree();
  useFrame(() => {
    const cy = Math.cos(yaw);
    const sy = Math.sin(yaw);
    const cp = Math.cos(pitch);
    const sp = Math.sin(pitch);
    camera.position.set(0, 0, 0.05);
    camera.up.set(0, 1, 0);
    camera.lookAt(sy * cp, sp, cy * cp);
  });
  return null;
}

function WebGLSphere({
  imageUrl,
  yaw,
  pitch,
  onReady,
  onFail,
}: {
  imageUrl: string;
  yaw: number;
  pitch: number;
  onReady: () => void;
  onFail: (msg: string) => void;
}) {
  const [map, setMap] = useState<THREE.Texture | null>(null);
  const mapRef = useRef<THREE.Texture | null>(null);

  useEffect(() => {
    let dead = false;
    const loader = new THREE.TextureLoader();
    // blob: URLs must NOT use crossOrigin
    loader.setCrossOrigin("");
    loader.load(
      imageUrl,
      (tex) => {
        if (dead) {
          tex.dispose();
          return;
        }
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.minFilter = THREE.LinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.generateMipmaps = false;
        tex.needsUpdate = true;
        if (mapRef.current) mapRef.current.dispose();
        mapRef.current = tex;
        setMap(tex);
        onReady();
      },
      undefined,
      () => onFail("WebGL texture load failed")
    );
    return () => {
      dead = true;
      if (mapRef.current) {
        mapRef.current.dispose();
        mapRef.current = null;
      }
    };
  }, [imageUrl, onFail, onReady]);

  if (!map) return null;

  return (
    <>
      <SphereMesh map={map} />
      <OrbitLook yaw={yaw} pitch={pitch} />
    </>
  );
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
  const [mode, setMode] = useState<"flat" | "gl">("flat");
  const [glReady, setGlReady] = useState(false);
  const [glError, setGlError] = useState<string | null>(null);
  const [imgOk, setImgOk] = useState(false);
  const [imgError, setImgError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const drag = useRef<{ x: number; y: number } | null>(null);

  // Prefer flat first so something is always on screen; try GL after img loads
  useEffect(() => {
    setImgOk(false);
    setImgError(null);
    setGlReady(false);
    setGlError(null);
    setMode("flat");
    setYaw(0);
    setPitch(0);
  }, [imageUrl]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      const step = 0.08;
      if (e.key === "ArrowLeft") setYaw((y) => y + step);
      if (e.key === "ArrowRight") setYaw((y) => y - step);
      if (e.key === "ArrowUp") setPitch((p) => Math.min(1.2, p + step));
      if (e.key === "ArrowDown") setPitch((p) => Math.max(-1.2, p - step));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const onGlReady = useCallback(() => {
    setGlReady(true);
    setMode("gl");
  }, []);

  const onGlFail = useCallback((msg: string) => {
    setGlError(msg);
    setMode("flat");
  }, []);

  const onPointerDown = (e: React.PointerEvent) => {
    drag.current = { x: e.clientX, y: e.clientY };
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  };
  const onPointerUp = (e: React.PointerEvent) => {
    drag.current = null;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    } catch {
      /* ignore */
    }
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    const dx = e.clientX - drag.current.x;
    const dy = e.clientY - drag.current.y;
    drag.current = { x: e.clientX, y: e.clientY };
    setYaw((y) => y - dx * 0.005);
    setPitch((p) => Math.max(-1.2, Math.min(1.2, p - dy * 0.005)));
  };

  async function downloadPano() {
    setDownloading(true);
    try {
      const r = await fetch(imageUrl);
      if (!r.ok) throw new Error(String(r.status));
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = downloadName || "photo_sphere.jpg";
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      window.open(imageUrl, "_blank", "noopener,noreferrer");
    } finally {
      setDownloading(false);
    }
  }

  // object-position for equirect pan (0 yaw = center)
  let h = ((-yaw * 180) / Math.PI) % 360;
  if (h < 0) h += 360;
  const posX = 50 - (h / 360) * 100;
  const posY = 50 + (pitch / 1.2) * 25;

  return (
    <div className="photo-sphere-overlay" role="dialog" aria-modal="true">
      <div className="pano-chrome top">
        <div>
          <strong>{title || "Photo sphere"}</strong>
          {meta && <span className="muted"> · {meta}</span>}
          <span className="muted">
            {" "}
            · {mode === "gl" && glReady ? "3D sphere" : "equirect pan"} · hdg{" "}
            {h.toFixed(0)}°
          </span>
        </div>
        <div className="pano-actions">
          {imgOk && !glError && (
            <button
              type="button"
              onClick={() => setMode((m) => (m === "gl" ? "flat" : "gl"))}
            >
              {mode === "gl" ? "Use flat" : "Try 3D"}
            </button>
          )}
          {onFlat && (
            <button type="button" onClick={onFlat}>
              2D pano UI
            </button>
          )}
          <button type="button" onClick={downloadPano} disabled={downloading}>
            {downloading ? "Saving…" : "Download"}
          </button>
          <button type="button" onClick={onClose}>
            Close (Esc)
          </button>
        </div>
      </div>

      <div
        className="photo-sphere-stage"
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
        onPointerMove={onPointerMove}
      >
        {/* Always-visible equirect layer */}
        <img
          className="photo-sphere-img"
          src={imageUrl}
          alt="Site equirect panorama"
          draggable={false}
          style={{ objectPosition: `${posX}% ${posY}%` }}
          onLoad={() => setImgOk(true)}
          onError={() =>
            setImgError(
              "Could not display pano image. Try Download or re-stitch."
            )
          }
        />

        {!imgOk && !imgError && (
          <div className="sphere-status">Loading panorama image…</div>
        )}
        {imgError && (
          <div className="sphere-status error">
            {imgError}
            <div className="muted" style={{ marginTop: 8, wordBreak: "break-all" }}>
              {imageUrl.slice(0, 120)}
            </div>
          </div>
        )}

        {/* Optional WebGL sphere (only when user wants / after img ok) */}
        {imgOk && mode === "gl" && !glError && (
          <div className="photo-sphere-gl">
            <SphereErrorBoundary onError={onGlFail}>
              <Canvas
                camera={{ fov: 75, near: 0.1, far: 2000, position: [0, 0, 0.1] }}
                dpr={1}
                gl={{ antialias: true, alpha: false }}
                onCreated={({ gl }) => {
                  gl.setClearColor("#0a0c10");
                }}
              >
                <WebGLSphere
                  imageUrl={imageUrl}
                  yaw={yaw}
                  pitch={pitch}
                  onReady={onGlReady}
                  onFail={onGlFail}
                />
              </Canvas>
            </SphereErrorBoundary>
            {!glReady && (
              <div className="sphere-status gl-wait">Starting 3D…</div>
            )}
          </div>
        )}

        {glError && mode === "flat" && (
          <div className="sphere-gl-note muted">3D unavailable ({glError}) — flat pan active</div>
        )}
      </div>

      <div className="pano-chrome bottom muted">
        Drag to look · ←/→/↑/↓ · Esc close · equirect from body-frame poses
      </div>
    </div>
  );
}
