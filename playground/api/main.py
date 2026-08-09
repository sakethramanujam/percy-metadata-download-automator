"""FastAPI entrypoint for the Percy playground."""

from __future__ import annotations

import base64
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

from playground.api import config
from playground.api.cache import get_cached_or_fetch
from playground.api.data import (
    IndexNotBuiltError,
    cameras_for_stop,
    get_image,
    list_stops,
    list_traverse_segments,
    list_waypoints,
    load_manifest,
    map_bundle,
    reload_indexes,
    site_world,
    stats,
    stereo_pairs_for_stop,
)
from playground.api.basemap import fetch_fub_basemap, list_basemap_layers
from playground.api.coverage import stop_coverage
from playground.api.depth import (
    approximate_depth_m,
    camera_cloud_to_body,
    compute_disparity,
    decode_color_bytes,
    decode_image_bytes,
    disparity_to_point_cloud,
    has_opencv,
    has_torch_cuda,
)
from playground.api.gpu import gpu_info
from playground.api.pano import build_stop_pano

app = FastAPI(
    title="Percy Metadata Playground API",
    version="0.1.0",
    description="Query derived Mars 2020 image poses for the local 3D playground.",
)

# Local playground: allow LAN access via machine IP (Vite proxy + direct API).
_cors_origins = config.cors_origins()
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins if _cors_origins != ["*"] else ["*"],
    allow_credentials=_cors_origins != ["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def _warmup_gpu() -> None:
    """Touch CUDA once so the first stereo request is not a cold compile."""
    try:
        if not has_torch_cuda():
            return
        import torch

        x = torch.zeros(8, 8, device="cuda")
        _ = x @ x
        torch.cuda.synchronize()
    except Exception:
        pass


# Warm GPU at import (best-effort; ignores failures on CPU-only hosts)
_warmup_gpu()


@app.get("/api/health")
def health():
    g = gpu_info()
    base = {
        "ok": True,
        "gpu": {
            "cuda": g.get("cuda_available"),
            "name": g.get("name"),
            "vram_mb": g.get("vram_mb"),
            "device": g.get("device"),
            "torch": g.get("torch"),
        },
    }
    try:
        m = load_manifest()
        return {
            **base,
            "index": True,
            "n_images": m.get("n_images"),
            "built_at": m.get("built_at"),
        }
    except IndexNotBuiltError:
        return {
            **base,
            "index": False,
            "hint": "Run python -m playground.pipeline.build_index",
        }


@app.get("/api/gpu")
def api_gpu():
    """Detailed GPU / compute capability for the playground."""
    g = gpu_info()
    return {
        **g,
        "stereo_backend": (
            "torch_cuda_sad" if g.get("cuda_available") else "opencv_sgbm"
        ),
        "opencv": has_opencv(),
        "torch_cuda": has_torch_cuda(),
    }


@app.post("/api/reload")
def reload():
    reload_indexes()
    return {"reloaded": True}


@app.get("/api/stats")
def api_stats():
    try:
        return stats()
    except IndexNotBuiltError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e


@app.get("/api/stops")
def api_stops(
    sol_min: Optional[int] = None,
    sol_max: Optional[int] = None,
    min_images: int = Query(0, ge=0),
    map_only: bool = False,
):
    try:
        return {
            "stops": list_stops(
                sol_min=sol_min,
                sol_max=sol_max,
                min_images=min_images,
                map_only=map_only,
            )
        }
    except IndexNotBuiltError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e


@app.get("/api/map")
def api_map():
    """NASA MMGIS waypoints + traverse (real Jezero localization)."""
    try:
        # stops index optional but preferred for join counts
        try:
            load_manifest()
        except IndexNotBuiltError:
            pass
        return map_bundle()
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)) from e


@app.get("/api/map/basemap/layers")
def api_basemap_layers():
    """Available FU Berlin Jezero WMS layers (proxied)."""
    return {
        "layers": list_basemap_layers(),
        "viewer": "https://maps.planet.fu-berlin.de/jezero/",
        "note": (
            "Imagery via FU Berlin Planetary Sciences MapServer. "
            "Use /api/map/basemap to fetch a JPEG for the MMGIS waypoint footprint."
        ),
    }


