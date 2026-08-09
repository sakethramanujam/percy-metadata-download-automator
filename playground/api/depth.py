"""Stereo depth helpers — OpenCV SGBM (CPU) or PyTorch block-matching (GPU)."""

from __future__ import annotations

import time
from typing import Any, Optional

import numpy as np

try:
    import cv2

    _HAS_CV2 = True
except ImportError:  # pragma: no cover
    cv2 = None  # type: ignore
    _HAS_CV2 = False

from playground.api.gpu import gpu_info, torch_device


def has_opencv() -> bool:
    return _HAS_CV2


def has_torch_cuda() -> bool:
    return bool(gpu_info().get("cuda_available"))


def decode_image_bytes(data: bytes, max_side: int = 640) -> np.ndarray:
    """Decode image bytes to grayscale uint8 HxW, optionally downscaled."""
    if not _HAS_CV2:
        raise RuntimeError("opencv not installed")
    arr = np.frombuffer(data, dtype=np.uint8)
    bgr = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if bgr is None:
        raise ValueError("failed to decode image")
    h, w = bgr.shape[:2]
    scale = min(1.0, float(max_side) / max(h, w))
    if scale < 1.0:
        bgr = cv2.resize(
            bgr,
            (int(w * scale), int(h * scale)),
            interpolation=cv2.INTER_AREA,
        )
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    return gray


def compute_disparity(
    left_gray: np.ndarray,
    right_gray: np.ndarray,
    *,
    num_disparities: int = 96,
    block_size: int = 7,
    prefer_gpu: bool = True,
) -> dict[str, Any]:
    """Run stereo matching; return disparity stats + PNG preview.

    Uses PyTorch GPU block-matching when CUDA is available, else OpenCV SGBM.
    """
    if left_gray.shape != right_gray.shape:
        h = min(left_gray.shape[0], right_gray.shape[0])
        w = min(left_gray.shape[1], right_gray.shape[1])
        left_gray = left_gray[:h, :w]
        right_gray = right_gray[:h, :w]

    nd = max(16, int(num_disparities))
    nd = nd - (nd % 16)
    bs = max(5, int(block_size) | 1)

    t0 = time.perf_counter()
    backend = "opencv_sgbm"
    raw: np.ndarray

    if prefer_gpu and has_torch_cuda():
        try:
            raw = _torch_stereo_sad(
                left_gray, right_gray, max_disp=nd, window=bs
            )
            backend = "torch_cuda_sad"
        except Exception:
            raw = _opencv_sgbm(left_gray, right_gray, nd=nd, bs=bs)
            backend = "opencv_sgbm_fallback"
    else:
        if not _HAS_CV2:
            raise RuntimeError("opencv not installed and no CUDA torch")
        raw = _opencv_sgbm(left_gray, right_gray, nd=nd, bs=bs)

    elapsed_ms = (time.perf_counter() - t0) * 1000.0
    valid = raw > 0
    n_valid = int(valid.sum())
    if n_valid == 0:
        stats = {
            "n_valid": 0,
            "disp_min": None,
            "disp_max": None,
            "disp_mean": None,
            "disp_median": None,
        }
        preview = _colorize_disparity(raw, valid)
        return {
            "stats": stats,
            "preview_png": preview,
            "shape": list(raw.shape),
            "backend": backend,
            "elapsed_ms": elapsed_ms,
            "device": gpu_info().get("device"),
        }

    vals = raw[valid]
    stats = {
        "n_valid": n_valid,
        "n_pixels": int(raw.size),
        "valid_frac": float(n_valid / raw.size),
        "disp_min": float(np.min(vals)),
        "disp_max": float(np.max(vals)),
        "disp_mean": float(np.mean(vals)),
        "disp_median": float(np.median(vals)),
    }
    preview = _colorize_disparity(raw, valid)
    return {
        "stats": stats,
        "preview_png": preview,
        "shape": list(raw.shape),
        "num_disparities": nd,
        "block_size": bs,
        "backend": backend,
        "elapsed_ms": elapsed_ms,
        "device": gpu_info().get("name") or gpu_info().get("device"),
        "disparity": raw,  # for optional point-cloud export
    }


def _opencv_sgbm(
    left_gray: np.ndarray, right_gray: np.ndarray, *, nd: int, bs: int
) -> np.ndarray:
    assert cv2 is not None
    matcher = cv2.StereoSGBM_create(
        minDisparity=0,
        numDisparities=nd,
        blockSize=bs,
        P1=8 * 1 * bs * bs,
        P2=32 * 1 * bs * bs,
        disp12MaxDiff=1,
        uniquenessRatio=10,
        speckleWindowSize=100,
        speckleRange=2,
        mode=cv2.STEREO_SGBM_MODE_SGBM_3WAY,
    )
    return matcher.compute(left_gray, right_gray).astype(np.float32) / 16.0


