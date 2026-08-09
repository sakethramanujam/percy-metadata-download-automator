"""Pose-driven cylindrical panorama for a rover stop.

Uses the metadata coordinate system (body frame):
  +X forward, +Y right, +Z down
  look / up / right unit vectors + hfov/vfov

We do **not** rely on OpenCV feature matching. Each pixel is projected with the
known camera ray into azimuth/elevation and blended onto a cylinder.
"""

from __future__ import annotations

import hashlib
import math
import time
from pathlib import Path
from typing import Any, Optional

import numpy as np
import pandas as pd

from playground.api import config
from playground.api.cache import get_cached_or_fetch
from playground.api.data import load_images

try:
    import cv2

    _HAS_CV2 = True
except ImportError:  # pragma: no cover
    cv2 = None  # type: ignore
    _HAS_CV2 = False

CACHE_DIR = config.DERIVED_DIR / "pano_cache"

# Body frame: az about vertical (up = −Z), 0 = +X forward, +az toward +Y (right)
# el: elevation above horizontal, positive when looking toward −Z (sky)


def look_az_el(look: np.ndarray) -> tuple[float, float]:
    lx, ly, lz = float(look[0]), float(look[1]), float(look[2])
    az = math.atan2(ly, lx)
    el = math.atan2(-lz, math.hypot(lx, ly))
    return az, el


def _unit(v: np.ndarray) -> Optional[np.ndarray]:
    v = np.asarray(v, dtype=np.float64).ravel()[:3]
    n = float(np.linalg.norm(v))
    if n < 1e-12:
        return None
    return v / n


