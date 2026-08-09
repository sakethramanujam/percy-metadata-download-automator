#!/usr/bin/env python3
"""Build Parquet indexes from full-metadata.csv for the playground API."""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import numpy as np
import pandas as pd

from playground.pipeline.poses import (
    camera_orientation,
    has_pose,
    normalize_vector,
    parse_tuple,
    stereo_partner_instrument,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_INPUT = REPO_ROOT / "data" / "full-metadata.csv"
DEFAULT_OUT = REPO_ROOT / "data" / "derived"


def _file_sha256(path: Path, chunk: int = 1 << 20) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            b = f.read(chunk)
            if not b:
                break
            h.update(b)
    return h.hexdigest()


def _to_float(series: pd.Series) -> pd.Series:
    return pd.to_numeric(series, errors="coerce")


def build_images_frame(df: pd.DataFrame) -> pd.DataFrame:
    """Parse pose-related columns into typed arrays / scalars."""
    n = len(df)
    pos_x = np.full(n, np.nan)
    pos_y = np.full(n, np.nan)
    pos_z = np.full(n, np.nan)
    look_x = np.full(n, np.nan)
    look_y = np.full(n, np.nan)
    look_z = np.full(n, np.nan)
    up_x = np.full(n, np.nan)
    up_y = np.full(n, np.nan)
    up_z = np.full(n, np.nan)
    right_x = np.full(n, np.nan)
    right_y = np.full(n, np.nan)
    right_z = np.full(n, np.nan)
    yaw = np.full(n, np.nan)
    pitch = np.full(n, np.nan)
    roll = np.full(n, np.nan)
    quat_w = np.full(n, np.nan)
    quat_x = np.full(n, np.nan)
    quat_y = np.full(n, np.nan)
    quat_z = np.full(n, np.nan)
    has = np.zeros(n, dtype=bool)
    hfov = np.full(n, np.nan)
    vfov = np.full(n, np.nan)
    model_ok = np.zeros(n, dtype=bool)
    basis_source = np.array([""] * n, dtype=object)

    # Use plain object arrays (faster than Series.iloc in a tight loop)
    attitudes = (
        df["attitude"].to_numpy(dtype=object)
        if "attitude" in df.columns
        else np.full(n, None, dtype=object)
    )
    positions = (
        df["camera_camera_position"].to_numpy(dtype=object)
        if "camera_camera_position" in df.columns
        else np.full(n, None, dtype=object)
    )
    vectors = (
        df["camera_camera_vector"].to_numpy(dtype=object)
        if "camera_camera_vector" in df.columns
        else np.full(n, None, dtype=object)
    )
    instruments = (
        df["camera_instrument"].astype(str).to_numpy()
        if "camera_instrument" in df.columns
        else np.array([""] * n, dtype=object)
    )
    model_types = (
        df["camera_camera_model_type"].astype(str).to_numpy()
        if "camera_camera_model_type" in df.columns
        else np.array(["UNK"] * n, dtype=object)
    )
    model_lists = (
        df["camera_camera_model_component_list"].to_numpy(dtype=object)
        if "camera_camera_model_component_list" in df.columns
        else np.full(n, None, dtype=object)
    )
    dimensions = (
        df["extended_dimension"].to_numpy(dtype=object)
        if "extended_dimension" in df.columns
        else np.full(n, None, dtype=object)
    )

    for i in range(n):
        pos = parse_tuple(positions[i])
        if pos is not None and pos.size >= 3:
            pos_x[i], pos_y[i], pos_z[i] = pos[0], pos[1], pos[2]

        ori = camera_orientation(
            instrument=instruments[i],
            camera_vector=vectors[i],
            model_type=model_types[i],
            model_component_list=model_lists[i],
            dimension=dimensions[i],
            attitude=attitudes[i],
        )
        look = ori.get("look")
        up = ori.get("up")
        right = ori.get("right")
        if look is not None:
            look_x[i], look_y[i], look_z[i] = look[0], look[1], look[2]
        if up is not None:
            up_x[i], up_y[i], up_z[i] = up[0], up[1], up[2]
        if right is not None:
            right_x[i], right_y[i], right_z[i] = right[0], right[1], right[2]
        has[i] = has_pose(
            pos if pos is not None and pos.size >= 3 else None,
            look if look is not None else None,
        )
        hfov[i] = float(ori["hfov_deg"])
        vfov[i] = float(ori["vfov_deg"])
        model_ok[i] = bool(ori.get("model_ok"))
        basis_source[i] = str(ori.get("basis_source") or "")
        yaw[i] = ori["yaw_rad"]
        pitch[i] = ori["pitch_rad"]
        roll[i] = ori["roll_rad"]
        quat_w[i] = ori["quat_w"]
        quat_x[i] = ori["quat_x"]
        quat_y[i] = ori["quat_y"]
        quat_z[i] = ori["quat_z"]

    out = pd.DataFrame(
        {
            "imageid": df["imageid"].astype(str),
            "sol": _to_float(df["sol"]).astype("Int64") if "sol" in df.columns else pd.NA,
            "site": _to_float(df["site"]).astype("Int64") if "site" in df.columns else pd.NA,
            "drive": _to_float(df["drive"]).astype("Int64")
            if "drive" in df.columns
            else pd.NA,
            "date_taken_utc": df["date_taken_utc"].astype(str)
            if "date_taken_utc" in df.columns
            else "",
            "extended_sclk": _to_float(df["extended_sclk"])
            if "extended_sclk" in df.columns
            else np.nan,
            "mast_az": _to_float(df["extended_mastAz"])
            if "extended_mastAz" in df.columns
            else np.nan,
            "mast_el": _to_float(df["extended_mastEl"])
            if "extended_mastEl" in df.columns
            else np.nan,
            "instrument": instruments,
            "filter_name": df["camera_filter_name"].astype(str)
            if "camera_filter_name" in df.columns
            else "",
            "model_type": model_types,
            "model_ok": model_ok,
            "caption": df["caption"].astype(str) if "caption" in df.columns else "",
            "title": df["title"].astype(str) if "title" in df.columns else "",
            "sample_type": df["sample_type"].astype(str)
            if "sample_type" in df.columns
            else "",
            "url_small": df["image_files_small"].astype(str)
            if "image_files_small" in df.columns
            else "",
            "url_medium": df["image_files_medium"].astype(str)
            if "image_files_medium" in df.columns
            else "",
            "url_large": df["image_files_large"].astype(str)
            if "image_files_large" in df.columns
            else "",
            "url_full": df["image_files_full_res"].astype(str)
            if "image_files_full_res" in df.columns
            else "",
            "json_link": df["json_link"].astype(str) if "json_link" in df.columns else "",
            "link": df["link"].astype(str) if "link" in df.columns else "",
            "pos_x": pos_x,
            "pos_y": pos_y,
            "pos_z": pos_z,
            "look_x": look_x,
            "look_y": look_y,
            "look_z": look_z,
            "up_x": up_x,
            "up_y": up_y,
            "up_z": up_z,
            "right_x": right_x,
            "right_y": right_y,
            "right_z": right_z,
            "yaw_rad": yaw,
            "pitch_rad": pitch,
            "roll_rad": roll,
            "quat_w": quat_w,
            "quat_x": quat_x,
            "quat_y": quat_y,
            "quat_z": quat_z,
            "has_pose": has,
            "hfov_deg": hfov,
            "vfov_deg": vfov,
            "basis_source": basis_source,
            "dimension": df["extended_dimension"].astype(str)
            if "extended_dimension" in df.columns
            else "",
            "subframe": df["extended_subframeRect"].astype(str)
            if "extended_subframeRect" in df.columns
            else "",
            "model_components": np.array(
                ["" if x is None else str(x) for x in model_lists], dtype=object
            ),
        }
    )

    # stop id
    out["stop_id"] = (
        out["site"].astype(str).str.replace("<NA>", "na", regex=False)
        + "_"
        + out["drive"].astype(str).str.replace("<NA>", "na", regex=False)
    )

    # stereo partner instrument label (for heuristics; pairing done in API)
    out["stereo_partner"] = out["instrument"].map(
        lambda x: stereo_partner_instrument(str(x)) or ""
    )

    # drop exact duplicate imageids keeping first
    out = out.drop_duplicates(subset=["imageid"], keep="first").reset_index(drop=True)
    return out


def build_stops_frame(images: pd.DataFrame) -> pd.DataFrame:
    if images.empty:
        return pd.DataFrame()

    def _agg(g: pd.DataFrame) -> pd.Series:
        sols = g["sol"].dropna()
        posed = g["has_pose"].sum()
        instruments = g["instrument"].value_counts().to_dict()
        return pd.Series(
            {
                "site": g["site"].iloc[0],
                "drive": g["drive"].iloc[0],
                "n_images": len(g),
                "n_posed": int(posed),
                "pose_frac": float(posed) / max(len(g), 1),
                "sol_min": int(sols.min()) if len(sols) else pd.NA,
                "sol_max": int(sols.max()) if len(sols) else pd.NA,
                "n_sols": int(sols.nunique()) if len(sols) else 0,
                "n_instruments": g["instrument"].nunique(),
                "instruments_json": json.dumps(instruments),
                "date_min": g["date_taken_utc"].replace("", np.nan).dropna().min()
                if g["date_taken_utc"].ne("").any()
                else "",
                "date_max": g["date_taken_utc"].replace("", np.nan).dropna().max()
                if g["date_taken_utc"].ne("").any()
                else "",
                "n_navcam": int(g["instrument"].str.contains("NAVCAM", na=False).sum()),
                "n_mcz": int(g["instrument"].str.contains("MCZ", na=False).sum()),
                "n_stereo_capable": int((g["stereo_partner"] != "").sum()),
            }
        )

    stops = images.groupby("stop_id", sort=False).apply(_agg, include_groups=False)
    stops = stops.reset_index()
    # order by first sol then site/drive
    stops = stops.sort_values(
        ["sol_min", "site", "drive"], ascending=True, na_position="last"
    ).reset_index(drop=True)
    return stops


def build_index(
    input_csv: Path,
    out_dir: Path,
    *,
    max_rows: Optional[int] = None,
) -> dict:
    input_csv = Path(input_csv)
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    if not input_csv.is_file():
        raise FileNotFoundError(f"Input CSV not found: {input_csv}")

    print(f"Reading {input_csv} ...")
    df = pd.read_csv(input_csv, low_memory=False, nrows=max_rows)
    print(f"  rows={len(df)} cols={len(df.columns)}")

    print("Parsing poses / building images index ...")
    images = build_images_frame(df)
    print(f"  images unique={len(images)} posed={int(images['has_pose'].sum())}")

    print("Aggregating stops ...")
    stops = build_stops_frame(images)
    print(f"  stops={len(stops)}")

    images_path = out_dir / "images.parquet"
    stops_path = out_dir / "stops.parquet"
    images.to_parquet(images_path, index=False)
    stops.to_parquet(stops_path, index=False)

    try:
        src_hash = _file_sha256(input_csv)
    except OSError:
        src_hash = ""

    manifest = {
        "built_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source_csv": str(input_csv.resolve()),
        "source_sha256": src_hash,
        "n_images": len(images),
        "n_posed": int(images["has_pose"].sum()),
        "n_stops": len(stops),
        "sol_min": int(images["sol"].min()) if images["sol"].notna().any() else None,
        "sol_max": int(images["sol"].max()) if images["sol"].notna().any() else None,
        "max_rows": max_rows,
        "files": {
            "images": images_path.name,
            "stops": stops_path.name,
        },
    }
    manifest_path = out_dir / "manifest.json"
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)
        f.write("\n")

    print(f"Wrote {images_path}")
    print(f"Wrote {stops_path}")
    print(f"Wrote {manifest_path}")
    return manifest


def main(argv: Optional[list[str]] = None) -> int:
    p = argparse.ArgumentParser(description="Build playground Parquet indexes")
    p.add_argument(
        "--input",
        type=Path,
        default=Path(
            __import__("os").environ.get("PERCY_METADATA_CSV", DEFAULT_INPUT)
        ),
        help="Path to full-metadata.csv",
    )
    p.add_argument(
        "--out-dir",
        type=Path,
        default=Path(
            __import__("os").environ.get("PERCY_DERIVED_DIR", DEFAULT_OUT)
        ),
        help="Output directory for parquet + manifest",
    )
    p.add_argument(
        "--max-rows",
        type=int,
        default=None,
        help="Optional row cap for faster dev builds",
    )
    args = p.parse_args(argv)
    try:
        build_index(args.input, args.out_dir, max_rows=args.max_rows)
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    # Allow `python -m playground.pipeline.build_index` and direct execution
    # when repo root is on PYTHONPATH.
    sys.path.insert(0, str(REPO_ROOT))
    raise SystemExit(main())
