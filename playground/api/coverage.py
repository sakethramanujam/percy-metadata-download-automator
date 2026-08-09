"""Pose-space coverage for a stop: look azimuth × elevation density.

Body frame (same as pano):
  az about vertical (up = −Z), 0 = +X forward, +az toward +Y (right)
  el elevation above horizontal (positive toward −Z / sky)
"""

from __future__ import annotations

import base64
import math
from typing import Any, Optional

import numpy as np
import pandas as pd

from playground.api.data import load_images
from playground.api.pano import look_az_el, _unit

try:
    import cv2

    _HAS_CV2 = True
except ImportError:  # pragma: no cover
    cv2 = None  # type: ignore
    _HAS_CV2 = False


def _instrument_family(inst: str) -> str:
    u = (inst or "").upper()
    if "NAVCAM" in u:
        return "NAVCAM"
    if "MCZ" in u or "MASTCAM" in u:
        return "MCZ"
    if "HAZCAM" in u:
        return "HAZCAM"
    if "SUPERCAM" in u:
        return "SUPERCAM"
    return "OTHER"


def stop_coverage(
    site: int,
    drive: int,
    *,
    az_bins: int = 72,
    el_bins: int = 36,
    instruments: Optional[list[str]] = None,
    sol_min: Optional[int] = None,
    sol_max: Optional[int] = None,
    fill_fov: bool = True,
) -> dict[str, Any]:
    """Build az/el coverage heatmap from posed cameras at a stop.

    Returns counts grid, look samples, coverage stats, and optional PNG preview.
    """
    az_bins = int(max(12, min(az_bins, 360)))
    el_bins = int(max(8, min(el_bins, 180)))

    img = load_images()
    mask = (img["site"] == site) & (img["drive"] == drive) & img["has_pose"]
    sub = img.loc[mask].copy()
    if instruments:
        up = {i.upper() for i in instruments}
        sub = sub[sub["instrument"].str.upper().isin(up)]
    if sol_min is not None:
        sub = sub[sub["sol"].fillna(-1) >= sol_min]
    if sol_max is not None:
        sub = sub[sub["sol"].fillna(10**9) <= sol_max]
    sub = sub.dropna(subset=["look_x", "look_y", "look_z"])

    # Grid: az ∈ [-π, π), el ∈ [-π/2, π/2]
    counts = np.zeros((el_bins, az_bins), dtype=np.float32)
    look_counts = np.zeros((el_bins, az_bins), dtype=np.float32)
    by_family: dict[str, int] = {}
    samples: list[dict[str, Any]] = []

    def bin_az_el(az: float, el: float) -> tuple[int, int]:
        # az: map [-pi, pi) → [0, az_bins)
        a = (az + math.pi) / (2 * math.pi)
        a = min(0.999999, max(0.0, a))
        e = (el + math.pi / 2) / math.pi
        e = min(0.999999, max(0.0, e))
        ia = int(a * az_bins)
        ie = int(e * el_bins)
        # flip el so sky is top of image
        ie = el_bins - 1 - ie
        return ie, ia

    for _, row in sub.iterrows():
        look = _unit(
            np.array(
                [row["look_x"], row["look_y"], row["look_z"]],
                dtype=float,
            )
        )
        if look is None:
            continue
        az, el = look_az_el(look)
        fam = _instrument_family(str(row.get("instrument") or ""))
        by_family[fam] = by_family.get(fam, 0) + 1

        ie, ia = bin_az_el(az, el)
        look_counts[ie, ia] += 1.0
        counts[ie, ia] += 1.0

        if fill_fov:
            hf = math.radians(float(row.get("hfov_deg") or 45) * 0.5)
            vf = math.radians(float(row.get("vfov_deg") or 34) * 0.5)
            # Coarse FOV footprint on sphere (grid steps)
            n_az = max(3, int(hf / (2 * math.pi / az_bins)) + 1)
            n_el = max(2, int(vf / (math.pi / el_bins)) + 1)
            for da in np.linspace(-hf, hf, n_az):
                for de in np.linspace(-vf, vf, n_el):
                    # Approximate local plane: small rotation of look
                    # Use az/el offsets directly (good enough for coverage QA)
                    a2 = az + float(da) / max(math.cos(el), 0.15)
                    e2 = el + float(de)
                    e2 = max(-math.pi / 2 + 1e-3, min(math.pi / 2 - 1e-3, e2))
                    # wrap az
                    a2 = (a2 + math.pi) % (2 * math.pi) - math.pi
                    ie2, ia2 = bin_az_el(a2, e2)
                    counts[ie2, ia2] += 0.15  # soft fill weight

        if len(samples) < 400:
            samples.append(
                {
                    "imageid": str(row["imageid"]),
                    "instrument": str(row.get("instrument") or ""),
                    "family": fam,
                    "sol": int(row["sol"]) if pd.notna(row.get("sol")) else None,
                    "az_deg": round(math.degrees(az), 2),
                    "el_deg": round(math.degrees(el), 2),
                }
            )

    n_cams = int(look_counts.sum())
    n_cells = az_bins * el_bins
    # Hemisphere-ish useful band: |el| < 60° often more relevant; report both
    filled = int((look_counts > 0).sum())
    filled_fov = int((counts > 0.05).sum())
    coverage_look = float(filled / n_cells) if n_cells else 0.0
    coverage_fov = float(filled_fov / n_cells) if n_cells else 0.0

    # Useful band: el from -30° to +50°
    el_edges = np.linspace(-90, 90, el_bins + 1)
    el_centers = 0.5 * (el_edges[:-1] + el_edges[1:])
    # rows are flipped (sky top): row 0 = +90
    useful_mask = np.zeros(el_bins, dtype=bool)
    for i, ec in enumerate(el_centers):
        # after flip: row i corresponds to el from top
        el_val = 90 - (i + 0.5) * (180 / el_bins)
        useful_mask[i] = -30 <= el_val <= 50
    useful_cells = int(useful_mask.sum() * az_bins)
    useful_filled = int((look_counts[useful_mask] > 0).sum()) if useful_cells else 0
    coverage_useful = float(useful_filled / useful_cells) if useful_cells else 0.0

    preview_b64 = None
    if _HAS_CV2 and n_cams > 0:
        preview_b64 = _encode_heatmap_png(counts, look_counts)

    return {
        "site": site,
        "drive": drive,
        "n_posed": n_cams,
        "az_bins": az_bins,
        "el_bins": el_bins,
        "az_range_deg": [-180, 180],
        "el_range_deg": [-90, 90],
        "frame": "body (+X fwd, +Y right, +Z down); az 0 = forward",
        "counts": counts.tolist(),  # soft FOV-weighted
        "look_counts": look_counts.tolist(),
        "by_family": by_family,
        "samples": samples,
        "stats": {
            "n_posed": n_cams,
            "cells_with_look": filled,
            "cells_with_fov": filled_fov,
            "coverage_look_frac": round(coverage_look, 4),
            "coverage_fov_frac": round(coverage_fov, 4),
            "coverage_useful_frac": round(coverage_useful, 4),
            "useful_band_el_deg": [-30, 50],
            "max_look_bin": int(look_counts.max()) if n_cams else 0,
        },
        "preview_data_url": (
            f"data:image/png;base64,{preview_b64}" if preview_b64 else None
        ),
        "note": (
            "Look-center density + soft FOV footprint on the body-frame "
            "azimuth×elevation sphere. Useful band = el −30°…+50°."
        ),
    }