def _torch_stereo_sad(
    left_gray: np.ndarray,
    right_gray: np.ndarray,
    *,
    max_disp: int = 64,
    window: int = 7,
) -> np.ndarray:
    """GPU multi-disparity SAD stereo (vectorized for CUDA occupancy).

    Builds a cost volume on GPU: for each d, |L − shift(R,d)| averaged in a
    window, then winner-take-all + uniqueness. Tuned for ~4GB Pascal cards
    (e.g. GTX 1050 Ti) by streaming disparity slabs.
    """
    import torch
    import torch.nn.functional as F

    device = torch_device()
    w = max(3, int(window) | 1)
    pad = w // 2
    H, W = left_gray.shape

    L = torch.from_numpy(left_gray).to(device=device, dtype=torch.float32).div_(255.0)
    R = torch.from_numpy(right_gray).to(device=device, dtype=torch.float32).div_(255.0)
    L = L.view(1, 1, H, W)
    R = R.view(1, 1, H, W)

    # Pre-pad R once for max shift
    Rpad = F.pad(R, (max_disp - 1, 0, 0, 0))  # left-pad so we can slice any d

    best_cost = torch.full((H, W), 1e9, device=device)
    best_disp = torch.zeros((H, W), device=device, dtype=torch.float32)
    second_cost = torch.full((H, W), 1e9, device=device)

    # Larger batches on GPU — 1050 Ti 4GB: 16 * 720 * 960 * 4 ≈ 44MB per slab
    batch = 16 if max(H, W) <= 800 else 8
    for d0 in range(0, max_disp, batch):
        d1 = min(d0 + batch, max_disp)
        ds = d1 - d0
        # Stack shifted right images for this slab: (ds,1,H,W)
        slabs = []
        for d in range(d0, d1):
            # Rpad width = W + max_disp - 1; take [max_disp-1-d : max_disp-1-d+W]
            start = (max_disp - 1) - d
            slabs.append(Rpad[:, :, :, start : start + W])
        Rstack = torch.cat(slabs, dim=0)  # ds x 1 x H x W
        Lstack = L.expand(ds, -1, -1, -1)
        diff = (Lstack - Rstack).abs()
        # Box-filter SAD: depthwise avg pool over each channel independently
        cost = F.avg_pool2d(diff, kernel_size=w, stride=1, padding=pad)
        cost = cost.squeeze(1)  # ds x H x W
        cmin, amin = cost.min(dim=0)
        better = cmin < best_cost
        second_cost = torch.where(better, best_cost, torch.minimum(second_cost, cmin))
        best_disp = torch.where(better, amin.float() + float(d0), best_disp)
        best_cost = torch.where(better, cmin, best_cost)
        del slabs, Rstack, Lstack, diff, cost

    uniq = 0.08
    unique_ok = second_cost > best_cost * (1.0 + uniq)
    xs = torch.arange(W, device=device).view(1, W).expand(H, W)
    valid = unique_ok & (xs >= best_disp) & (best_disp > 0)
    disp = torch.where(valid, best_disp, torch.zeros_like(best_disp))
    out = disp.detach().cpu().numpy()
    if device.type == "cuda":
        torch.cuda.empty_cache()
    return out


def decode_color_bytes(data: bytes, max_side: int = 640) -> np.ndarray:
    """Decode image bytes to RGB uint8 HxWx3, optionally downscaled."""
    if not _HAS_CV2:
        raise RuntimeError("opencv not installed")
    arr = np.frombuffer(data, dtype=np.uint8)
    bgr = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if bgr is None:
        raise ValueError("failed to decode image")
    h, w = bgr.shape[:2]
    scale = min(1.0, float(max_side) / max(h, w))
    if scale < 1.0:
        bgr = cv2.resize(
            bgr,
            (int(w * scale), int(h * scale)),
            interpolation=cv2.INTER_AREA,
        )
    return cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)