@app.get("/api/map/basemap")
def api_basemap(
    layer: str = Query("ctx", description="ctx | hirise | hrsc | base"),
    width: int = Query(1536, ge=256, le=2048),
    height: int = Query(1536, ge=256, le=2048),
    pad_deg: float = Query(0.02, ge=0.0, le=0.2),
    force: bool = False,
):
    """
    Proxied FU Berlin Jezero WMS GetMap over the MMGIS waypoint lon/lat hull.

    Returns JPEG image bytes. Metadata is in response headers:
    X-Basemap-Layer, X-Basemap-BBox, X-Basemap-Attribution.
    """
    try:
        meta = fetch_fub_basemap(
            layer_key=layer,
            width=width,
            height=height,
            pad_deg=pad_deg,
            force=force,
        )
    except FileNotFoundError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"basemap fetch failed: {e}") from e

    path: Path = meta["path"]  # type: ignore[assignment]
    bbox = meta["bbox"]
    headers = {
        "X-Basemap-Layer": str(meta["layer"]),
        "X-Basemap-Layer-Key": str(meta["layer_key"]),
        "X-Basemap-BBox": (
            f"{bbox['lon_min']},{bbox['lat_min']},{bbox['lon_max']},{bbox['lat_max']}"
        ),
        "X-Basemap-Attribution": str(meta["attribution"])[:500],
        "X-Basemap-Cached": "1" if meta["cached"] else "0",
        "Cache-Control": "public, max-age=86400",
    }
    return FileResponse(
        path,
        media_type=meta["media_type"],
        filename=f"basemap_{meta['layer_key']}.jpg",
        headers=headers,
    )


@app.get("/api/map/waypoints")
def api_waypoints(
    sol_min: Optional[int] = None,
    sol_max: Optional[int] = None,
):
    wps = list_waypoints(sol_min=sol_min, sol_max=sol_max)
    if not wps:
        raise HTTPException(
            status_code=503,
            detail="No waypoints. Run: python -m playground.pipeline.fetch_mmgis",
        )
    return {"waypoints": wps, "n": len(wps)}


@app.get("/api/map/traverse")
def api_traverse(
    sol_min: Optional[int] = None,
    sol_max: Optional[int] = None,
):
    segs = list_traverse_segments(sol_min=sol_min, sol_max=sol_max)
    if not segs:
        raise HTTPException(
            status_code=503,
            detail="No traverse. Run: python -m playground.pipeline.fetch_mmgis",
        )
    return {"segments": segs, "n": len(segs)}


@app.get("/api/sites/{site}/world")
def api_site_world(
    site: int,
    max_drives: int = Query(24, ge=1, le=80),
    max_per_drive: int = Query(120, ge=10, le=500),
    max_total: int = Query(1500, ge=50, le=5000),
    posed_only: bool = True,
    sol_min: Optional[int] = None,
    sol_max: Optional[int] = None,
    instrument: Optional[list[str]] = Query(None),
):
    """Multi-drive photo world for one site (body poses + MMGIS anchors)."""
    try:
        return site_world(
            site,
            posed_only=posed_only,
            max_drives=max_drives,
            max_per_drive=max_per_drive,
            max_total=max_total,
            instruments=instrument,
            sol_min=sol_min,
            sol_max=sol_max,
        )
    except IndexNotBuiltError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e


@app.get("/api/stops/{site}/{drive}/cameras")
def api_cameras(
    site: int,
    drive: int,
    posed_only: bool = True,
    instrument: Optional[list[str]] = Query(None),
    sol_min: Optional[int] = None,
    sol_max: Optional[int] = None,
    limit: int = Query(3000, ge=1, le=20000),
    offset: int = Query(0, ge=0),
):
    try:
        return cameras_for_stop(
            site,
            drive,
            posed_only=posed_only,
            instruments=instrument,
            sol_min=sol_min,
            sol_max=sol_max,
            limit=limit,
            offset=offset,
        )
    except IndexNotBuiltError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e


