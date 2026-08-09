import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useThree, useFrame } from "@react-three/fiber";
import * as THREE from "three";

/**
 * Immersive photo sphere: equirectangular JPEG mapped inside a sphere.
 * Pose-driven stitch (body frame: az 0 ≈ forward at image center).
 */

const MAX_TEX = 4096; // GTX 1050-class cards choke on 6k+ equirects

function loadEquirectTexture(url: string): Promise<THREE.Texture> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      try {
        let w = img.naturalWidth || img.width;
        let h = img.naturalHeight || img.height;
        if (w < 8 || h < 8) {
          reject(new Error("pano image too small or empty"));
          return;
        }
        // Downscale oversized textures for WebGL reliability
        let dw = w;
        let dh = h;
        if (Math.max(w, h) > MAX_TEX) {
          const s = MAX_TEX / Math.max(w, h);
          dw = Math.max(2, Math.round(w * s));
          dh = Math.max(2, Math.round(h * s));
        }
        // Power-of-two friendly not required for WebGL2, but even dims help
        dw = dw - (dw % 2);
        dh = dh - (dh % 2);

        const canvas = document.createElement("canvas");
        canvas.width = dw;
        canvas.height = dh;
        const ctx = canvas.getContext("2d");
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
      reject(new Error(`Failed to load pano image (${url.slice(0, 80)}…)`));
    img.src = url;
  });
}

function SphereMesh({ texture }: { texture: THREE.Texture }) {
  // Invert X so faces point inward (camera at origin sees the texture).
  // Do not also set BackSide — that would face outward and look black.
  return (
    <mesh scale={[-1, 1, 1]}>
      <sphereGeometry args={[50, 64, 48]} />
      <meshBasicMaterial
        map={texture}
        side={THREE.FrontSide}
        toneMapped={false}
        depthWrite={false}
      />
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
      el.setPointerCapture(e.pointerId);
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
      const sens = 0.005;
      const ny = yawRef.current - dx * sens;
      let np = pitchRef.current - dy * sens;
      np = Math.max(-Math.PI / 2 + 0.05, Math.min(Math.PI / 2 - 0.05, np));
      setYaw(ny);
      setPitch(np);
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const cam = camera as THREE.PerspectiveCamera;
      cam.fov = Math.max(40, Math.min(100, cam.fov + e.deltaY * 0.04));
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
    // yaw=0,pitch=0 → +Z (forward into texture center after offset)
    const dir = new THREE.Vector3(sy * cp, sp, cy * cp);
    camera.position.set(0, 0, 0);
    camera.up.set(0, 1, 0);
    camera.lookAt(dir.x, dir.y, dir.z);
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
  const texRef = useRef<THREE.Texture | null>(null);

  useEffect(() => {
    setYaw(0);
    setPitch(0);
    setLoadState("loading");
    setErr(null);
    setTex(null);
    let cancelled = false;

    loadEquirectTexture(imageUrl)
      .then((t) => {
        if (cancelled) {
          t.dispose();
          return;
        }
        if (texRef.current) texRef.current.dispose();
        texRef.current = t;
        setTex(t);
        setLoadState("ready");
      })
      .catch((e) => {
        if (cancelled) return;
        setErr(e instanceof Error ? e.message : String(e));
        setLoadState("error");
      });

    return () => {
      cancelled = true;
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
      if (e.key === "ArrowUp")
        setPitch((p) => Math.min(Math.PI / 2 - 0.05, p + step));
      if (e.key === "ArrowDown")
        setPitch((p) => Math.max(-Math.PI / 2 + 0.05, p - step));
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

  return (
    <div className="pano-view photo-sphere">
      <div className="pano-chrome top">
        <div>
          <strong>{title || "Photo sphere"}</strong>
          {meta && <span className="muted"> · {meta}</span>}
          {loadState === "ready" && (
            <span className="muted">
              {" "}
              · heading {headingDeg.toFixed(0)}° · pitch{" "}
              {((pitch * 180) / Math.PI).toFixed(0)}°
            </span>
          )}
        </div>
        <div className="pano-actions">
          {onFlat && (
            <button type="button" onClick={onFlat}>
              Flat view
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
      <div className="pano-stage sphere-stage">
        {loadState === "loading" && (
          <div className="sphere-status">
            Loading sphere texture…
            <div className="muted" style={{ marginTop: 8, fontSize: "0.8rem" }}>
              Large equirects may take a moment to decode
            </div>
          </div>
        )}
        {loadState === "error" && (
          <div className="sphere-status error">
            <div>{err || "Failed to load photo sphere"}</div>
            <div className="muted" style={{ marginTop: 8 }}>
              Try size <strong>medium</strong>, or open Flat view / re-stitch.
            </div>
            {onFlat && (
              <button
                type="button"
                className="export-btn"
                style={{ marginTop: 12 }}
                onClick={onFlat}
              >
                Open flat view
              </button>
            )}
          </div>
        )}
        {loadState === "ready" && tex && (
          <Canvas
            camera={{
              fov: 80,
              near: 0.01,
              far: 200,
              position: [0, 0, 0.001],
            }}
            gl={{
              antialias: true,
              powerPreference: "high-performance",
              failIfMajorPerformanceCaveat: false,
            }}
            dpr={[1, 1.5]}
            onCreated={({ gl }) => {
              gl.setClearColor("#0a0c10");
            }}
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
      </div>
      <div className="pano-chrome bottom muted">
        Drag to look · ←/→/↑/↓ · scroll = FOV · Esc close · Equirect sphere ·
        body-frame az 0 = forward
      </div>
    </div>
  );
}
