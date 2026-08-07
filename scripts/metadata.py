#!/usr/bin/env python3
"""Perseverance (Mars 2020) image metadata downloader + daily updater.

Pulls from NASA's public raw-images API, maintains a local full CSV, and can
publish a new version to Kaggle via the modern Kaggle CLI.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import shutil
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Optional

import pandas as pd
import requests
from tqdm import tqdm

# NASA API hard-caps around 100 images per page (larger num still returns 100).
PAGE_SIZE = 100
DEFAULT_WORKERS = 12
STATS_URL = (
    "https://mars.nasa.gov/rss/api/"
    "?feed=raw_images&category=mars2020&feedtype=json&latest=true"
)
PAGE_URL = (
    "https://mars.nasa.gov/rss/api/"
    "?feed=raw_images&category=mars2020&feedtype=json"
    "&num={num}&page={page}&order=sol+desc&extended="
)

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DATA_DIR = REPO_ROOT / "data"
DEFAULT_METADATA_NAME = "full-metadata.csv"
DEFAULT_STATE_NAME = "state.json"
DEFAULT_KAGGLE_DIR = REPO_ROOT / "kaggle_dataset"
DEFAULT_DATASET = "sakethramanujam/mars2020imagecatalogue"
REQUEST_TIMEOUT = 90
MAX_RETRIES = 5
CHECKPOINT_EVERY_PAGES = 200


# ---------------------------------------------------------------------------
# Paths / state
# ---------------------------------------------------------------------------

def data_paths(data_dir: Path) -> tuple[Path, Path]:
    data_dir = Path(data_dir)
    data_dir.mkdir(parents=True, exist_ok=True)
    return data_dir / DEFAULT_METADATA_NAME, data_dir / DEFAULT_STATE_NAME


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def now_stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d-%H_%M_%S")


def load_state(state_path: Path) -> dict:
    if not state_path.is_file():
        return {
            "last_updated": "",
            "total_images": 0,
            "n_rows": 0,
            "metadata_file": DEFAULT_METADATA_NAME,
        }
    with open(state_path, encoding="utf-8") as f:
        return json.load(f)


def save_state(state_path: Path, state: dict) -> None:
    state_path.parent.mkdir(parents=True, exist_ok=True)
    with open(state_path, "w", encoding="utf-8") as f:
        json.dump(state, f, indent=2)
        f.write("\n")


# ---------------------------------------------------------------------------
# NASA API
# ---------------------------------------------------------------------------

def _session() -> requests.Session:
    s = requests.Session()
    s.headers.update({"User-Agent": "percy-metadata-automation/2.0"})
    return s


def nasa_total_images(session: Optional[requests.Session] = None) -> int:
    sess = session or _session()
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            r = sess.get(STATS_URL, timeout=REQUEST_TIMEOUT)
            r.raise_for_status()
            return int(r.json()["total"])
        except Exception as e:
            if attempt == MAX_RETRIES:
                raise RuntimeError(f"Failed to fetch NASA stats: {e}") from e
            time.sleep(min(2 ** attempt, 30))
    raise RuntimeError("unreachable")


def get_image_list(
    page: int,
    session: Optional[requests.Session] = None,
    num: int = PAGE_SIZE,
) -> list[dict]:
    """Fetch one page. Thread-safe when each call uses its own Session."""
    sess = session or _session()
    url = PAGE_URL.format(num=num, page=page)
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            r = sess.get(url, timeout=REQUEST_TIMEOUT)
            r.raise_for_status()
            return r.json()["images"]
        except Exception as e:
            if attempt == MAX_RETRIES:
                raise RuntimeError(f"Failed page {page}: {e}") from e
            time.sleep(min(2 ** attempt, 30))
    return []


def _fetch_page_frame(page: int, num: int = PAGE_SIZE) -> tuple[int, pd.DataFrame]:
    """Worker helper: own session per task (requests.Session is not fully thread-safe)."""
    images = get_image_list(page, session=_session(), num=num)
    if not images:
        return page, pd.DataFrame()
    return page, pd.json_normalize(images, sep="_")


def download_pages(
    n_pages: int,
    *,
    start_page: int = 0,
    session: Optional[requests.Session] = None,
    workers: int = DEFAULT_WORKERS,
    page_size: int = PAGE_SIZE,
    on_batch: Optional[Callable[[pd.DataFrame, int], None]] = None,
    batch_size: int = CHECKPOINT_EVERY_PAGES,
) -> pd.DataFrame:
    """Download `n_pages` pages starting at `start_page` (newest-first order).

    Uses a thread pool for bulk catch-ups. Optional `on_batch(df_so_far, pages_done)`
    is called every `batch_size` completed pages for checkpointing.
    """
    del session  # each worker builds its own session
    if n_pages <= 0:
        return pd.DataFrame()

    pages = list(range(start_page, start_page + n_pages))
    frames_by_page: dict[int, pd.DataFrame] = {}
    workers = max(1, int(workers))

    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {
            pool.submit(_fetch_page_frame, page, page_size): page for page in pages
        }
        done = 0
        with tqdm(total=len(pages), desc="Downloading metadata pages") as bar:
            for fut in as_completed(futures):
                page, frame = fut.result()
                if not frame.empty:
                    frames_by_page[page] = frame
                done += 1
                bar.update(1)
                if on_batch and done % batch_size == 0:
                    partial = _frames_to_df(frames_by_page)
                    on_batch(partial, done)

    return _frames_to_df(frames_by_page)


def _frames_to_df(frames_by_page: dict[int, pd.DataFrame]) -> pd.DataFrame:
    if not frames_by_page:
        return pd.DataFrame()
    # Stable newest-first page order
    ordered = [frames_by_page[p] for p in sorted(frames_by_page)]
    return pd.concat(ordered, ignore_index=True)


def pages_for_images(n_images: int, page_size: int = PAGE_SIZE) -> int:
    return math.ceil(max(n_images, 0) / page_size)


# ---------------------------------------------------------------------------
# Local metadata CSV
# ---------------------------------------------------------------------------

def load_metadata(path: Path) -> pd.DataFrame:
    if not path.is_file():
        return pd.DataFrame()
    return pd.read_csv(path, low_memory=False)


def save_metadata(df: pd.DataFrame, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    df.to_csv(path, index=False)


def merge_metadata(existing: pd.DataFrame, new: pd.DataFrame) -> pd.DataFrame:
    if existing.empty:
        merged = new.copy()
    elif new.empty:
        merged = existing.copy()
    else:
        merged = pd.concat([new, existing], ignore_index=True)

    if merged.empty:
        return merged

    if "imageid" in merged.columns:
        merged = merged.drop_duplicates(subset=["imageid"], keep="first")
    else:
        merged = merged.drop_duplicates(keep="first")

    # Prefer newest sols first when available
    if "sol" in merged.columns:
        merged = merged.sort_values("sol", ascending=False, kind="mergesort")

    return merged.reset_index(drop=True)


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------

def cmd_status(args: argparse.Namespace) -> int:
    meta_path, state_path = data_paths(args.data_dir)
    state = load_state(state_path)
    local_rows = 0
    if meta_path.is_file():
        local_rows = len(pd.read_csv(meta_path, usecols=[0]))

    try:
        remote_total = nasa_total_images()
    except Exception as e:
        remote_total = None
        print(f"NASA total: unavailable ({e})")

    print(f"data_dir:      {Path(args.data_dir).resolve()}")
    print(f"metadata:      {meta_path} ({'exists' if meta_path.is_file() else 'missing'})")
    print(f"state:         {state_path} ({'exists' if state_path.is_file() else 'missing'})")
    print(f"local rows:    {local_rows}")
    print(f"state total:   {state.get('total_images', 0)}")
    print(f"state n_rows:  {state.get('n_rows', 0)}")
    print(f"last_updated:  {state.get('last_updated') or '(never)'}")
    if remote_total is not None:
        print(f"NASA total:    {remote_total}")
        print(f"behind by:     {max(remote_total - int(state.get('total_images') or 0), 0)} images")
    return 0


def cmd_init(args: argparse.Namespace) -> int:
    meta_path, state_path = data_paths(args.data_dir)
    session = _session()

    if meta_path.is_file() and not args.force:
        print(f"Already initialized at {meta_path}. Use --force to re-init.")
        return 1

    if args.from_kaggle:
        print(f"Downloading seed dataset from Kaggle: {args.dataset}")
        dl_dir = Path(args.data_dir) / "_kaggle_seed"
        if dl_dir.exists():
            shutil.rmtree(dl_dir)
        dl_dir.mkdir(parents=True, exist_ok=True)
        subprocess.run(
            [
                "kaggle",
                "datasets",
                "download",
                args.dataset,
                "-p",
                str(dl_dir),
                "--unzip",
            ],
            check=True,
        )
        csvs = sorted(dl_dir.rglob("*.csv"))
        if not csvs:
            print("No CSV files found in Kaggle download.")
            return 1
        print(f"Merging {len(csvs)} CSV file(s) from Kaggle...")
        frames = [pd.read_csv(p, low_memory=False) for p in csvs]
        df = merge_metadata(pd.DataFrame(), pd.concat(frames, ignore_index=True))
        save_metadata(df, meta_path)
        shutil.rmtree(dl_dir, ignore_errors=True)
        print(f"Seeded {len(df)} rows from Kaggle -> {meta_path}")

    elif args.from_file:
        src = Path(args.from_file)
        if not src.is_file():
            print(f"File not found: {src}")
            return 1
        df = load_metadata(src)
        if "imageid" in df.columns:
            df = df.drop_duplicates(subset=["imageid"], keep="first")
        save_metadata(df, meta_path)
        print(f"Seeded {len(df)} rows from {src} -> {meta_path}")

    elif args.full:
        total = nasa_total_images(session)
        n_pages = pages_for_images(total)
        if args.max_pages is not None:
            n_pages = min(n_pages, args.max_pages)
            print(f"Full download capped at {n_pages} pages (--max-pages).")
        else:
            print(
                f"Downloading ALL metadata: ~{total} images / {n_pages} pages. "
                "This can take many hours."
            )
        workers = getattr(args, "workers", DEFAULT_WORKERS)

        def _checkpoint(partial: pd.DataFrame, pages_done: int) -> None:
            save_metadata(partial, meta_path)
            print(f"\nCheckpoint: {pages_done} pages / {len(partial)} rows -> {meta_path}")

        df = download_pages(
            n_pages,
            workers=workers,
            on_batch=_checkpoint if n_pages >= CHECKPOINT_EVERY_PAGES else None,
        )
        df = merge_metadata(pd.DataFrame(), df)
        save_metadata(df, meta_path)
        print(f"Wrote {len(df)} rows -> {meta_path}")

    else:
        print("Specify one of: --from-kaggle | --from-file PATH | --full")
        return 2

    remote_total = nasa_total_images(session)
    df = load_metadata(meta_path)
    state = {
        "last_updated": now_iso(),
        "total_images": remote_total if args.full and args.max_pages is None else len(df),
        "n_rows": len(df),
        "metadata_file": meta_path.name,
        # When seeding from Kaggle/file, total_images may lag NASA; `update` will catch up.
        "seed_source": (
            "kaggle" if args.from_kaggle else ("file" if args.from_file else "full")
        ),
    }
    # For partial seeds, store local row count as baseline so update pulls the gap
    # based on NASA total vs state.total_images. Prefer NASA total only after full catch-up.
    if not args.full or args.max_pages is not None:
        # Use local unique count as "known" so update fetches remote_total - known pages worth
        # Actually better: set total_images low so update thinks we're behind.
        # Set to n_rows so we fetch (remote - n_rows) new images.
        state["total_images"] = len(df)
    else:
        state["total_images"] = remote_total

    save_state(state_path, state)
    print(f"State written -> {state_path}")
    print(
        f"NASA currently has {remote_total} images; local has {len(df)} rows. "
        "Run `update` to catch up if needed."
    )
    return 0


def cmd_update(args: argparse.Namespace) -> int:
    meta_path, state_path = data_paths(args.data_dir)
    session = _session()

    if not meta_path.is_file():
        print(
            f"No local metadata at {meta_path}. "
            "Run: python scripts/metadata.py init --from-kaggle"
        )
        return 1

    state = load_state(state_path)
    remote_total = nasa_total_images(session)
    existing = load_metadata(meta_path)
    local_rows = len(existing)
    known = int(state.get("total_images") or 0)

    # Reconcile empty/stale state against the local CSV.
    if known <= 0 and local_rows > 0:
        known = local_rows
        print(f"State missing total_images; using local row count {known}")

    # Cover both "NASA grew since last complete sync" and "local catalogue
    # is still catching up after a seed / partial run".
    growth = max(remote_total - known, 0)
    deficit = max(remote_total - local_rows, 0)
    new_count = max(growth, deficit)
    print(
        f"NASA total={remote_total}, known={known}, local_rows={local_rows}, "
        f"delta={new_count}"
    )

    if new_count <= 0 and not args.force_refresh_pages:
        print("Nothing new to download.")
        state["last_updated"] = now_iso()
        state["total_images"] = remote_total
        state["n_rows"] = local_rows
        state["complete"] = True
        save_state(state_path, state)
        return 0

    # Newest-first pages: pull enough pages to cover new images, plus a small
    # buffer for page-boundary drift, then dedupe on imageid.
    uncapped_pages = pages_for_images(new_count) + int(args.page_buffer)
    if args.force_refresh_pages:
        uncapped_pages = max(uncapped_pages, args.force_refresh_pages)
    pages_needed = uncapped_pages
    if args.max_pages is not None:
        pages_needed = min(pages_needed, args.max_pages)
    partial = pages_needed < uncapped_pages

    workers = getattr(args, "workers", DEFAULT_WORKERS)
    est_min = max(pages_needed / max(workers, 1) * 0.5, 1)
    print(
        f"Downloading {pages_needed} newest page(s) "
        f"(page_size={PAGE_SIZE}, workers={workers}, ~{est_min:.0f}+ min)..."
    )

    checkpoint_path = Path(args.data_dir) / "patch-checkpoint.csv"

    def _checkpoint(partial: pd.DataFrame, pages_done: int) -> None:
        # Save patch only (cheap). Final merge into full-metadata happens at end.
        save_metadata(partial, checkpoint_path)
        mid_state = {
            **state,
            "last_updated": now_iso(),
            "last_partial": True,
            "complete": False,
            "catchup_pages_done": pages_done,
            "catchup_pages_total": pages_needed,
            "patch_checkpoint_rows": len(partial),
        }
        save_state(state_path, mid_state)
        print(
            f"\nCheckpoint: {pages_done}/{pages_needed} pages, "
            f"{len(partial)} patch rows -> {checkpoint_path.name}"
        )

    patch = download_pages(
        pages_needed,
        workers=workers,
        on_batch=_checkpoint if pages_needed >= CHECKPOINT_EVERY_PAGES else None,
    )
    print(f"Fetched {len(patch)} rows in patch")

    merged = merge_metadata(existing, patch)
    save_metadata(merged, meta_path)
    if checkpoint_path.is_file():
        checkpoint_path.unlink(missing_ok=True)

    added = len(merged) - len(existing)
    # Only mark fully synced when the run was not page-capped. On a partial
    # catch-up, keep total_images at the local unique row count so the next
    # update still sees the remaining NASA deficit.
    if partial:
        synced_total = len(merged)
        print(
            f"Partial update: local has {synced_total} unique rows; "
            f"NASA has {remote_total}. Re-run update to continue catch-up."
        )
    else:
        synced_total = remote_total

    state.update(
        {
            "last_updated": now_iso(),
            "total_images": synced_total,
            "n_rows": len(merged),
            "metadata_file": meta_path.name,
            "last_patch_rows": len(patch),
            "last_rows_added": max(added, 0),
            "last_partial": partial,
            "complete": (not partial) and len(merged) > 0,
            "catchup_pages_done": pages_needed,
            "catchup_pages_total": pages_needed,
        }
    )
    save_state(state_path, state)
    print(f"Updated {meta_path}: {len(existing)} -> {len(merged)} rows (+{max(added, 0)})")
    return 0


def _kaggle_bin() -> str:
    # Prefer venv kaggle if present
    venv_kaggle = REPO_ROOT / ".venv" / "bin" / "kaggle"
    if venv_kaggle.is_file():
        return str(venv_kaggle)
    return "kaggle"


def cmd_publish(args: argparse.Namespace) -> int:
    meta_path, state_path = data_paths(args.data_dir)
    if not meta_path.is_file():
        print(f"Missing {meta_path}; run init/update first.")
        return 1

    kaggle_dir = Path(args.kaggle_dir)
    kaggle_dir.mkdir(parents=True, exist_ok=True)
    meta_json = kaggle_dir / "dataset-metadata.json"
    if not meta_json.is_file():
        print(f"Missing {meta_json}")
        return 1

    # Copy current full metadata into the upload folder
    dest_csv = kaggle_dir / meta_path.name
    shutil.copy2(meta_path, dest_csv)

    state = load_state(state_path)
    message = args.message or (
        f"Daily metadata update {now_stamp()} "
        f"(rows={state.get('n_rows', '?')}, nasa_total={state.get('total_images', '?')})"
    )

    cmd = [
        _kaggle_bin(),
        "datasets",
        "version",
        "-p",
        str(kaggle_dir),
        "-m",
        message,
        "--dir-mode",
        "zip",
    ]
    if args.quiet:
        cmd.append("--quiet")

    print("Publishing to Kaggle:", " ".join(cmd))
    try:
        subprocess.run(cmd, check=True)
    except FileNotFoundError:
        print("kaggle CLI not found. Install with: pip install -r requirements.txt")
        return 1
    except subprocess.CalledProcessError as e:
        print(f"Kaggle publish failed with exit code {e.returncode}")
        return e.returncode or 1

    print("Kaggle dataset version created.")
    return 0


def cmd_daily(args: argparse.Namespace) -> int:
    """Update local metadata; publish to Kaggle only if new rows were added (or --always-publish)."""
    meta_path, state_path = data_paths(args.data_dir)
    before = load_state(state_path)
    before_rows = int(before.get("n_rows") or 0)

    rc = cmd_update(args)
    if rc != 0:
        return rc

    after = load_state(state_path)
    after_rows = int(after.get("n_rows") or 0)
    added = after_rows - before_rows

    if added > 0 or args.always_publish:
        print(f"Publishing (added={added}, always_publish={args.always_publish})...")
        return cmd_publish(args)

    print("No new rows; skipping Kaggle publish.")
    return 0


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="Percy / Mars 2020 image metadata automation",
    )
    p.add_argument(
        "--data-dir",
        type=Path,
        default=Path(os.environ.get("PERCY_DATA_DIR", DEFAULT_DATA_DIR)),
        help="Directory for full-metadata.csv and state.json (default: ./data)",
    )

    sub = p.add_subparsers(dest="command", required=True)

    sp = sub.add_parser("status", help="Show local + NASA sync status")
    sp.set_defaults(func=cmd_status)

    ip = sub.add_parser("init", help="Bootstrap local metadata")
    src = ip.add_mutually_exclusive_group(required=True)
    src.add_argument(
        "--from-kaggle",
        action="store_true",
        help="Seed from existing Kaggle dataset",
    )
    src.add_argument(
        "--from-file",
        metavar="PATH",
        help="Seed from a local CSV",
    )
    src.add_argument(
        "--full",
        action="store_true",
        help="Download all pages from NASA (slow)",
    )
    ip.add_argument(
        "--dataset",
        default=os.environ.get("PERCY_KAGGLE_DATASET", DEFAULT_DATASET),
        help=f"Kaggle dataset slug (default: {DEFAULT_DATASET})",
    )
    ip.add_argument(
        "--max-pages",
        type=int,
        default=None,
        help="Cap pages for --full (testing)",
    )
    ip.add_argument(
        "--force",
        action="store_true",
        help="Overwrite existing local metadata",
    )
    ip.add_argument(
        "--workers",
        type=int,
        default=DEFAULT_WORKERS,
        help=f"Parallel page downloads for --full (default: {DEFAULT_WORKERS})",
    )
    ip.set_defaults(func=cmd_init)

    up = sub.add_parser("update", help="Download new metadata since last run")
    up.add_argument(
        "--max-pages",
        type=int,
        default=None,
        help="Cap number of newest pages to fetch",
    )
    up.add_argument(
        "--page-buffer",
        type=int,
        default=2,
        help="Extra pages beyond computed delta (default: 2)",
    )
    up.add_argument(
        "--force-refresh-pages",
        type=int,
        default=0,
        metavar="N",
        help="Always fetch at least N newest pages",
    )
    up.add_argument(
        "--workers",
        type=int,
        default=DEFAULT_WORKERS,
        help=f"Parallel page downloads (default: {DEFAULT_WORKERS})",
    )
    up.set_defaults(func=cmd_update)

    pp = sub.add_parser("publish", help="Push local full-metadata.csv to Kaggle")
    pp.add_argument(
        "--kaggle-dir",
        type=Path,
        default=DEFAULT_KAGGLE_DIR,
        help="Folder with dataset-metadata.json (default: ./kaggle_dataset)",
    )
    pp.add_argument("-m", "--message", default=None, help="Dataset version notes")
    pp.add_argument("-q", "--quiet", action="store_true")
    pp.set_defaults(func=cmd_publish)

    dp = sub.add_parser(
        "daily",
        help="Update then publish to Kaggle if there is new data",
    )
    dp.add_argument("--max-pages", type=int, default=None)
    dp.add_argument("--page-buffer", type=int, default=2)
    dp.add_argument("--force-refresh-pages", type=int, default=0, metavar="N")
    dp.add_argument(
        "--workers",
        type=int,
        default=DEFAULT_WORKERS,
        help=f"Parallel page downloads (default: {DEFAULT_WORKERS})",
    )
    dp.add_argument(
        "--kaggle-dir",
        type=Path,
        default=DEFAULT_KAGGLE_DIR,
    )
    dp.add_argument("-m", "--message", default=None)
    dp.add_argument("-q", "--quiet", action="store_true")
    dp.add_argument(
        "--always-publish",
        action="store_true",
        help="Publish even when no new rows were added",
    )
    dp.set_defaults(func=cmd_daily)

    return p


def main(argv: Optional[list[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
