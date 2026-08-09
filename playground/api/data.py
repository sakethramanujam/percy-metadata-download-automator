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


@lru_cache(maxsize=1)
def load_waypoints() -> pd.DataFrame:
    path = config.DERIVED_DIR / "waypoints.parquet"
    if not path.is_file():
        return pd.DataFrame()
    return pd.read_parquet(path)


@lru_cache(maxsize=1)
def load_traverse() -> pd.DataFrame:
    path = config.DERIVED_DIR / "traverse.parquet"
    if not path.is_file():
        return pd.DataFrame()
    return pd.read_parquet(path)


@lru_cache(maxsize=1)
def load_mmgis_manifest() -> dict[str, Any]:
    path = config.DERIVED_DIR / "mmgis_manifest.json"
    if not path.is_file():
        return {}
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def reload_indexes() -> None:
    load_manifest.cache_clear()
    load_stops.cache_clear()
    load_images.cache_clear()
    load_waypoints.cache_clear()
    load_traverse.cache_clear()
    load_mmgis_manifest.cache_clear()


def _records_from_df(df: pd.DataFrame) -> list[dict[str, Any]]:
    records = []
    for row in df.to_dict(orient="records"):
        if "instruments_json" in row:
            try:
                row["instruments"] = json.loads(row.pop("instruments_json") or "{}")
            except (json.JSONDecodeError, TypeError):
                row["instruments"] = {}
                row.pop("instruments_json", None)
        if "coordinates_json" in row:
            try:
                row["coordinates"] = json.loads(row.pop("coordinates_json") or "[]")
            except (json.JSONDecodeError, TypeError):
                row["coordinates"] = []
                row.pop("coordinates_json", None)
        for k, v in list(row.items()):
            if pd.isna(v) if not isinstance(v, (list, dict)) else False:
                row[k] = None
            elif hasattr(v, "item"):  # numpy scalars
                try:
                    row[k] = v.item()
                except Exception:
                    pass
        records.append(row)
    return records


def list_stops(
    sol_min: Optional[int] = None,
    sol_max: Optional[int] = None,
    min_images: int = 0,
    map_only: bool = False,
) -> list[dict[str, Any]]:
    df = load_stops().copy()
    if sol_min is not None:
        df = df[df["sol_max"].fillna(-1) >= sol_min]
    if sol_max is not None:
        df = df[df["sol_min"].fillna(10**9) <= sol_max]
    if min_images:
        df = df[df["n_images"] >= min_images]
    if map_only and "lon" in df.columns:
        df = df[df["lon"].notna()]
    return _records_from_df(df)


def list_waypoints(
    sol_min: Optional[int] = None,
    sol_max: Optional[int] = None,
) -> list[dict[str, Any]]:
    df = load_waypoints()
    if df.empty:
        return []
    df = df.copy()
    if sol_min is not None:
        df = df[df["sol"].fillna(-1) >= sol_min]
    if sol_max is not None:
        df = df[df["sol"].fillna(10**9) <= sol_max]
    return _records_from_df(df)


def list_traverse_segments(
    sol_min: Optional[int] = None,
    sol_max: Optional[int] = None,
) -> list[dict[str, Any]]:
    df = load_traverse()
    if df.empty:
        return []
    df = df.copy()
    if sol_min is not None:
        df = df[df["sol"].fillna(-1) >= sol_min]
    if sol_max is not None:
        df = df[df["sol"].fillna(10**9) <= sol_max]
    return _records_from_df(df)


def map_bundle() -> dict[str, Any]:
    """Waypoints + traverse + current + join stats for the mission path UI."""
    mm = load_mmgis_manifest()
    waypoints = list_waypoints()
    traverse = list_traverse_segments()
    stops = list_stops(min_images=0)
    n_mapped = sum(1 for s in stops if s.get("lon") is not None)
    return {
        "available": bool(waypoints),
        "manifest": mm,
        "n_waypoints": len(waypoints),
        "n_traverse_segments": len(traverse),
        "n_stops": len(stops),
        "n_stops_with_map": n_mapped,
        "waypoints": waypoints,
        "traverse": traverse,
        "current": mm.get("current"),
    }


