"""Load and query derived Parquet indexes."""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any, Optional

import pandas as pd

from playground.api import config


class IndexNotBuiltError(FileNotFoundError):
    pass


def _require(path: Path) -> Path:
    if not path.is_file():
        raise IndexNotBuiltError(
            f"Missing {path}. Run: python -m playground.pipeline.build_index"
        )
    return path


@lru_cache(maxsize=1)
def load_manifest() -> dict[str, Any]:
    path = _require(config.DERIVED_DIR / "manifest.json")
    with open(path, encoding="utf-8") as f:
        return json.load(f)


@lru_cache(maxsize=1)
def load_stops() -> pd.DataFrame:
    path = _require(config.DERIVED_DIR / "stops.parquet")
    return pd.read_parquet(path)


@lru_cache(maxsize=1)
def load_images() -> pd.DataFrame:
    path = _require(config.DERIVED_DIR / "images.parquet")
    return pd.read_parquet(path)


def reload_indexes() -> None:
    load_manifest.cache_clear()
    load_stops.cache_clear()
    load_images.cache_clear()


def list_stops(
    sol_min: Optional[int] = None,
    sol_max: Optional[int] = None,
    min_images: int = 0,
) -> list[dict[str, Any]]:
    df = load_stops().copy()
    if sol_min is not None:
        df = df[df["sol_max"].fillna(-1) >= sol_min]
    if sol_max is not None:
        df = df[df["sol_min"].fillna(10**9) <= sol_max]
    if min_images:
        df = df[df["n_images"] >= min_images]
    records = []
    for row in df.to_dict(orient="records"):
        # parse instruments_json for API consumers
        try:
            row["instruments"] = json.loads(row.pop("instruments_json", "{}") or "{}")
        except json.JSONDecodeError:
            row["instruments"] = {}
            row.pop("instruments_json", None)
        # JSON-safe NA
        for k, v in list(row.items()):
            if pd.isna(v):
                row[k] = None
        records.append(row)
    return records


def cameras_for_stop(
    site: int,
    drive: int,
    *,
    posed_only: bool = True,
    instruments: Optional[list[str]] = None,
    sol_min: Optional[int] = None,
    sol_max: Optional[int] = None,
    limit: int = 5000,
    offset: int = 0,
) -> dict[str, Any]:
    img = load_images()
    mask = (img["site"] == site) & (img["drive"] == drive)
    sub = img.loc[mask].copy()
    if posed_only:
        sub = sub[sub["has_pose"]]
    if instruments:
        inst = {i.upper() for i in instruments}
        sub = sub[sub["instrument"].str.upper().isin(inst)]
    if sol_min is not None:
        sub = sub[sub["sol"].fillna(-1) >= sol_min]
    if sol_max is not None:
        sub = sub[sub["sol"].fillna(10**9) <= sol_max]

    total = len(sub)
    # Prefer diverse sample if over limit: take evenly spaced rows
    if total > limit + offset:
        sub = sub.iloc[offset : offset + limit]
    else:
        sub = sub.iloc[offset:]

    cols = [
        "imageid",
        "sol",
        "site",
        "drive",
        "stop_id",
        "instrument",
        "filter_name",
        "date_taken_utc",
        "mast_az",
        "mast_el",
        "pos_x",
        "pos_y",
        "pos_z",
        "look_x",
        "look_y",
        "look_z",
        "yaw_rad",
        "hfov_deg",
        "vfov_deg",
        "has_pose",
        "model_type",
        "model_ok",
        "url_small",
        "url_medium",
        "caption",
        "title",
    ]
    cols = [c for c in cols if c in sub.columns]
    cameras = []
    for row in sub[cols].to_dict(orient="records"):
        for k, v in list(row.items()):
            if pd.isna(v):
                row[k] = None
        cameras.append(row)

    return {
        "site": site,
        "drive": drive,
        "total": total,
        "offset": offset,
        "limit": limit,
        "returned": len(cameras),
        "cameras": cameras,
    }


def get_image(imageid: str) -> Optional[dict[str, Any]]:
    img = load_images()
    hit = img[img["imageid"] == imageid]
    if hit.empty:
        return None
    row = hit.iloc[0].to_dict()
    for k, v in list(row.items()):
        if pd.isna(v):
            row[k] = None
    return row


def stats() -> dict[str, Any]:
    manifest = load_manifest()
    img = load_images()
    stops = load_stops()
    inst = img["instrument"].value_counts().head(30).to_dict()
    return {
        "manifest": manifest,
        "n_images": len(img),
        "n_posed": int(img["has_pose"].sum()),
        "n_stops": len(stops),
        "sol_min": _safe_int(img["sol"].min()),
        "sol_max": _safe_int(img["sol"].max()),
        "instruments": {str(k): int(v) for k, v in inst.items()},
        "top_stops": list_stops(min_images=1)[:15],
    }


def _safe_int(v: Any) -> Optional[int]:
    try:
        if pd.isna(v):
            return None
        return int(v)
    except Exception:
        return None
