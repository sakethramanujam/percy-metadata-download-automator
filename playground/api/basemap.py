"""Proxy FU Berlin HRSC webGIS WMS for Jezero basemap imagery.

Source: https://maps.planet.fu-berlin.de/jezero/
WMS:    https://maps.planet.fu-berlin.de/jez-bin/wms?

Our MMGIS waypoints carry lon/lat that sit inside the Jezero CTX/HiRISE
coverage; we request a GetMap over that footprint and serve JPEG bytes
(avoid browser CORS + keep a small disk cache).
"""

from __future__ import annotations

import hashlib
import math
from pathlib import Path
from typing import Any, Optional
from urllib.parse import urlencode

import httpx

from playground.api import config
from playground.api.data import load_waypoints

# Jezero-focused MapServer (Away Team / FU Berlin Planetary Sciences)
FUB_JEZERO_WMS = "https://maps.planet.fu-berlin.de/jez-bin/wms?"

# Useful layers (from GetCapabilities)
LAYERS = {
    "ctx": "CTX-hsv",  # CTX mosaic (best full-traverse coverage)
    "hirise": "HiRISE-hsv",  # HiRISE strips (higher res, partial)
    "hrsc": "HRSC-hsv",  # regional HRSC color
    "base": "base-hsv",
}

DEFAULT_LAYER = "ctx"
USER_AGENT = "percy-metadata-playground/1.0 (+local; academic basemap)"
CACHE_DIR = config.DERIVED_DIR / "basemap_cache"
# Padding degrees around waypoint lon/lat hull (cover full traverse + margin)
PAD_DEG = 0.06
MAX_SIDE = 2048


def basemap_bbox_from_waypoints(
    pad_deg: float = PAD_DEG,
) -> Optional[dict[str, float]]:
    """Return lon/lat bbox covering MMGIS waypoints (+ pad)."""
    wp = load_waypoints()
    if wp.empty or "lon" not in wp.columns or "lat" not in wp.columns:
        return None
    sub = wp.dropna(subset=["lon", "lat"])
    if sub.empty:
        return None
    lon_min = float(sub["lon"].min()) - pad_deg
    lon_max = float(sub["lon"].max()) + pad_deg
    lat_min = float(sub["lat"].min()) - pad_deg
    lat_max = float(sub["lat"].max()) + pad_deg
    return {
        "lon_min": lon_min,
        "lon_max": lon_max,
        "lat_min": lat_min,
        "lat_max": lat_max,
    }


def _cache_path(key: str) -> Path:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    return CACHE_DIR / f"{key}.jpg"


def fetch_fub_basemap(
    *,
    layer_key: str = DEFAULT_LAYER,
    width: int = 1536,
    height: int = 1536,
    pad_deg: float = PAD_DEG,
    force: bool = False,
) -> dict[str, Any]:
    """
    Fetch a JPEG basemap for the current waypoint footprint.

    Returns dict with path, media_type, bbox, layer, attribution, bytes_cached.
    """
    layer = LAYERS.get(layer_key, LAYERS[DEFAULT_LAYER])
    bbox = basemap_bbox_from_waypoints(pad_deg=pad_deg)
    if not bbox:
        raise FileNotFoundError(
            "No waypoints with lon/lat. Run: python -m playground.pipeline.fetch_mmgis"
        )

    width = int(max(256, min(width, MAX_SIDE)))
    height = int(max(256, min(height, MAX_SIDE)))
    # Keep aspect roughly geographic (lon span * cos(lat) vs lat span)
    lat_mid = 0.5 * (bbox["lat_min"] + bbox["lat_max"])
    dlon = bbox["lon_max"] - bbox["lon_min"]
    dlat = bbox["lat_max"] - bbox["lat_min"]
    if dlon > 0 and dlat > 0:
        aspect = (dlon * math.cos(math.radians(lat_mid))) / dlat
        if aspect >= 1:
            height = max(256, int(round(width / aspect)))
        else:
            width = max(256, int(round(height * aspect)))
        width = min(width, MAX_SIDE)
        height = min(height, MAX_SIDE)

    # WMS 1.3.0 + EPSG:4326 uses lat,lon axis order for BBOX
    bbox_str = (
        f"{bbox['lat_min']},{bbox['lon_min']},"
        f"{bbox['lat_max']},{bbox['lon_max']}"
    )
    params = {
        "SERVICE": "WMS",
        "VERSION": "1.3.0",
        "REQUEST": "GetMap",
        "LAYERS": layer,
        "STYLES": "",
        "CRS": "EPSG:4326",
        "BBOX": bbox_str,
        "WIDTH": str(width),
        "HEIGHT": str(height),
        "FORMAT": "image/jpeg",
        "TRANSPARENT": "FALSE",
    }
    key_src = urlencode(sorted(params.items()))
    key = hashlib.sha256(key_src.encode()).hexdigest()[:24]
    path = _cache_path(key)

    if path.is_file() and not force and path.stat().st_size > 1000:
        return {
            "path": path,
            "media_type": "image/jpeg",
            "layer": layer,
            "layer_key": layer_key,
            "bbox": bbox,
            "width": width,
            "height": height,
            "cached": True,
            "source": FUB_JEZERO_WMS,
            "attribution": (
                "Basemap: FU Berlin Planetary Sciences / HRSC webGIS "
                "(https://maps.planet.fu-berlin.de/jezero/) · "
                "CTX/HiRISE/HRSC mosaics as served by MapServer"
            ),
        }

    url = FUB_JEZERO_WMS + urlencode(params)
    with httpx.Client(timeout=90.0, follow_redirects=True) as client:
        r = client.get(url, headers={"User-Agent": USER_AGENT})
        r.raise_for_status()
        ctype = r.headers.get("content-type", "")
        if "image" not in ctype and r.content[:2] != b"\xff\xd8":
            raise RuntimeError(
                f"WMS did not return an image (content-type={ctype}): "
                f"{r.content[:200]!r}"
            )
        path.write_bytes(r.content)

    return {
        "path": path,
        "media_type": "image/jpeg",
        "layer": layer,
        "layer_key": layer_key,
        "bbox": bbox,
        "width": width,
        "height": height,
        "cached": False,
        "source": FUB_JEZERO_WMS,
        "attribution": (
            "Basemap: FU Berlin Planetary Sciences / HRSC webGIS "
            "(https://maps.planet.fu-berlin.de/jezero/) · "
            "CTX/HiRISE/HRSC mosaics as served by MapServer"
        ),
    }


def list_basemap_layers() -> list[dict[str, str]]:
    return [
        {"key": k, "wms_layer": v, "endpoint": FUB_JEZERO_WMS}
        for k, v in LAYERS.items()
    ]