def disparity_to_point_cloud(
    disparity: np.ndarray,
    *,
    baseline_m: float,
    focal_px: float,
    cx: Optional[float] = None,
    cy: Optional[float] = None,
    max_points: int = 20000,
    min_disp: float = 0.5,
    max_depth_m: float = 80.0,
    color_rgb: Optional[np.ndarray] = None,
) -> dict[str, Any]:
    """Back-project disparity to a camera-frame point cloud (x right, y down, z forward).

    Optional ``color_rgb`` (HxWx3 uint8, same resolution as disparity) samples RGB
    per point for textured clouds.
    """
    h, w = disparity.shape
    if cx is None:
        cx = w * 0.5
    if cy is None:
        cy = h * 0.5
    valid = disparity > min_disp
    ys, xs = np.where(valid)
    if ys.size == 0:
        return {"n": 0, "points": [], "colors": None, "frame": "camera"}
    d = disparity[ys, xs].astype(np.float64)
    z = focal_px * baseline_m / d
    # Drop absurd depths (noise / tiny disparity)
    keep = (z > 0.05) & (z < max_depth_m) & np.isfinite(z)
    ys, xs, z, d = ys[keep], xs[keep], z[keep], d[keep]
    if ys.size == 0:
        return {"n": 0, "points": [], "colors": None, "frame": "camera"}
    x = (xs.astype(np.float64) - cx) * z / focal_px
    y = (ys.astype(np.float64) - cy) * z / focal_px
    pts = np.stack([x, y, z], axis=1)
    colors: Optional[np.ndarray] = None
    if color_rgb is not None and color_rgb.shape[:2] == (h, w):
        colors = color_rgb[ys, xs].astype(np.float32) / 255.0
    # subsample evenly in pixel order
    if pts.shape[0] > max_points:
        idx = np.linspace(0, pts.shape[0] - 1, max_points).astype(int)
        pts = pts[idx]
        if colors is not None:
            colors = colors[idx]
    out: dict[str, Any] = {
        "n": int(pts.shape[0]),
        "points": pts.astype(np.float32).tolist(),
        "shape": [h, w],
        "frame": "camera",
    }
    if colors is not None:
        out["colors"] = colors.astype(np.float32).tolist()
    else:
        out["colors"] = None
    return out


def camera_cloud_to_body(
    cloud: dict[str, Any],
    *,
    origin: np.ndarray,
    look: np.ndarray,
    up: np.ndarray,
    right: Optional[np.ndarray] = None,
) -> dict[str, Any]:
    """Map camera-frame points (X right, Y down, Z forward) into rover body frame.

    body_p = origin + X * right + Y * down + Z * look, with down = −up.
    """
    pts_list = cloud.get("points") or []
    if not pts_list:
        return {
            "n": 0,
            "points": [],
            "colors": cloud.get("colors"),
            "frame": "body",
            "origin": origin.astype(float).tolist(),
        }
    pts = np.asarray(pts_list, dtype=np.float64)
    o = np.asarray(origin, dtype=np.float64).reshape(3)
    l = np.asarray(look, dtype=np.float64).reshape(3)
    u = np.asarray(up, dtype=np.float64).reshape(3)
    ln = np.linalg.norm(l)
    un = np.linalg.norm(u)
    if ln < 1e-9 or un < 1e-9:
        return {**cloud, "frame": "camera", "note": "missing look/up; left in camera frame"}
    l = l / ln
    u = u / un
    # make up ⊥ look
    u = u - l * float(np.dot(u, l))
    un = np.linalg.norm(u)
    if un < 1e-9:
        u = np.array([0.0, 0.0, -1.0])
    else:
        u = u / un
    if right is not None:
        r = np.asarray(right, dtype=np.float64).reshape(3)
        rn = np.linalg.norm(r)
        r = r / rn if rn > 1e-9 else np.cross(l, u)
    else:
        r = np.cross(l, u)
    rn = np.linalg.norm(r)
    if rn < 1e-9:
        r = np.array([0.0, 1.0, 0.0])
    else:
        r = r / rn
    # re-orthonormalize up
    u = np.cross(r, l)
    un = np.linalg.norm(u)
    if un > 1e-9:
        u = u / un
    down = -u
    # pts: Nx3 camera (X, Y, Z)
    body = o + pts[:, 0:1] * r + pts[:, 1:2] * down + pts[:, 2:3] * l
    return {
        "n": int(body.shape[0]),
        "points": body.astype(np.float32).tolist(),
        "colors": cloud.get("colors"),
        "frame": "body",
        "origin": o.astype(float).tolist(),
        "shape": cloud.get("shape"),
    }


def _colorize_disparity(disp: np.ndarray, valid: np.ndarray) -> bytes:
    """Return a PNG (turbo colormap) of normalized disparity."""
    if not _HAS_CV2:
        # minimal PNG via raw if no cv2 — shouldn't happen in practice
        raise RuntimeError("opencv required for preview encode")
    assert cv2 is not None
    out = np.zeros((*disp.shape, 3), dtype=np.uint8)
    if valid.any():
        v = disp[valid]
        lo, hi = np.percentile(v, [5, 95])
        if hi <= lo:
            hi = lo + 1.0
        norm = np.clip((disp - lo) / (hi - lo), 0, 1)
        u8 = (norm * 255).astype(np.uint8)
        color = cv2.applyColorMap(u8, cv2.COLORMAP_TURBO)
        out[valid] = color[valid]
    ok, buf = cv2.imencode(".png", out)
    if not ok:
        raise RuntimeError("png encode failed")
    return bytes(buf)


def approximate_depth_m(
    disparity: float,
    baseline_m: float,
    focal_px: float,
) -> Optional[float]:
    """Z ≈ f * B / d (simple pinhole stereo)."""
    if disparity is None or disparity <= 0 or baseline_m <= 0 or focal_px <= 0:
        return None
    return float(focal_px * baseline_m / disparity)