def _encode_heatmap_png(counts: np.ndarray, look_counts: np.ndarray) -> str:
    assert cv2 is not None
    # Log scale for soft counts, overlay look centers as white dots intensity
    soft = counts.astype(np.float32)
    if soft.max() > 0:
        soft = np.log1p(soft)
        soft = soft / soft.max()
    u8 = (soft * 255).astype(np.uint8)
    color = cv2.applyColorMap(u8, cv2.COLORMAP_TURBO)
    # Dim empty
    empty = counts < 1e-6
    color[empty] = (22, 20, 18)
    # Brighten pure look bins
    if look_counts.max() > 0:
        lc = look_counts / look_counts.max()
        for c in range(3):
            color[:, :, c] = np.clip(
                color[:, :, c].astype(np.float32) * (0.75 + 0.5 * lc),
                0,
                255,
            ).astype(np.uint8)
    # Upscale for readability
    h, w = color.shape[:2]
    color = cv2.resize(
        color, (w * 4, h * 4), interpolation=cv2.INTER_NEAREST
    )
    # Axis ticks: draw crosshair at forward (az=0 → center of az range)
    H, W = color.shape[:2]
    cx = W // 2  # az=0
    cy = int(H * (90 - 0) / 180)  # el=0
    cv2.line(color, (cx, 0), (cx, H - 1), (200, 200, 200), 1)
    cv2.line(color, (0, cy), (W - 1, cy), (200, 200, 200), 1)
    ok, buf = cv2.imencode(".png", color)
    if not ok:
        raise RuntimeError("png encode failed")
    return base64.b64encode(bytes(buf)).decode("ascii")
