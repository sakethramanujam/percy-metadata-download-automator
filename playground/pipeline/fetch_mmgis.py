#!/usr/bin/env python3
"""Download NASA MMGIS Mars 2020 localization layers and write parquet.

Public GeoJSON used by the Perseverance location map:
  https://mars.nasa.gov/mmgis-maps/M20/Layers/json/M20_waypoints.json
  https://mars.nasa.gov/mmgis-maps/M20/Layers/json/M20_traverse.json
  https://mars.nasa.gov/mmgis-maps/M20/Layers/json/M20_waypoints_current.json
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

import pandas as pd
import requests

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUT = REPO_ROOT / "data" / "derived"

WAYPOINTS_URL = (
    "https://mars.nasa.gov/mmgis-maps/M20/Layers/json/M20_waypoints.json"
)
TRAVERSE_URL = (
    "https://mars.nasa.gov/mmgis-maps/M20/Layers/json/M20_traverse.json"
)
CURRENT_URL = (
    "https://mars.nasa.gov/mmgis-maps/M20/Layers/json/M20_waypoints_current.json"
)

USER_AGENT = "percy-metadata-playground/0.2 (+local; educational)"


def _get_json(url: str, timeout: float = 120.0) -> dict[str, Any]:
    r = requests.get(
        url,
        headers={"User-Agent": USER_AGENT, "Accept": "application/json"},
        timeout=timeout,
    )
    r.raise_for_status()
    return r.json()


def waypoints_to_frame(geo: dict[str, Any]) -> pd.DataFrame:
    rows: list[dict[str, Any]] = []
    for feat in geo.get("features") or []:
        props = dict(feat.get("properties") or {})
        geom = feat.get("geometry") or {}
        coords = geom.get("coordinates") or [None, None, None]
        lon = coords[0] if len(coords) > 0 else None
        lat = coords[1] if len(coords) > 1 else None
        elev = coords[2] if len(coords) > 2 else props.get("elev_geoid")

        images = props.get("images") or []
        pano = None
        for im in images:
            if im.get("isPanoramic"):
                pano = im
                break
        if pano is None and images:
            pano = images[0]

        site = props.get("site")
        drive = props.get("drive")
        rmc = props.get("RMC") or (
            f"{site}_{drive}" if site is not None and drive is not None else None
        )

        rows.append(
            {
                "rmc": str(rmc) if rmc is not None else None,
                "site": int(site) if site is not None else None,
                "drive": int(drive) if drive is not None else None,
                "sol": int(props["sol"]) if props.get("sol") is not None else None,
                "lon": float(lon) if lon is not None else None,
                "lat": float(lat) if lat is not None else None,
                "elev_geoid": _f(props.get("elev_geoid", elev)),
                "easting": _f(props.get("easting")),
                "northing": _f(props.get("northing")),
                "yaw_deg": _f(props.get("yaw")),
                "yaw_rad": _f(props.get("yaw_rad")),
                "pitch_deg": _f(props.get("pitch")),
                "roll_deg": _f(props.get("roll")),
                "tilt_deg": _f(props.get("tilt")),
                "dist_m": _f(props.get("dist_m")),
                "dist_total_m": _f(props.get("dist_total_m")),
                "dist_km": _f(props.get("dist_km")),
                "final": str(props.get("final") or ""),
                "note": str(props.get("Note") or ""),
                "pano_name": (pano or {}).get("name"),
                "pano_url": (pano or {}).get("url"),
                "pano_is_panoramic": bool((pano or {}).get("isPanoramic")),
                "pano_azmin": _f((pano or {}).get("azmin")),
                "pano_azmax": _f((pano or {}).get("azmax")),
                "pano_elmin": _f((pano or {}).get("elmin")),
                "pano_elmax": _f((pano or {}).get("elmax")),
                "stop_id": f"{site}_{drive}"
                if site is not None and drive is not None
                else None,
            }
        )
    df = pd.DataFrame(rows)
    if not df.empty:
        # Prefer final localization when duplicate RMC
        df = df.sort_values(["site", "drive", "sol"]).drop_duplicates(
            subset=["site", "drive"], keep="last"
        )
        df = df.reset_index(drop=True)
    return df


def traverse_to_frame(geo: dict[str, Any]) -> pd.DataFrame:
    rows: list[dict[str, Any]] = []
    for i, feat in enumerate(geo.get("features") or []):
        props = dict(feat.get("properties") or {})
        geom = feat.get("geometry") or {}
        coords = geom.get("coordinates") or []
        # store full line as JSON for the API
        rows.append(
            {
                "segment_id": i,
                "sol": int(props["sol"]) if props.get("sol") is not None else None,
                "from_rmc": str(props.get("fromRMC") or ""),
                "to_rmc": str(props.get("toRMC") or ""),
                "length_m": _f(props.get("length")),
                "sclk_start": _f(props.get("SCLK_START")),
                "sclk_end": _f(props.get("SCLK_END")),
                "n_points": len(coords),
                "coordinates_json": json.dumps(coords),
            }
        )
    return pd.DataFrame(rows)


def join_stops(
    stops_path: Path, waypoints: pd.DataFrame, out_path: Path
) -> dict[str, Any]:
    """Left-join local image stops with map waypoints on site/drive."""
    if not stops_path.is_file():
        return {"joined": False, "reason": f"missing {stops_path}"}
    stops = pd.read_parquet(stops_path)
    if waypoints.empty:
        return {"joined": False, "reason": "empty waypoints"}

    wp = waypoints.copy()
    # columns to attach
    attach = [
        "lon",
        "lat",
        "elev_geoid",
        "easting",
        "northing",
        "yaw_deg",
        "yaw_rad",
        "pitch_deg",
        "roll_deg",
        "dist_total_m",
        "dist_km",
        "rmc",
        "pano_url",
        "pano_is_panoramic",
        "pano_azmin",
        "pano_azmax",
        "pano_elmin",
        "pano_elmax",
        "note",
    ]
    attach = [c for c in attach if c in wp.columns]
    wp_small = wp[["site", "drive"] + attach].copy()
    # drop existing map cols if re-running
    drop_cols = [c for c in attach if c in stops.columns]
    if drop_cols:
        stops = stops.drop(columns=drop_cols)
    merged = stops.merge(wp_small, on=["site", "drive"], how="left")
    merged.to_parquet(out_path, index=False)
    n_hit = int(merged["lon"].notna().sum()) if "lon" in merged.columns else 0
    return {
        "joined": True,
        "n_stops": len(merged),
        "n_with_map": n_hit,
        "path": str(out_path),
    }


def _f(v: Any) -> Optional[float]:
    if v is None or v == "":
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def fetch_and_build(out_dir: Path, *, stops_path: Optional[Path] = None) -> dict[str, Any]:
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    print(f"Fetching waypoints: {WAYPOINTS_URL}")
    wp_geo = _get_json(WAYPOINTS_URL)
    print(f"Fetching traverse:  {TRAVERSE_URL}")
    tr_geo = _get_json(TRAVERSE_URL)
    print(f"Fetching current:   {CURRENT_URL}")
    try:
        cur_geo = _get_json(CURRENT_URL)
    except Exception as e:
        print(f"  current waypoint fetch failed ({e}); continuing")
        cur_geo = None

    # cache raw geojson for debugging / offline
    (out_dir / "mmgis_waypoints.geojson").write_text(
        json.dumps(wp_geo), encoding="utf-8"
    )
    (out_dir / "mmgis_traverse.geojson").write_text(
        json.dumps(tr_geo), encoding="utf-8"
    )

    waypoints = waypoints_to_frame(wp_geo)
    traverse = traverse_to_frame(tr_geo)
    wp_path = out_dir / "waypoints.parquet"
    tr_path = out_dir / "traverse.parquet"
    waypoints.to_parquet(wp_path, index=False)
    traverse.to_parquet(tr_path, index=False)
    print(f"Wrote {wp_path} ({len(waypoints)} rows)")
    print(f"Wrote {tr_path} ({len(traverse)} rows)")

    current = None
    if cur_geo and cur_geo.get("features"):
        current = waypoints_to_frame(cur_geo)
        if not current.empty:
            cur_path = out_dir / "waypoint_current.parquet"
            current.to_parquet(cur_path, index=False)
            print(f"Wrote {cur_path}")

    stops_path = Path(
        stops_path
        or out_dir / "stops.parquet"
    )
    # Write enriched stops next to stops.parquet
    join_info = join_stops(stops_path, waypoints, out_dir / "stops.parquet")
    if join_info.get("joined"):
        print(
            f"Enriched stops: {join_info['n_with_map']}/{join_info['n_stops']} "
            f"have map lon/lat"
        )
    else:
        print(f"Skip stop join: {join_info.get('reason')}")

    manifest = {
        "built_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": {
            "waypoints": WAYPOINTS_URL,
            "traverse": TRAVERSE_URL,
            "current": CURRENT_URL,
            "waypoints_name": wp_geo.get("name"),
            "traverse_name": tr_geo.get("name"),
        },
        "n_waypoints": len(waypoints),
        "n_traverse_segments": len(traverse),
        "sol_min": int(waypoints["sol"].min()) if len(waypoints) else None,
        "sol_max": int(waypoints["sol"].max()) if len(waypoints) else None,
        "join": join_info,
        "files": {
            "waypoints": wp_path.name,
            "traverse": tr_path.name,
            "waypoints_geojson": "mmgis_waypoints.geojson",
            "traverse_geojson": "mmgis_traverse.geojson",
        },
    }
    if current is not None and not current.empty:
        manifest["current"] = {
            "site": int(current.iloc[0]["site"])
            if pd.notna(current.iloc[0].get("site"))
            else None,
            "drive": int(current.iloc[0]["drive"])
            if pd.notna(current.iloc[0].get("drive"))
            else None,
            "sol": int(current.iloc[0]["sol"])
            if pd.notna(current.iloc[0].get("sol"))
            else None,
            "lon": _f(current.iloc[0].get("lon")),
            "lat": _f(current.iloc[0].get("lat")),
            "dist_total_m": _f(current.iloc[0].get("dist_total_m")),
        }

    man_path = out_dir / "mmgis_manifest.json"
    man_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {man_path}")
    return manifest


def main(argv: Optional[list[str]] = None) -> int:
    p = argparse.ArgumentParser(description="Fetch NASA MMGIS M20 map layers")
    p.add_argument(
        "--out-dir",
        type=Path,
        default=Path(
            __import__("os").environ.get("PERCY_DERIVED_DIR", DEFAULT_OUT)
        ),
    )
    p.add_argument(
        "--stops",
        type=Path,
        default=None,
        help="Local stops.parquet to enrich (default: <out-dir>/stops.parquet)",
    )
    args = p.parse_args(argv)
    try:
        fetch_and_build(args.out_dir, stops_path=args.stops)
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.path.insert(0, str(REPO_ROOT))
    raise SystemExit(main())
