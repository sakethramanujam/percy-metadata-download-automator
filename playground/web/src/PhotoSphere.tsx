import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";

/**
 * Immersive photo sphere from an equirectangular JPEG (pose-stitched).
 * Renders as a fixed full-viewport overlay so layout flex cannot zero its height.
 */

const MAX_TEX = 4096;

function loadEquirectTexture(url: string): Promise<THREE.Texture> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    // crossOrigin on blob: URLs breaks decode in Chromium — only set for http(s)
    if (/^https?:\/\//i.test(url)) {
      img.crossOrigin = "anonymous";
    }
    img.onload = () => {
      try {
        const w = img.naturalWidth || img.width;
        const h = img.naturalHeight || img.height;
        if (w < 8 || h < 8) {
          reject(new Error(`pano image too small (${w}×${h})`));
          return;
        }

        let dw = w;
        let dh = h;
        if (Math.max(w, h) > MAX_TEX) {
          const s = MAX_TEX / Math.max(w, h);
          dw = Math.max(2, Math.round(w * s));
          dh = Math.max(2, Math.round(h * s));
        }
        dw -= dw % 2;
        dh -= dh % 2;

        const canvas = document.createElement("canvas");
        canvas.width = dw;
        canvas.height = dh;
        const ctx = canvas.getContext("2d", { willReadFrequently: false });
        if (!ctx) {
          reject(new Error("2d canvas unavailable"));
          return;
        }
        ctx.drawImage(img, 0, 0, dw, dh);

        const tex = new THREE.CanvasTexture(canvas);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.generateMipmaps = true;
        tex.minFilter = THREE.LinearMipmapLinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.wrapS = THREE.ClampToEdgeWrapping;
        tex.wrapT = THREE.ClampToEdgeWrapping;
        tex.flipY = true;
        tex.needsUpdate = true;
        resolve(tex);
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    };
    img.onerror = () =>
      reject(
        new Error(
          `Failed to decode pano (${url.startsWith("blob:") ? "blob" : url.slice(0, 64)}…)`
        )
      );
    img.src = url;
  });
}

function SphereMesh({ texture }: { texture: THREE.Texture }) {
  // Invert X so FrontSide faces inward around the origin camera.
  return (
    <mesh scale={[-1, 1, 1]}>
      <sphereGeometry args={[500, 64, 40]} />
      <meshBasicMaterial map={texture} side={THREE.FrontSide} toneMapped={false} />
    </mesh>
  );
}

