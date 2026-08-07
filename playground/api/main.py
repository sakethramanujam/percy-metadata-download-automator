"""FastAPI entrypoint for the Percy playground."""

from __future__ import annotations

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
    load_manifest,
    reload_indexes,
    stats,
)

app = FastAPI(
    title="Percy Metadata Playground API",
    version="0.1.0",
    description="Query derived Mars 2020 image poses for the local 3D playground.",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[config.CORS_ORIGIN, "http://127.0.0.1:5173", "http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health():
    try:
        m = load_manifest()
        return {"ok": True, "index": True, "n_images": m.get("n_images"), "built_at": m.get("built_at")}
    except IndexNotBuiltError:
        return {"ok": True, "index": False, "hint": "Run python -m playground.pipeline.build_index"}


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
):
    try:
        return {"stops": list_stops(sol_min=sol_min, sol_max=sol_max, min_images=min_images)}
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