_CAMERA_COLS = [
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
    "up_x",
    "up_y",
    "up_z",
    "right_x",
    "right_y",
    "right_z",
    "yaw_rad",
    "pitch_rad",
    "roll_rad",
    "quat_w",
    "quat_x",
    "quat_y",
    "quat_z",
    "hfov_deg",
    "vfov_deg",
    "basis_source",
    "has_pose",
    "model_type",
    "model_ok",
    "url_small",
    "url_medium",
    "caption",
    "title",
]


def _camera_records(sub: pd.DataFrame) -> list[dict[str, Any]]:
    cols = [c for c in _CAMERA_COLS if c in sub.columns]
    cameras = []
    for row in sub[cols].to_dict(orient="records"):
        for k, v in list(row.items()):
            if pd.isna(v):
                row[k] = None
        cameras.append(row)
    return cameras


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

    cameras = _camera_records(sub)

    return {
        "site": site,
        "drive": drive,
        "total": total,
        "offset": offset,
        "limit": limit,
        "returned": len(cameras),
        "cameras": cameras,
    }


def site_world(
    site: int,
    *,
    posed_only: bool = True,
    max_drives: int = 24,
    max_per_drive: int = 120,
    max_total: int = 1500,
    instruments: Optional[list[str]] = None,
    sol_min: Optional[int] = None,
    sol_max: Optional[int] = None,
) -> dict[str, Any]:
    """Multi-drive cameras for one site, with MMGIS anchors for site-frame placement.

    Returns body-frame poses plus per-camera drive easting/northing/yaw so the
    client can place all drives into a shared EN site frame.
    """
    stops = load_stops()
    if stops.empty:
        return {
            "site": site,
            "n_drives": 0,
            "drives": [],
            "cameras": [],
            "origin_easting": None,
            "origin_northing": None,
            "frame": "body+map_anchor",
        }
    site_stops = stops[stops["site"] == site].copy()
    if site_stops.empty:
        return {
            "site": site,
            "n_drives": 0,
            "drives": [],
            "cameras": [],
            "origin_easting": None,
            "origin_northing": None,
            "frame": "body+map_anchor",
        }

    # Prefer mapped drives, then most posed images
    if "easting" in site_stops.columns:
        site_stops["_mapped"] = site_stops["easting"].notna().astype(int)
    else:
        site_stops["_mapped"] = 0
    if "n_posed" in site_stops.columns:
        site_stops = site_stops.sort_values(
            ["_mapped", "n_posed"], ascending=[False, False]
        )
    else:
        site_stops = site_stops.sort_values("_mapped", ascending=False)
    site_stops = site_stops.head(max_drives)

    drives_meta: list[dict[str, Any]] = []
    for row in site_stops.to_dict(orient="records"):
        rec = {
            "site": int(site),
            "drive": int(row["drive"]) if row.get("drive") is not None else None,
            "stop_id": row.get("stop_id"),
            "sol_min": row.get("sol_min"),
            "sol_max": row.get("sol_max"),
            "n_posed": int(row["n_posed"]) if row.get("n_posed") is not None and not pd.isna(row.get("n_posed")) else 0,
            "n_images": int(row["n_images"]) if row.get("n_images") is not None and not pd.isna(row.get("n_images")) else 0,
            "easting": float(row["easting"]) if row.get("easting") is not None and not pd.isna(row.get("easting")) else None,
            "northing": float(row["northing"]) if row.get("northing") is not None and not pd.isna(row.get("northing")) else None,
            "yaw_deg": float(row["yaw_deg"]) if row.get("yaw_deg") is not None and not pd.isna(row.get("yaw_deg")) else None,
            "lon": float(row["lon"]) if row.get("lon") is not None and not pd.isna(row.get("lon")) else None,
            "lat": float(row["lat"]) if row.get("lat") is not None and not pd.isna(row.get("lat")) else None,
            "dist_total_m": float(row["dist_total_m"]) if row.get("dist_total_m") is not None and not pd.isna(row.get("dist_total_m")) else None,
        }
        drives_meta.append(rec)

    mapped = [d for d in drives_meta if d.get("easting") is not None and d.get("northing") is not None]
    if mapped:
        origin_e = sum(d["easting"] for d in mapped) / len(mapped)
        origin_n = sum(d["northing"] for d in mapped) / len(mapped)
    else:
        origin_e = None
        origin_n = None

    img = load_images()
    mask = img["site"] == site
    drives_keep = {d["drive"] for d in drives_meta if d.get("drive") is not None}
    if drives_keep:
        mask = mask & img["drive"].isin(drives_keep)
    sub = img.loc[mask].copy()
    if posed_only and "has_pose" in sub.columns:
        sub = sub[sub["has_pose"]]
    if instruments:
        inst = {i.upper() for i in instruments}
        sub = sub[sub["instrument"].str.upper().isin(inst)]
    if sol_min is not None:
        sub = sub[sub["sol"].fillna(-1) >= sol_min]
    if sol_max is not None:
        sub = sub[sub["sol"].fillna(10**9) <= sol_max]

    # Per-drive cap then global cap
    parts = []
    for d in sorted(drives_keep):
        part = sub[sub["drive"] == d]
        if len(part) > max_per_drive:
            # even stride
            idx = [
                int(round(i * (len(part) - 1) / (max_per_drive - 1)))
                for i in range(max_per_drive)
            ]
            part = part.iloc[idx]
        parts.append(part)
    if parts:
        sub = pd.concat(parts, ignore_index=False)
    else:
        sub = sub.iloc[0:0]

    total_before = len(sub)
    if len(sub) > max_total:
        idx = [
            int(round(i * (len(sub) - 1) / (max_total - 1)))
            for i in range(max_total)
        ]
        sub = sub.iloc[idx]

    cameras = _camera_records(sub)
    # Attach map anchors so the client can place each drive in site EN
    by_drive = {d["drive"]: d for d in drives_meta if d.get("drive") is not None}
    for cam in cameras:
        d = by_drive.get(cam.get("drive"))
        if not d:
            continue
        cam["drive_easting"] = d.get("easting")
        cam["drive_northing"] = d.get("northing")
        cam["drive_yaw_deg"] = d.get("yaw_deg")
        cam["drive_stop_id"] = d.get("stop_id")

    n_mapped_drives = len(mapped)
    return {
        "site": site,
        "n_drives": len(drives_meta),
        "n_drives_mapped": n_mapped_drives,
        "drives": drives_meta,
        "cameras": cameras,
        "total_cameras": total_before,
        "returned": len(cameras),
        "origin_easting": origin_e,
        "origin_northing": origin_n,
        "frame": "body+map_anchor",
        "note": (
            "Body-frame poses with MMGIS drive anchors. Client places drives "
            "into EN site frame (X east, Y up, Z −north)."
            if n_mapped_drives
            else "No MMGIS join for this site — body poses only (drives stacked at origin)."
        ),
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


def stereo_pairs_for_stop(
    site: int,
    drive: int,
    *,
    max_pairs: int = 100,
    max_dt_sclk: float = 60.0,
    min_score: float = 25.0,
    sol_min: Optional[int] = None,
    sol_max: Optional[int] = None,
    family: Optional[list[str]] = None,
) -> dict[str, Any]:
    """Return ranked stereo L/R pairs for a site/drive stop."""
    from playground.api.stereo import find_stereo_pairs

    img = load_images()
    mask = (img["site"] == site) & (img["drive"] == drive)
    sub = img.loc[mask].copy()
    if sol_min is not None:
        sub = sub[sub["sol"].fillna(-1) >= sol_min]
    if sol_max is not None:
        sub = sub[sub["sol"].fillna(10**9) <= sol_max]

    pairs = find_stereo_pairs(
        sub,
        max_dt_sclk=max_dt_sclk,
        max_pairs=max_pairs,
        min_score=min_score,
        families=family,
    )
    return {
        "site": site,
        "drive": drive,
        "n_images": int(len(sub)),
        "n_pairs": len(pairs),
        "max_dt_sclk": max_dt_sclk,
        "min_score": min_score,
        "pairs": pairs,
    }


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