def select_pano_frames(
    site: int,
    drive: int,
    *,
    instruments: Optional[list[str]] = None,
    sol_min: Optional[int] = None,
    sol_max: Optional[int] = None,
    max_frames: int = 48,
    prefer: str = "NAVCAM",
) -> pd.DataFrame:
    """Pick posed frames with good angular diversity for a cylindrical pano."""
    img = load_images()
    mask = (img["site"] == site) & (img["drive"] == drive) & img["has_pose"]
    sub = img.loc[mask].copy()
    if sub.empty:
        return sub

    if instruments:
        up = {i.upper() for i in instruments}
        sub = sub[sub["instrument"].str.upper().isin(up)]
    else:
        # Prefer navcams for wide surround; fall back to all posed
        nav = sub[sub["instrument"].str.contains(prefer, case=False, na=False)]
        if len(nav) >= 8:
            sub = nav

    if sol_min is not None:
        sub = sub[sub["sol"].fillna(-1) >= sol_min]
    if sol_max is not None:
        sub = sub[sub["sol"].fillna(10**9) <= sol_max]

    sub = sub.dropna(subset=["look_x", "look_y", "look_z", "url_small"])
    if sub.empty:
        return sub

    # Angular diversity (greedy on unit look)
    looks = sub[["look_x", "look_y", "look_z"]].to_numpy(dtype=float)
    norms = np.linalg.norm(looks, axis=1, keepdims=True)
    norms = np.maximum(norms, 1e-12)
    looks = looks / norms

    # Prefer LEFT navcam slightly, then lower FOV instruments last for overlay
    def rank(inst: str) -> int:
        u = str(inst).upper()
        if "NAVCAM_LEFT" in u:
            return 0
        if "NAVCAM" in u:
            return 1
        if "MCZ" in u or "MASTCAM" in u:
            return 2
        return 3

    order = sorted(
        range(len(sub)),
        key=lambda i: (rank(sub.iloc[i]["instrument"]), float(sub.iloc[i].get("sol") or 0)),
    )

    picked: list[int] = []
    picked_looks: list[np.ndarray] = []
    min_dot = 0.965  # ~15° separation

    for i in order:
        if len(picked) >= max_frames:
            break
        L = looks[i]
        if any(float(np.dot(L, P)) > min_dot for P in picked_looks):
            continue
        picked.append(i)
        picked_looks.append(L)

    if not picked:
        # denser fill
        step = max(1, len(order) // max_frames)
        picked = order[::step][:max_frames]

    return sub.iloc[picked].reset_index(drop=True)


def _load_bgr(path: Path, max_side: int = 512) -> np.ndarray:
    assert cv2 is not None
    data = np.frombuffer(path.read_bytes(), dtype=np.uint8)
    bgr = cv2.imdecode(data, cv2.IMREAD_COLOR)
    if bgr is None:
        raise ValueError(f"decode failed: {path}")
    h, w = bgr.shape[:2]
    scale = min(1.0, float(max_side) / max(h, w))
    if scale < 1.0:
        bgr = cv2.resize(
            bgr, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA
        )
    return bgr


def _frame_basis(row: pd.Series) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    look = _unit(np.array([row["look_x"], row["look_y"], row["look_z"]], dtype=float))
    if look is None:
        look = np.array([1.0, 0.0, 0.0])
    up = None
    if pd.notna(row.get("up_x")) and pd.notna(row.get("up_y")) and pd.notna(row.get("up_z")):
        up = _unit(np.array([row["up_x"], row["up_y"], row["up_z"]], dtype=float))
    if up is None:
        # body up = −Z
        up = np.array([0.0, 0.0, -1.0])
        up = up - look * float(np.dot(up, look))
        nu = float(np.linalg.norm(up))
        up = up / nu if nu > 1e-9 else np.array([0.0, 1.0, 0.0])
    right = np.cross(look, up)
    nr = float(np.linalg.norm(right))
    if nr < 1e-9:
        right = np.array([0.0, 1.0, 0.0])
    else:
        right = right / nr
    up = np.cross(right, look)
    up = up / (float(np.linalg.norm(up)) + 1e-15)
    return look, up, right


def _az_el_to_dir(az: np.ndarray, el: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Body-frame unit directions from az/el (same convention as look_az_el)."""
    ce = np.cos(el)
    rx = ce * np.cos(az)
    ry = ce * np.sin(az)
    rz = -np.sin(el)
    return rx, ry, rz


def _sample_bilinear(bgr: np.ndarray, u: np.ndarray, v: np.ndarray) -> np.ndarray:
    """Bilinear sample BGR image at float coords (N,) → (N, 3) float32."""
    H, W = bgr.shape[:2]
    u0 = np.floor(u).astype(np.int32)
    v0 = np.floor(v).astype(np.int32)
    u1 = np.clip(u0 + 1, 0, W - 1)
    v1 = np.clip(v0 + 1, 0, H - 1)
    u0 = np.clip(u0, 0, W - 1)
    v0 = np.clip(v0, 0, H - 1)
    du = (u - u0).astype(np.float32)[:, None]
    dv = (v - v0).astype(np.float32)[:, None]
    img = bgr.astype(np.float32)
    Ia = img[v0, u0]
    Ib = img[v0, u1]
    Ic = img[v1, u0]
    Id = img[v1, u1]
    top = Ia * (1.0 - du) + Ib * du
    bot = Ic * (1.0 - du) + Id * du
    return top * (1.0 - dv) + bot * dv


def project_frame_to_cylinder(
    bgr: np.ndarray,
    look: np.ndarray,
    up: np.ndarray,
    right: np.ndarray,
    hfov_deg: float,
    vfov_deg: float,
    canvas: np.ndarray,
    weight: np.ndarray,
    *,
    az_min: float,
    az_span: float,
    el_min: float,
    el_span: float,
) -> int:
    """Inverse-map canvas pixels into the frame (bilinear) — no sparse holes.

    For each canvas pixel in the frame's FOV footprint, compute the body-frame
    ray from az/el, project into the camera, and bilinear-sample the source.
    """
    assert cv2 is not None
    H, W = bgr.shape[:2]
    out_h, out_w = canvas.shape[:2]
    hfov = math.radians(float(hfov_deg) if hfov_deg and hfov_deg > 1 else 45.0)
    vfov = math.radians(float(vfov_deg) if vfov_deg and vfov_deg > 1 else 34.0)
    fx = (W * 0.5) / math.tan(hfov * 0.5)
    fy = (H * 0.5) / math.tan(vfov * 0.5)
    cx_img = (W - 1) * 0.5
    cy_img = (H - 1) * 0.5

    # Footprint: project a dense grid of source corners/edges → canvas bbox
    # (forward map only to size the ROI — dense fill uses inverse)
    step_fwd = max(1, min(H, W) // 48)
    us = np.linspace(0, W - 1, max(8, W // step_fwd))
    vs = np.linspace(0, H - 1, max(8, H // step_fwd))
    uu, vv = np.meshgrid(us, vs)
    x = (uu - cx_img) / fx
    y = (vv - cy_img) / fy
    rx = look[0] + right[0] * x - up[0] * y
    ry = look[1] + right[1] * x - up[1] * y
    rz = look[2] + right[2] * x - up[2] * y
    nrm = np.sqrt(rx * rx + ry * ry + rz * rz) + 1e-12
    rx, ry, rz = rx / nrm, ry / nrm, rz / nrm
    az = np.arctan2(ry, rx)
    el = np.arctan2(-rz, np.hypot(rx, ry))
    # Map to canvas x; also ±2π for full-sphere wraps
    cands = [((az - az_min) / az_span) * out_w]
    if az_span > math.radians(300):
        cands.append(((az - az_min + 2 * math.pi) / az_span) * out_w)
        cands.append(((az - az_min - 2 * math.pi) / az_span) * out_w)
    cx = np.concatenate([c.ravel() for c in cands])
    cy_one = (((el_min + el_span - el) / el_span) * out_h).ravel()
    cy = np.concatenate([cy_one] * len(cands))
    valid = np.isfinite(cx) & np.isfinite(cy)
    if not np.any(valid):
        return 0
    cxv, cyv = cx[valid], cy[valid]
    # Keep points that land in or near the canvas
    near = (cxv > -out_w * 0.05) & (cxv < out_w * 1.05) & (cyv > -5) & (cyv < out_h + 5)
    if not np.any(near):
        return 0
    cxv, cyv = cxv[near], cyv[near]
    pad = 3
    x0 = int(max(0, math.floor(float(cxv.min())) - pad))
    x1 = int(min(out_w, math.ceil(float(cxv.max())) + pad + 1))
    y0 = int(max(0, math.floor(float(cyv.min())) - pad))
    y1 = int(min(out_h, math.ceil(float(cyv.max())) + pad + 1))
    if x1 <= x0 or y1 <= y0:
        return 0
    # Wide FOV near wrap: fill whole width strip for that elevation band
    if az_span > math.radians(300) and (x1 - x0) > out_w * 0.7:
        x0, x1 = 0, out_w

    cols = np.arange(x0, x1, dtype=np.float64)
    rows = np.arange(y0, y1, dtype=np.float64)
    if cols.size == 0 or rows.size == 0:
        return 0
    cc, rr = np.meshgrid(cols, rows)
    az_p = az_min + (cc + 0.5) / out_w * az_span
    el_p = el_min + el_span - (rr + 0.5) / out_h * el_span
    dx, dy, dz = _az_el_to_dir(az_p, el_p)

    # Camera coordinates: z along look, x right, y image-down
    zc = dx * look[0] + dy * look[1] + dz * look[2]
    xc = dx * right[0] + dy * right[1] + dz * right[2]
    yc = -(dx * up[0] + dy * up[1] + dz * up[2])

    in_front = zc > 0.05
    zc_safe = np.where(in_front, zc, 1.0)
    u = fx * (xc / zc_safe) + cx_img
    v = fy * (yc / zc_safe) + cy_img
    margin = 0.5
    in_img = (
        in_front
        & (u >= margin)
        & (u <= W - 1 - margin)
        & (v >= margin)
        & (v <= H - 1 - margin)
    )
    if not np.any(in_img):
        return 0

    uu = u[in_img]
    vv = v[in_img]
    oy = rr[in_img].astype(np.int32)
    ox = cc[in_img].astype(np.int32)
    pix = _sample_bilinear(bgr, uu, vv)

    # Feather: higher weight near optical center, soft edge falloff
    nu = np.abs(uu - cx_img) / (W * 0.5)
    nv = np.abs(vv - cy_img) / (H * 0.5)
    edge = np.clip(1.0 - np.maximum(nu, nv), 0.0, 1.0)
    wgt = (0.2 + 0.8 * (edge * edge)).astype(np.float32)

    for c in range(3):
        np.add.at(canvas[:, :, c], (oy, ox), pix[:, c] * wgt)
    np.add.at(weight, (oy, ox), wgt)
    return int(in_img.sum())


def _url_for_size(row: pd.Series, size: str) -> Optional[str]:
    """Pick best available NASA URL for the requested quality tier."""
    size = (size or "small").lower()
    order = {
        "small": ["url_small", "url_medium", "url_large", "url_full"],
        "medium": ["url_medium", "url_large", "url_full", "url_small"],
        "large": ["url_large", "url_full", "url_medium", "url_small"],
        "full": ["url_full", "url_large", "url_medium", "url_small"],
    }.get(size, ["url_small", "url_medium", "url_large", "url_full"])
    for key in order:
        u = row.get(key)
        if u is not None and str(u).startswith("http"):
            return str(u)
    return None


# Max source edge length per tier (keeps memory bounded on 4–8GB machines)
# Higher than before — inverse mapping needs dense source detail.
_SIZE_MAX_SIDE = {
    "small": 720,
    "medium": 1280,
    "large": 1920,
    "full": 2560,
}


def _stitch_bounds_cylinder(frames: pd.DataFrame) -> tuple[float, float, float, float]:
    """Return az_min, az_span, el_min, el_span for adaptive cylindrical crop."""
    els: list[float] = []
    for _, row in frames.iterrows():
        look, _, _ = _frame_basis(row)
        _, el = look_az_el(look)
        vf = math.radians(float(row.get("vfov_deg") or 34) * 0.55)
        els.extend([el - vf, el + vf])

    az_arr = np.array(
        [look_az_el(_frame_basis(r)[0])[0] for _, r in frames.iterrows()],
        dtype=float,
    )
    mean_az = math.atan2(float(np.mean(np.sin(az_arr))), float(np.mean(np.cos(az_arr))))
    rel = (az_arr - mean_az + math.pi) % (2 * math.pi) - math.pi
    pad = math.radians(25)
    az_min = mean_az + float(rel.min()) - pad
    az_max = mean_az + float(rel.max()) + pad
    az_span = max(az_max - az_min, math.radians(30))
    if az_span > math.radians(300):
        az_min = mean_az - math.pi
        az_span = 2 * math.pi

    el_min = max(min(els) - math.radians(5), math.radians(-85))
    el_max = min(max(els) + math.radians(5), math.radians(85))
    el_span = max(el_max - el_min, math.radians(20))
    return az_min, az_span, el_min, el_span


def stitch_pose_pano(
    frames: pd.DataFrame,
    *,
    out_width: int = 4096,
    out_height: int = 1024,
    thumb_size: str = "small",
    max_side: Optional[int] = None,
    projection: str = "cylinder",
) -> dict[str, Any]:
    """Build pose-driven pano (cylinder crop or full equirect) from frames."""
    if not _HAS_CV2:
        raise RuntimeError("OpenCV required for panorama encode")
    if frames.empty:
        raise ValueError("no frames to stitch")

    projection = (projection or "cylinder").lower()
    if projection not in ("cylinder", "equirect"):
        projection = "cylinder"

    thumb_size = (thumb_size or "small").lower()
    if thumb_size not in _SIZE_MAX_SIDE:
        thumb_size = "small"
    if max_side is None:
        max_side = _SIZE_MAX_SIDE[thumb_size]
    max_side = int(max(256, min(max_side, 4096)))

    out_width = int(max(1024, min(out_width, 8192)))

    if projection == "equirect":
        # Standard 2:1 equirectangular: full sphere
        az_min = -math.pi
        az_span = 2 * math.pi
        el_min = -math.pi / 2
        el_span = math.pi
        out_height = int(max(512, min(out_width // 2, 4096)))
        method = "pose_equirect_body_frame"
        note_proj = "Equirectangular 360×180 mosaic"
    else:
        az_min, az_span, el_min, el_span = _stitch_bounds_cylinder(frames)
        aspect = az_span / el_span
        out_height = int(max(256, min(out_height, int(out_width / aspect))))
        out_height = min(out_height, 2048)
        method = "pose_cylinder_body_frame"
        note_proj = "Cylindrical mosaic"

    canvas = np.zeros((out_height, out_width, 3), dtype=np.float32)
    weight = np.zeros((out_height, out_width), dtype=np.float32)

    used: list[dict[str, Any]] = []
    t0 = time.perf_counter()
    for _, row in frames.iterrows():
        imageid = str(row["imageid"])
        url = _url_for_size(row, thumb_size)
        if not url:
            continue
        try:
            path, _ = get_cached_or_fetch(imageid, thumb_size, url)
            bgr = _load_bgr(path, max_side=max_side)
        except Exception:
            continue
        look, up, right = _frame_basis(row)
        n = project_frame_to_cylinder(
            bgr,
            look,
            up,
            right,
            float(row.get("hfov_deg") or 45),
            float(row.get("vfov_deg") or 34),
            canvas,
            weight,
            az_min=az_min,
            az_span=az_span,
            el_min=el_min,
            el_span=el_span,
        )
        az, el = look_az_el(look)
        used.append(
            {
                "imageid": imageid,
                "instrument": str(row.get("instrument") or ""),
                "sol": int(row["sol"]) if pd.notna(row.get("sol")) else None,
                "az_deg": round(math.degrees(az), 2),
                "el_deg": round(math.degrees(el), 2),
                "pixels": n,
            }
        )

    if not used or float(weight.max()) <= 0:
        raise RuntimeError("no frames projected (image fetch or pose failed)")

    wmap = weight.copy()
    w = wmap[:, :, None]
    w = np.maximum(w, 1e-6)
    rgb = np.clip(canvas / w, 0, 255).astype(np.uint8)
    empty = wmap < 1e-4
    # Mild inpaint-style hole fill: dilate known pixels into empty (reduces speckles)
    if empty.any() and _HAS_CV2:
        known = (~empty).astype(np.uint8) * 255
        for _ in range(3):
            dil = cv2.dilate(known, np.ones((3, 3), np.uint8), iterations=1)
            ring = (dil > 0) & empty
            if not ring.any():
                break
            blurred = cv2.GaussianBlur(rgb, (5, 5), 0)
            rgb[ring] = blurred[ring]
            empty = empty & ~ring
            known = (~empty).astype(np.uint8) * 255
            wmap[ring] = 1e-3
    rgb[empty] = (28, 24, 20)

    # Crop empty borders (keep a small pad) so viewers don't zoom empty sky/ground
    if projection != "equirect" and (wmap > 1e-4).any():
        ys, xs = np.where(wmap > 1e-4)
        pad = 8
        y0 = max(0, int(ys.min()) - pad)
        y1 = min(rgb.shape[0], int(ys.max()) + pad + 1)
        x0 = max(0, int(xs.min()) - pad)
        x1 = min(rgb.shape[1], int(xs.max()) + pad + 1)
        if (y1 - y0) >= 64 and (x1 - x0) >= 128:
            # rescale angular meta for crop
            az_min_c = az_min + (x0 / out_width) * az_span
            az_span_c = ((x1 - x0) / out_width) * az_span
            el_max = el_min + el_span
            el_max_c = el_max - (y0 / out_height) * el_span
            el_min_c = el_max - (y1 / out_height) * el_span
            az_min, az_span = az_min_c, az_span_c
            el_min, el_span = el_min_c, el_max_c - el_min_c
            rgb = rgb[y0:y1, x0:x1]
            out_height, out_width = rgb.shape[:2]

    # Light denoise only on tiny residual speckles (preserve detail)
    if _HAS_CV2 and used:
        rgb = cv2.bilateralFilter(rgb, d=3, sigmaColor=10, sigmaSpace=3)

    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    # v2 in key: invalidate old sparse/pixelated cache
    key_src = (
        f"v2inv_{frames.iloc[0].get('site')}_{frames.iloc[0].get('drive')}_"
        f"{projection}_{thumb_size}_{max_side}_{len(used)}_{out_width}x{out_height}_"
        + ",".join(u["imageid"] for u in used[:12])
    )
    key = hashlib.sha256(key_src.encode()).hexdigest()[:20]
    out_path = CACHE_DIR / f"pano_{key}.jpg"
    quality = 92 if projection == "equirect" else 90
    cv2.imwrite(str(out_path), rgb, [int(cv2.IMWRITE_JPEG_QUALITY), quality])

    return {
        "path": out_path,
        "width": out_width,
        "height": out_height,
        "n_frames": len(used),
        "frames": used,
        "az_min_deg": math.degrees(az_min),
        "az_span_deg": math.degrees(az_span),
        "el_min_deg": math.degrees(el_min),
        "el_span_deg": math.degrees(el_span),
        "elapsed_ms": (time.perf_counter() - t0) * 1000.0,
        "method": method,
        "projection": projection,
        "frame": "body (+X fwd, +Y right, +Z down)",
        "source_size": thumb_size,
        "source_max_side": max_side,
        "note": (
            f"{note_proj} from metadata look/up/right + FOV "
            "(not feature-based stitching). "
            f"Source tier={thumb_size}, max edge={max_side}px."
        ),
    }


def stitch_pose_cylinder(
    frames: pd.DataFrame,
    *,
    out_width: int = 4096,
    out_height: int = 1024,
    thumb_size: str = "small",
    max_side: Optional[int] = None,
) -> dict[str, Any]:
    """Backward-compatible cylindrical stitch."""
    return stitch_pose_pano(
        frames,
        out_width=out_width,
        out_height=out_height,
        thumb_size=thumb_size,
        max_side=max_side,
        projection="cylinder",
    )


def build_stop_pano(
    site: int,
    drive: int,
    *,
    instruments: Optional[list[str]] = None,
    sol_min: Optional[int] = None,
    sol_max: Optional[int] = None,
    max_frames: int = 40,
    out_width: int = 4096,
    thumb_size: str = "small",
    max_side: Optional[int] = None,
    projection: str = "cylinder",
) -> dict[str, Any]:
    frames = select_pano_frames(
        site,
        drive,
        instruments=instruments,
        sol_min=sol_min,
        sol_max=sol_max,
        max_frames=max_frames,
    )
    if frames.empty:
        raise FileNotFoundError(
            f"No posed frames for pano at site={site} drive={drive}"
        )
    # Equirect benefits from more frames for surround fill
    if projection == "equirect" and max_frames < 48:
        frames = select_pano_frames(
            site,
            drive,
            instruments=instruments,
            sol_min=sol_min,
            sol_max=sol_max,
            max_frames=min(64, max(max_frames, 48)),
        )
    result = stitch_pose_pano(
        frames,
        out_width=out_width,
        thumb_size=thumb_size,
        max_side=max_side,
        projection=projection,
    )
    result["site"] = site
    result["drive"] = drive
    return result