function LookControls({
  yaw,
  pitch,
  setYaw,
  setPitch,
}: {
  yaw: number;
  pitch: number;
  setYaw: (y: number) => void;
  setPitch: (p: number) => void;
}) {
  const { camera, gl } = useThree();
  const dragging = useRef(false);
  const last = useRef({ x: 0, y: 0 });
  const yawRef = useRef(yaw);
  const pitchRef = useRef(pitch);
  yawRef.current = yaw;
  pitchRef.current = pitch;

  useEffect(() => {
    const el = gl.domElement;
    const onDown = (e: PointerEvent) => {
      dragging.current = true;
      last.current = { x: e.clientX, y: e.clientY };
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    };
    const onUp = (e: PointerEvent) => {
      dragging.current = false;
      try {
        el.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    };
    const onMove = (e: PointerEvent) => {
      if (!dragging.current) return;
      const dx = e.clientX - last.current.x;
      const dy = e.clientY - last.current.y;
      last.current = { x: e.clientX, y: e.clientY };
      const sens = 0.0045;
      setYaw(yawRef.current - dx * sens);
      let np = pitchRef.current - dy * sens;
      np = Math.max(-1.2, Math.min(1.2, np));
      setPitch(np);
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const cam = camera as THREE.PerspectiveCamera;
      cam.fov = Math.max(35, Math.min(110, cam.fov + e.deltaY * 0.05));
      cam.updateProjectionMatrix();
    };
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("wheel", onWheel);
    };
  }, [camera, gl, setPitch, setYaw]);

  useFrame(() => {
    const cy = Math.cos(yawRef.current);
    const sy = Math.sin(yawRef.current);
    const cp = Math.cos(pitchRef.current);
    const sp = Math.sin(pitchRef.current);
    // Small offset off exact origin avoids lookAt singularity edge cases
    camera.position.set(0, 0, 0.01);
    camera.up.set(0, 1, 0);
    camera.lookAt(sy * cp, sp, cy * cp);
  });

  return null;
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
  const [downloading, setDownloading] = useState(false);
  const [tex, setTex] = useState<THREE.Texture | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">(
    "loading"
  );
  const [err, setErr] = useState<string | null>(null);
  const [useWebGL, setUseWebGL] = useState(true);
  const texRef = useRef<THREE.Texture | null>(null);
  const loadGen = useRef(0);

  useEffect(() => {
    setYaw(0);
    setPitch(0);
    setLoadState("loading");
    setErr(null);
    setTex(null);
    setUseWebGL(true);
    const gen = ++loadGen.current;

    loadEquirectTexture(imageUrl)
      .then((t) => {
        if (gen !== loadGen.current) {
          t.dispose();
          return;
        }
        if (texRef.current) texRef.current.dispose();
        texRef.current = t;
        setTex(t);
        setLoadState("ready");
      })
      .catch((e) => {
        if (gen !== loadGen.current) return;
        setErr(e instanceof Error ? e.message : String(e));
        setLoadState("error");
      });

    return () => {
      loadGen.current += 1; // invalidate in-flight
      if (texRef.current) {
        texRef.current.dispose();
        texRef.current = null;
      }
    };
  }, [imageUrl]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      const step = 0.08;
      if (e.key === "ArrowLeft") setYaw((y) => y + step);
      if (e.key === "ArrowRight") setYaw((y) => y - step);
      if (e.key === "ArrowUp") setPitch((p) => Math.min(1.2, p + step));
      if (e.key === "ArrowDown") setPitch((p) => Math.max(-1.2, p - step));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function downloadPano() {
    setDownloading(true);
    try {
      const r = await fetch(imageUrl);
      if (!r.ok) throw new Error(`download failed: ${r.status}`);
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

  const headingDeg = useMemo(() => {
    let h = (-yaw * 180) / Math.PI;
    h = ((h % 360) + 360) % 360;
    return h;
  }, [yaw]);

  // Flat CSS equirect fallback (always works if texture/blob decoded)
  const flatStyle =
    loadState === "ready"
      ? {
          backgroundImage: `url(${imageUrl})`,
          backgroundSize: "cover",
          backgroundPosition: `${50 - (headingDeg / 360) * 100}% 50%`,
        }
      : undefined;

  return (
    <div className="photo-sphere-overlay" role="dialog" aria-label="Photo sphere">
      <div className="pano-chrome top">
        <div>
          <strong>{title || "Photo sphere"}</strong>
          {meta && <span className="muted"> · {meta}</span>}
          {loadState === "ready" && (
            <span className="muted">
              {" "}
              · heading {headingDeg.toFixed(0)}° · pitch{" "}
              {((pitch * 180) / Math.PI).toFixed(0)}°
              {!useWebGL ? " · flat fallback" : ""}
            </span>
          )}
        </div>
        <div className="pano-actions">
          {loadState === "ready" && (
            <button
              type="button"
              onClick={() => setUseWebGL((v) => !v)}
              title="Toggle 3D sphere vs flat equirect"
            >
              {useWebGL ? "Flat fallback" : "3D sphere"}
            </button>
          )}
          {onFlat && (
            <button type="button" onClick={onFlat}>
              2D pano
            </button>
          )}
          <button type="button" onClick={downloadPano} disabled={downloading}>
            {downloading ? "Saving…" : "Download JPEG"}
          </button>
          <button type="button" onClick={onClose}>
            Close (Esc)
          </button>
        </div>
      </div>

      <div className="photo-sphere-stage">
        {loadState === "loading" && (
          <div className="sphere-status">
            Loading photo sphere…
            <div className="muted" style={{ marginTop: 8, fontSize: "0.85rem" }}>
              Decoding equirect texture
            </div>
          </div>
        )}

        {loadState === "error" && (
          <div className="sphere-status error">
            <div>{err || "Failed to load photo sphere"}</div>
            <div className="muted" style={{ marginTop: 8 }}>
              The JPEG may still open flat:
            </div>
            <img
              src={imageUrl}
              alt="Equirect fallback"
              style={{
                maxWidth: "90%",
                maxHeight: "50vh",
                marginTop: 12,
                borderRadius: 8,
              }}
            />
            {onFlat && (
              <button
                type="button"
                className="export-btn"
                style={{ marginTop: 12 }}
                onClick={onFlat}
              >
                Open 2D pano viewer
              </button>
            )}
          </div>
        )}

        {loadState === "ready" && useWebGL && tex && (
          <Canvas
            className="photo-sphere-canvas"
            camera={{ fov: 75, near: 0.1, far: 2000, position: [0, 0, 0.1] }}
            gl={{
              antialias: true,
              alpha: false,
              powerPreference: "default",
              failIfMajorPerformanceCaveat: false,
            }}
            dpr={1}
            onCreated={({ gl }) => {
              gl.setClearColor("#0a0c10");
              gl.domElement.style.display = "block";
              gl.domElement.style.width = "100%";
              gl.domElement.style.height = "100%";
            }}
            onError={() => setUseWebGL(false)}
          >
            <SphereMesh texture={tex} />
            <LookControls
              yaw={yaw}
              pitch={pitch}
              setYaw={setYaw}
              setPitch={setPitch}
            />
          </Canvas>
        )}

        {loadState === "ready" && !useWebGL && (
          <div
            className="photo-sphere-flat"
            style={flatStyle}
            onPointerDown={(e) => {
              (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
              (e.target as HTMLElement).dataset.dragx = String(e.clientX);
            }}
            onPointerMove={(e) => {
              const el = e.target as HTMLElement;
              if (e.buttons !== 1 && e.pressure === 0) return;
              const prev = Number(el.dataset.dragx || e.clientX);
              const dx = e.clientX - prev;
              el.dataset.dragx = String(e.clientX);
              setYaw((y) => y - dx * 0.005);
            }}
          />
        )}
      </div>

      <div className="pano-chrome bottom muted">
        Drag to look · ←/→/↑/↓ · scroll FOV (3D) · Esc close · equirect · az 0 ≈
        forward
      </div>
    </div>
  );
}