@app.get("/api/stops/{site}/{drive}/stereo-pairs")
def api_stereo_pairs(
    site: int,
    drive: int,
    max_pairs: int = Query(100, ge=1, le=500),
    max_dt_sclk: float = Query(60.0, ge=0.1, le=600.0),
    min_score: float = Query(25.0, ge=0.0),
    sol_min: Optional[int] = None,
    sol_max: Optional[int] = None,
    family: Optional[list[str]] = Query(
        None, description="Filter families: NAVCAM, MCZ, HAZCAM"
    ),
):
    try:
        return stereo_pairs_for_stop(
            site,
            drive,
            max_pairs=max_pairs,
            max_dt_sclk=max_dt_sclk,
            min_score=min_score,
            sol_min=sol_min,
            sol_max=sol_max,
            family=family,
        )
    except IndexNotBuiltError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e


@app.get("/api/stops/{site}/{drive}/stereo-depth")
def api_stereo_depth(
    site: int,
    drive: int,
    pair_id: str = Query(..., description="Stereo pair id from stereo-pairs"),
    size: str = Query("small", pattern="^(small|medium)$"),
    max_side: int = Query(640, ge=160, le=1280),
    prefer_gpu: bool = Query(True, description="Use CUDA block-matching when available"),
    point_cloud: bool = Query(False, description="Include back-projected points"),
    max_points: int = Query(15000, ge=1000, le=80000),
):
    """Disparity preview (GPU PyTorch SAD if CUDA, else OpenCV SGBM)."""
    if not has_opencv() and not has_torch_cuda():
        raise HTTPException(
            status_code=501,
            detail="Need opencv-python-headless and/or torch+CUDA",
        )
    try:
        bundle = stereo_pairs_for_stop(site, drive, max_pairs=200)
    except IndexNotBuiltError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e

    pair = next((p for p in bundle.get("pairs") or [] if p.get("id") == pair_id), None)
    if not pair:
        raise HTTPException(status_code=404, detail=f"pair not found: {pair_id}")

    left_id = pair["left_imageid"]
    right_id = pair["right_imageid"]
    left_row = get_image(left_id)
    right_row = get_image(right_id)
    if not left_row or not right_row:
        raise HTTPException(status_code=404, detail="pair image metadata missing")

    url_key = "url_medium" if size == "medium" else "url_small"
    left_url = left_row.get(url_key) or left_row.get("url_small")
    right_url = right_row.get(url_key) or right_row.get("url_small")
    if not left_url or not right_url:
        raise HTTPException(status_code=404, detail="missing image URLs")

    # Allow higher res on GPU (1050 Ti handles ~960 fine)
    if prefer_gpu and has_torch_cuda():
        max_side = max(max_side, 640)

    try:
        left_path, _ = get_cached_or_fetch(left_id, size, left_url)
        right_path, _ = get_cached_or_fetch(right_id, size, right_url)
        left_bytes = left_path.read_bytes()
        right_bytes = right_path.read_bytes()
        left_gray = decode_image_bytes(left_bytes, max_side=max_side)
        right_gray = decode_image_bytes(right_bytes, max_side=max_side)
        left_rgb = None
        if point_cloud:
            try:
                left_rgb = decode_color_bytes(left_bytes, max_side=max_side)
                # Match gray crop if shapes differ after resize
                if left_rgb.shape[:2] != left_gray.shape[:2]:
                    h, w = left_gray.shape[:2]
                    left_rgb = left_rgb[:h, :w]
            except Exception:
                left_rgb = None
        result = compute_disparity(
            left_gray, right_gray, prefer_gpu=prefer_gpu
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"depth failed: {e}") from e

    b64 = base64.b64encode(result["preview_png"]).decode("ascii")
    baseline = pair.get("baseline_m")
    approx_z = None
    f_px = None
    try:
        import math

        hfov = float(left_row.get("hfov_deg") or 45.0)
        w = float(result["shape"][1])
        f_px = (w / 2.0) / math.tan(math.radians(hfov) / 2.0)
        med = (result.get("stats") or {}).get("disp_median")
        if baseline and med:
            approx_z = approximate_depth_m(float(med), float(baseline), f_px)
    except Exception:
        approx_z = None

    cloud = None
    if point_cloud and result.get("disparity") is not None and baseline and f_px:
        try:
            import numpy as np

            cam_cloud = disparity_to_point_cloud(
                result["disparity"],
                baseline_m=float(baseline),
                focal_px=float(f_px),
                max_points=max_points,
                color_rgb=left_rgb,
            )
            # Prefer body-frame cloud when left camera pose is available
            ox = left_row.get("pos_x")
            oy = left_row.get("pos_y")
            oz = left_row.get("pos_z")
            lx = left_row.get("look_x")
            ly = left_row.get("look_y")
            lz = left_row.get("look_z")
            ux = left_row.get("up_x")
            uy = left_row.get("up_y")
            uz = left_row.get("up_z")
            if (
                ox is not None
                and oy is not None
                and oz is not None
                and lx is not None
                and ly is not None
                and lz is not None
            ):
                origin = np.array([float(ox), float(oy), float(oz)])
                look = np.array([float(lx), float(ly), float(lz)])
                if ux is not None and uy is not None and uz is not None:
                    up = np.array([float(ux), float(uy), float(uz)])
                else:
                    up = np.array([0.0, 0.0, -1.0])  # body +Z down → up −Z
                rx, ry, rz = (
                    left_row.get("right_x"),
                    left_row.get("right_y"),
                    left_row.get("right_z"),
                )
                right = (
                    np.array([float(rx), float(ry), float(rz)])
                    if rx is not None and ry is not None and rz is not None
                    else None
                )
                cloud = camera_cloud_to_body(
                    cam_cloud, origin=origin, look=look, up=up, right=right
                )
                cloud["left_imageid"] = left_id
            else:
                cloud = cam_cloud
                cloud["note"] = "left pose incomplete; camera frame only"
        except Exception:
            cloud = None

    return {
        "pair_id": pair_id,
        "left_imageid": left_id,
        "right_imageid": right_id,
        "baseline_m": baseline,
        "shape": result["shape"],
        "stats": result["stats"],
        "preview_data_url": f"data:image/png;base64,{b64}",
        "approx_depth_m_median": approx_z,
        "backend": result.get("backend"),
        "device": result.get("device"),
        "elapsed_ms": result.get("elapsed_ms"),
        "point_cloud": cloud,
        "note": (
            f"{result.get('backend')} on unrectified thumbs — qualitative only. "
            "GPU uses CUDA block-matching when available. "
            "point_cloud is rover body frame when left pose is present."
        ),
    }


