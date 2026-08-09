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
    """Splat one frame onto cylindrical canvas (azimuth × elevation). Returns pixel count."""
    assert cv2 is not None
    H, W = bgr.shape[:2]
    out_h, out_w = canvas.shape[:2]
    hfov = math.radians(float(hfov_deg) if hfov_deg and hfov_deg > 1 else 45.0)
    vfov = math.radians(float(vfov_deg) if vfov_deg and vfov_deg > 1 else 34.0)
    fx = (W * 0.5) / math.tan(hfov * 0.5)
    fy = (H * 0.5) / math.tan(vfov * 0.5)

    # Subsample source for speed on large thumbs
    step = 1 if max(H, W) <= 400 else 2
    us = np.arange(0, W, step, dtype=np.float64)
    vs = np.arange(0, H, step, dtype=np.float64)
    uu, vv = np.meshgrid(us, vs)
    # Camera rays: +look, +right * x, −up * y  (y image-down)
    x = (uu - (W - 1) * 0.5) / fx
    y = (vv - (H - 1) * 0.5) / fy
    # ray = look + right*x - up*y
    rx = look[0] + right[0] * x - up[0] * y
    ry = look[1] + right[1] * x - up[1] * y
    rz = look[2] + right[2] * x - up[2] * y
    norm = np.sqrt(rx * rx + ry * ry + rz * rz) + 1e-12
    rx, ry, rz = rx / norm, ry / norm, rz / norm

    az = np.arctan2(ry, rx)
    el = np.arctan2(-rz, np.hypot(rx, ry))

    # Canvas coordinates
    cx = ((az - az_min) / az_span) * out_w
    cy = ((el_min + el_span - el) / el_span) * out_h  # el up → row decreases
    cx_i = np.rint(cx).astype(np.int32)
    cy_i = np.rint(cy).astype(np.int32)
    m = (cx_i >= 0) & (cx_i < out_w) & (cy_i >= 0) & (cy_i < out_h)
    if not np.any(m):
        return 0

    # Feather weight: higher near optical center
    wu = 1.0 - np.abs(uu - (W - 1) * 0.5) / (W * 0.5 + 1e-6)
    wv = 1.0 - np.abs(vv - (H - 1) * 0.5) / (H * 0.5 + 1e-6)
    wgt = np.clip(wu, 0, 1) * np.clip(wv, 0, 1)
    wgt = wgt * wgt + 0.05

    ui = uu[m].astype(np.int32)
    vi = vv[m].astype(np.int32)
    ox = cx_i[m]
    oy = cy_i[m]
    ww = wgt[m].astype(np.float32)
    pix = bgr[vi, ui].astype(np.float32)

    # Accumulate (vectorized scatter-add via loop on unique — numpy add.at)
    for c in range(3):
        np.add.at(canvas[:, :, c], (oy, ox), pix[:, c] * ww)
    np.add.at(weight, (oy, ox), ww)
    return int(m.sum())


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
_SIZE_MAX_SIDE = {
    "small": 480,
    "medium": 960,
    "large": 1600,
    "full": 2048,
}


def stitch_pose_cylinder(
    frames: pd.DataFrame,
    *,
    out_width: int = 4096,
    out_height: int = 1024,
    thumb_size: str = "small",
    max_side: Optional[int] = None,
) -> dict[str, Any]:
    """Build cylindrical pano from posed frames; returns path + meta."""
    if not _HAS_CV2:
        raise RuntimeError("OpenCV required for panorama encode")
    if frames.empty:
        raise ValueError("no frames to stitch")

    thumb_size = (thumb_size or "small").lower()
    if thumb_size not in _SIZE_MAX_SIDE:
        thumb_size = "small"
    if max_side is None:
        max_side = _SIZE_MAX_SIDE[thumb_size]
    max_side = int(max(256, min(max_side, 4096)))

    # Az/el bounds from look centers expanded by half FOV
    azs: list[float] = []
    els: list[float] = []
    for _, row in frames.iterrows():
        look, _, _ = _frame_basis(row)
        az, el = look_az_el(look)
        hf = math.radians(float(row.get("hfov_deg") or 45) * 0.55)
        vf = math.radians(float(row.get("vfov_deg") or 34) * 0.55)
        azs.extend([az - hf, az + hf])
        els.extend([el - vf, el + vf])

    # Unwrap azimuth to a continuous span covering the set
    az_arr = np.array(
        [look_az_el(_frame_basis(r)[0])[0] for _, r in frames.iterrows()],
        dtype=float,
    )
    # Choose origin near circular mean
    mean_az = math.atan2(float(np.mean(np.sin(az_arr))), float(np.mean(np.cos(az_arr))))
    # Relative az in [-pi, pi]
    rel = (az_arr - mean_az + math.pi) % (2 * math.pi) - math.pi
    pad = math.radians(25)
    az_min = mean_az + float(rel.min()) - pad
    az_max = mean_az + float(rel.max()) + pad
    az_span = max(az_max - az_min, math.radians(30))
    # If nearly full surround, force 360°
    if az_span > math.radians(300):
        az_min = mean_az - math.pi
        az_span = 2 * math.pi

    el_min = max(min(els) - math.radians(5), math.radians(-85))
    el_max = min(max(els) + math.radians(5), math.radians(85))
    el_span = max(el_max - el_min, math.radians(20))

    # Aspect from angular span
    out_width = int(max(1024, min(out_width, 8192)))
    aspect = az_span / el_span
    out_height = int(max(256, min(out_height, int(out_width / aspect))))
    out_height = min(out_height, 2048)

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
            # cache key includes size tier so small/medium/large don't collide
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

    # Normalize blend
    w = weight[:, :, None]
    w = np.maximum(w, 1e-6)
    rgb = np.clip(canvas / w, 0, 255).astype(np.uint8)
    # Fill holes with dark grey so viewer isn't pure black
    empty = weight < 1e-5
    rgb[empty] = (28, 24, 20)

    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    key_src = (
        f"{frames.iloc[0].get('site')}_{frames.iloc[0].get('drive')}_"
        f"{thumb_size}_{max_side}_{len(used)}_{out_width}x{out_height}_"
        + ",".join(u["imageid"] for u in used[:12])
    )
    key = hashlib.sha256(key_src.encode()).hexdigest()[:20]
    out_path = CACHE_DIR / f"pano_{key}.jpg"
    cv2.imwrite(str(out_path), rgb, [int(cv2.IMWRITE_JPEG_QUALITY), 88])

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
        "method": "pose_cylinder_body_frame",
        "frame": "body (+X fwd, +Y right, +Z down)",
        "source_size": thumb_size,
        "source_max_side": max_side,
        "note": (
            "Cylindrical mosaic from metadata look/up/right + FOV "
            "(not feature-based stitching). "
            f"Source tier={thumb_size}, max edge={max_side}px."
        ),
    }


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
    result = stitch_pose_cylinder(
        frames,
        out_width=out_width,
        thumb_size=thumb_size,
        max_side=max_side,
    )
    result["site"] = site
    result["drive"] = drive
    return result