@app.get("/api/stops/{site}/{drive}/coverage")
def api_stop_coverage(
    site: int,
    drive: int,
    az_bins: int = Query(72, ge=12, le=360),
    el_bins: int = Query(36, ge=8, le=180),
    fill_fov: bool = Query(True, description="Soft-fill FOV footprint on sphere"),
    sol_min: Optional[int] = None,
    sol_max: Optional[int] = None,
    instrument: Optional[list[str]] = Query(None),
):
    """Azimuth × elevation pose coverage heatmap for a stop (metadata only)."""
    try:
        return stop_coverage(
            site,
            drive,
            az_bins=az_bins,
            el_bins=el_bins,
            instruments=instrument,
            sol_min=sol_min,
            sol_max=sol_max,
            fill_fov=fill_fov,
        )
    except IndexNotBuiltError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e


@app.get("/api/stops/{site}/{drive}/pano")
def api_stop_pano(
    site: int,
    drive: int,
    max_frames: int = Query(40, ge=4, le=80),
    out_width: int = Query(4096, ge=1024, le=8192),
    size: str = Query(
        "small",
        pattern="^(small|medium|large|full)$",
        description="NASA product tier: small/medium/large/full",
    ),
    max_side: Optional[int] = Query(
        None,
        ge=256,
        le=4096,
        description="Cap source image edge (defaults by size tier)",
    ),
    projection: str = Query(
        "cylinder",
        pattern="^(cylinder|equirect)$",
        description="cylinder = adaptive crop; equirect = full 360×180 export",
    ),
    instrument: Optional[list[str]] = Query(
        None, description="e.g. NAVCAM_LEFT — default prefers NAVCAM"
    ),
    sol_min: Optional[int] = None,
    sol_max: Optional[int] = None,
    meta_only: bool = Query(False, description="Return JSON only (no JPEG body)"),
):
    """Pose-driven panorama for a stop (body-frame look/up/FOV)."""
    if not has_opencv():
        raise HTTPException(status_code=501, detail="OpenCV required for pano encode")
    try:
        result = build_stop_pano(
            site,
            drive,
            instruments=instrument,
            sol_min=sol_min,
            sol_max=sol_max,
            max_frames=max_frames,
            out_width=out_width,
            thumb_size=size,
            max_side=max_side,
            projection=projection,
        )
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"pano failed: {e}") from e

    meta = {
        "site": result["site"],
        "drive": result["drive"],
        "n_frames": result["n_frames"],
        "frames": result["frames"],
        "width": result["width"],
        "height": result["height"],
        "az_min_deg": result["az_min_deg"],
        "az_span_deg": result["az_span_deg"],
        "el_min_deg": result["el_min_deg"],
        "el_span_deg": result["el_span_deg"],
        "method": result["method"],
        "projection": result.get("projection", projection),
        "frame": result["frame"],
        "elapsed_ms": result["elapsed_ms"],
        "source_size": result.get("source_size"),
        "source_max_side": result.get("source_max_side"),
        "note": result["note"],
        "url": (
            f"/api/stops/{site}/{drive}/pano?max_frames={max_frames}"
            f"&out_width={out_width}&size={size}&projection={projection}"
            + (f"&max_side={max_side}" if max_side else "")
        ),
    }
    if meta_only:
        return meta

    headers = {
        "X-Pano-Frames": str(result["n_frames"]),
        "X-Pano-Method": str(result["method"]),
        "X-Pano-Projection": str(result.get("projection", projection)),
        "X-Pano-Az-Span-Deg": f"{result['az_span_deg']:.1f}",
        "X-Pano-Elapsed-Ms": f"{result['elapsed_ms']:.0f}",
        "Cache-Control": "public, max-age=3600",
        "Content-Disposition": (
            f'inline; filename="pano_{site}_{drive}_{projection}.jpg"'
        ),
    }
    return FileResponse(
        result["path"],
        media_type="image/jpeg",
        filename=f"pano_{site}_{drive}_{projection}.jpg",
        headers=headers,
    )


@app.get("/api/images/{imageid}")
def api_image(imageid: str):
    try:
        row = get_image(imageid)
    except IndexNotBuiltError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
    if not row:
        raise HTTPException(status_code=404, detail="image not found")
    return row


@app.get("/api/images/{imageid}/thumb")
def api_thumb(
    imageid: str,
    size: str = Query("small", pattern="^(small|medium|large|full)$"),
):
    try:
        row = get_image(imageid)
    except IndexNotBuiltError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
    if not row:
        raise HTTPException(status_code=404, detail="image not found")

    url_key = {
        "small": "url_small",
        "medium": "url_medium",
        "large": "url_large",
        "full": "url_full",
    }[size]
    url = row.get(url_key) or row.get("url_small") or row.get("url_medium")
    if not url:
        raise HTTPException(status_code=404, detail="no image URL on record")

    try:
        path, media = get_cached_or_fetch(imageid, size, url)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"fetch failed: {e}") from e

    return FileResponse(path, media_type=media, filename=f"{imageid}_{size}{path.suffix}")
