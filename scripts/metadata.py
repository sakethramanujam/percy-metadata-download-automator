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
REQUEST_TIMEOUT = 120
MAX_RETRIES = 6
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


def pre_merge_backups(data_dir: Path) -> list[Path]:
    """List full-metadata.pre-merge-*.csv backups, oldest first."""
    data_dir = Path(data_dir)
    return sorted(data_dir.glob("full-metadata.pre-merge-*.csv"))


def prune_pre_merge_backups(data_dir: Path, *, keep: int = 0) -> list[Path]:
    """Delete pre-merge CSV backups, keeping at most `keep` newest.

    Each backup is a full copy of the catalogue (~0.5–1GB). Cron / merge must
    not leave these around or the disk fills quickly.
    """
    keep = max(int(keep), 0)
    backups = pre_merge_backups(data_dir)
    if keep:
        to_delete = backups[:-keep] if len(backups) > keep else []
    else:
        to_delete = backups
    removed: list[Path] = []
    for path in to_delete:
        try:
            path.unlink(missing_ok=True)
            removed.append(path)
            print(f"Removed stale backup {path.name}")
        except OSError as e:
            print(f"WARNING: could not remove {path}: {e}")
    return removed


def stage_metadata_for_kaggle(src: Path, dest: Path) -> None:
    """Stage CSV into the Kaggle upload dir using a hardlink when possible.

    Avoids a second multi-hundred-MB copy on the same filesystem. Falls back
    to shutil.copy2 when link is not allowed (cross-device, permissions).
    """
    dest = Path(dest)
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists() or dest.is_symlink():
        dest.unlink(missing_ok=True)
    try:
        os.link(src, dest)
        print(f"Staged {dest.name} (hardlink → {src})")
    except OSError:
        shutil.copy2(src, dest)
        print(f"Staged {dest.name} (copy → {src})")


def unstage_kaggle_csv(kaggle_dir: Path, name: str = DEFAULT_METADATA_NAME) -> None:
    """Drop staged full-metadata.csv after publish so it doesn't double disk use."""
    path = Path(kaggle_dir) / name
    if path.is_file():
        try:
            path.unlink()
            print(f"Removed staged upload file {path.name}")
        except OSError as e:
            print(f"WARNING: could not remove staged {path}: {e}")


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


def _fetch_page_frame(
    page: int, num: int = PAGE_SIZE, *, soft: bool = True
) -> tuple[int, pd.DataFrame, Optional[str]]:
    """Worker helper: own session per task (requests.Session is not fully thread-safe).

    When soft=True (default), failures return an empty frame + error string instead of
    raising — one bad page must not kill a multi-hour catch-up.
    """
    try:
        images = get_image_list(page, session=_session(), num=num)
        if not images:
            return page, pd.DataFrame(), None
        return page, pd.json_normalize(images, sep="_"), None
    except Exception as e:
        if soft:
            return page, pd.DataFrame(), str(e)
        raise


def download_pages(
    n_pages: int,
    *,
    start_page: int = 0,
    session: Optional[requests.Session] = None,
    workers: int = DEFAULT_WORKERS,
    page_size: int = PAGE_SIZE,
    on_batch: Optional[Callable[[pd.DataFrame, int], None]] = None,
    batch_size: int = CHECKPOINT_EVERY_PAGES,
    soft_fail: bool = True,
) -> pd.DataFrame:
    """Download `n_pages` pages starting at `start_page` (newest-first order).

    Uses a thread pool for bulk catch-ups. Optional `on_batch(df_so_far, pages_done)`
    is called every `batch_size` completed pages for checkpointing.

    soft_fail=True (default): log and skip pages that keep failing after retries.
    """
    del session  # each worker builds its own session
    if n_pages <= 0:
        return pd.DataFrame()

    pages = list(range(start_page, start_page + n_pages))
    frames_by_page: dict[int, pd.DataFrame] = {}
    workers = max(1, int(workers))
    failed_pages: list[tuple[int, str]] = []

    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {
            pool.submit(_fetch_page_frame, page, page_size, soft=soft_fail): page
            for page in pages
        }
        done = 0
        with tqdm(total=len(pages), desc="Downloading metadata pages") as bar:
            for fut in as_completed(futures):
                try:
                    page, frame, err = fut.result()
                except Exception as e:
                    page = futures[fut]
                    err = str(e)
                    frame = pd.DataFrame()
                if err:
                    failed_pages.append((page, err))
                    bar.set_postfix_str(f"skip p{page}", refresh=False)
                elif not frame.empty:
                    frames_by_page[page] = frame
                done += 1
                bar.update(1)
                if on_batch and done % batch_size == 0:
                    partial = _frames_to_df(frames_by_page)
                    on_batch(partial, done)

    if failed_pages:
        print(
            f"Warning: skipped {len(failed_pages)} page(s) after retries "
            f"(first: page {failed_pages[0][0]}: {failed_pages[0][1][:120]})"
        )
        # Persist failed page list next to data dir when possible via caller state
        download_pages.last_failed_pages = failed_pages  # type: ignore[attr-defined]

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

    # NASA's stats `total` (~1M) is NOT the same metric as unique imageids in
    # the paginated raw-images feed (~560k). After a complete catch-up we only
    # chase *growth* in the NASA counter. During incomplete catch-up we still
    # estimate remaining pages from remote_total vs local_rows (imperfect but
    # useful for resume); prefer --start-page for controlled deep archives.
    growth = max(remote_total - known, 0)
    complete = bool(state.get("complete"))
    if complete and known > 0:
        deficit = 0
        new_count = growth
        # Always nibble a few newest pages so delayed publishes aren't missed
        # when NASA's total counter lags or stays flat.
        if new_count <= 0 and not args.force_refresh_pages:
            # Fall through to a small newest-page refresh below via page_buffer
            # by treating as a tiny growth. Callers can --max-pages to cap.
            new_count = PAGE_SIZE  # one page worth; buffer adds more
            print(
                f"NASA total={remote_total}, known={known}, local_rows={local_rows}, "
                f"complete=true → newest-page refresh (no deficit re-crawl)"
            )
        else:
            print(
                f"NASA total={remote_total}, known={known}, local_rows={local_rows}, "
                f"growth={growth} (complete catalogue; ignoring total-vs-rows deficit)"
            )
    else:
        deficit = max(remote_total - local_rows, 0)
        new_count = max(growth, deficit)
        print(
            f"NASA total={remote_total}, known={known}, local_rows={local_rows}, "
            f"delta={new_count} (incomplete catch-up)"
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
    # Optional --start-page resumes mid-archive (skip already-fetched newest pages).
    start_page = int(getattr(args, "start_page", 0) or 0)
    if start_page < 0:
        start_page = 0

    total_pages = pages_for_images(remote_total)
    if start_page > 0:
        # Continue deeper into older sols rather than re-fetching newest pages.
        uncapped_pages = max(total_pages - start_page, 0) + int(args.page_buffer)
        print(
            f"Resuming from page {start_page} "
            f"(NASA ~{total_pages} pages total, remaining ~{uncapped_pages})"
        )
    else:
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
        f"Downloading {pages_needed} page(s) from start_page={start_page} "
        f"(page_size={PAGE_SIZE}, workers={workers}, ~{est_min:.0f}+ min)..."
    )

    checkpoint_path = Path(args.data_dir) / "patch-checkpoint.csv"

    def _checkpoint(partial_df: pd.DataFrame, pages_done: int) -> None:
        # Save patch only (cheap). Final merge into full-metadata happens at end.
        save_metadata(partial_df, checkpoint_path)
        absolute_done = start_page + pages_done
        mid_state = {
            **state,
            "last_updated": now_iso(),
            "last_partial": True,
            "complete": False,
            "catchup_pages_done": absolute_done,
            "catchup_pages_total": start_page + pages_needed,
            "catchup_start_page": start_page,
            "patch_checkpoint_rows": len(partial_df),
        }
        save_state(state_path, mid_state)
        print(
            f"\nCheckpoint: {pages_done}/{pages_needed} pages this run "
            f"(absolute page ~{absolute_done}), "
            f"{len(partial_df)} patch rows -> {checkpoint_path.name}"
        )

    patch = download_pages(
        pages_needed,
        start_page=start_page,
        workers=workers,
        on_batch=_checkpoint if pages_needed >= CHECKPOINT_EVERY_PAGES else None,
    )
    print(f"Fetched {len(patch)} rows in patch")

    merged = merge_metadata(existing, patch)
    save_metadata(merged, meta_path)
    if checkpoint_path.is_file():
        checkpoint_path.unlink(missing_ok=True)

    added = len(merged) - len(existing)
    # Only mark fully synced when the run was not page-capped and we covered
    # through the end of the NASA catalogue from start_page 0 (or a full resume).
    # Exception: a catalogue already marked complete only needs a newest-page
    # refresh; NASA stats `total` is a different metric from unique imageids, so
    # never demote complete→incomplete just because max-pages capped the nibble.
    reached_end = (start_page + pages_needed) >= total_pages and not partial
    was_complete = bool(state.get("complete"))
    stay_complete = was_complete and start_page == 0
    if not reached_end and not stay_complete:
        print(
            f"Partial update: local has {len(merged)} unique rows; "
            f"NASA has {remote_total}. Re-run update "
            f"(e.g. --start-page {start_page + pages_needed}) to continue catch-up."
        )
    elif stay_complete and not reached_end:
        print(
            f"Newest-page refresh: +{max(added, 0)} rows "
            f"(local unique={len(merged)}; NASA stats total={remote_total}). "
            f"Catalogue remains complete."
        )

    # total_images tracks the NASA stats counter for growth detection — not
    # local unique rows (those live in n_rows).
    state.update(
        {
            "last_updated": now_iso(),
            "total_images": remote_total if (reached_end or stay_complete) else len(merged),
            "n_rows": len(merged),
            "metadata_file": meta_path.name,
            "last_patch_rows": len(patch),
            "last_rows_added": max(added, 0),
            "last_partial": not (reached_end or stay_complete),
            "complete": (reached_end or stay_complete) and len(merged) > 0,
            "catchup_pages_done": start_page + pages_needed,
            "catchup_pages_total": total_pages,
            "catchup_start_page": start_page,
        }
    )
    save_state(state_path, state)
    print(f"Updated {meta_path}: {len(existing)} -> {len(merged)} rows (+{max(added, 0)})")
    failed = getattr(download_pages, "last_failed_pages", None)
    if failed:
        state["last_failed_pages"] = len(failed)
        save_state(state_path, state)
    return 0


def cmd_merge_checkpoint(args: argparse.Namespace) -> int:
    """Merge data/patch-checkpoint.csv into full-metadata.csv without downloading."""
    meta_path, state_path = data_paths(args.data_dir)
    checkpoint_path = Path(args.data_dir) / "patch-checkpoint.csv"
    if not checkpoint_path.is_file():
        print(f"No checkpoint at {checkpoint_path}")
        return 1
    if not meta_path.is_file():
        print(f"No full metadata at {meta_path}")
        return 1

    print(f"Loading {meta_path}…")
    existing = load_metadata(meta_path)
    print(f"  full unique={existing['imageid'].nunique() if 'imageid' in existing.columns else len(existing)}")
    print(f"Loading {checkpoint_path}…")
    patch = load_metadata(checkpoint_path)
    print(f"  patch unique={patch['imageid'].nunique() if 'imageid' in patch.columns else len(patch)}")

    # Optional one-shot backup (off by default — each is ~1GB).
    keep_backup = bool(getattr(args, "keep_backup", False))
    backup: Optional[Path] = None
    if keep_backup:
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        backup = Path(args.data_dir) / f"full-metadata.pre-merge-{stamp}.csv"
        shutil.copy2(meta_path, backup)
        print(f"Backup -> {backup.name}")
    else:
        # Always drop any leftovers from older runs before rewriting the CSV.
        prune_pre_merge_backups(args.data_dir, keep=0)

    merged = merge_metadata(existing, patch)
    save_metadata(merged, meta_path)
    added = len(merged) - len(existing)
    print(f"Merged: {len(existing)} -> {len(merged)} (+{max(added, 0)})")

    # Drop the just-created backup after a successful merge unless user wants it.
    if backup is not None and not getattr(args, "retain_backup", False):
        backup.unlink(missing_ok=True)
        print(f"Removed merge backup {backup.name} (merge OK)")
    else:
        # Cap retained backups at 1 newest even when --keep-backup is used.
        prune_pre_merge_backups(args.data_dir, keep=1 if keep_backup else 0)

    if args.remove_checkpoint or not getattr(args, "keep_checkpoint", False):
        checkpoint_path.unlink(missing_ok=True)
        print("Removed patch-checkpoint.csv")

    state = load_state(state_path)
    state.update(
        {
            "last_updated": now_iso(),
            "total_images": len(merged),
            "n_rows": len(merged),
            "metadata_file": meta_path.name,
            "complete": False,
            "last_partial": True,
            "patch_rows_merged": len(patch),
            "unique_after_merge": len(merged),
            "merged_from_checkpoint_at": now_iso(),
        }
    )
    save_state(state_path, state)
    print(f"State -> {state_path}")
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

    # Stage without a second multi-hundred-MB copy when possible (hardlink).
    dest_csv = kaggle_dir / meta_path.name
    stage_metadata_for_kaggle(meta_path, dest_csv)

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
        unstage_kaggle_csv(kaggle_dir, meta_path.name)
        return 1
    except subprocess.CalledProcessError as e:
        print(f"Kaggle publish failed with exit code {e.returncode}")
        # Leave staged file for retry inspection only if --keep-staging.
        if not getattr(args, "keep_staging", False):
            unstage_kaggle_csv(kaggle_dir, meta_path.name)
        return e.returncode or 1

    print("Kaggle dataset version created.")
    if not getattr(args, "keep_staging", False):
        unstage_kaggle_csv(kaggle_dir, meta_path.name)
    return 0


def cmd_daily(args: argparse.Namespace) -> int:
    """Update local metadata; publish to Kaggle only if new rows were added (or --always-publish)."""
    meta_path, state_path = data_paths(args.data_dir)
    # Housekeeping: never let multi-GB pre-merge leftovers accumulate under cron.
    prune_pre_merge_backups(args.data_dir, keep=0)

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

    # Even when we skip publish, drop any leftover staged Kaggle CSV.
    unstage_kaggle_csv(Path(args.kaggle_dir), meta_path.name)
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

    mp = sub.add_parser(
        "merge-checkpoint",
        help="Merge patch-checkpoint.csv into full-metadata.csv",
    )
    mp.add_argument(
        "--remove-checkpoint",
        action="store_true",
        help="Delete patch-checkpoint.csv after a successful merge (default: always remove)",
    )
    mp.add_argument(
        "--keep-checkpoint",
        action="store_true",
        help="Keep patch-checkpoint.csv after merge",
    )
    mp.add_argument(
        "--keep-backup",
        action="store_true",
        help="Write a full-metadata.pre-merge-*.csv before merging (default: no)",
    )
    mp.add_argument(
        "--retain-backup",
        action="store_true",
        help="With --keep-backup, leave the backup on disk after a successful merge",
    )
    mp.set_defaults(func=cmd_merge_checkpoint)

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
    up.add_argument(
        "--start-page",
        type=int,
        default=0,
        help=(
            "Resume catch-up from this newest-first page index "
            "(skip already-fetched newer pages; default: 0)"
        ),
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
    pp.add_argument(
        "--keep-staging",
        action="store_true",
        help="Keep kaggle_dataset/full-metadata.csv after publish (default: remove)",
    )
    pp.set_defaults(func=cmd_publish)

    dp = sub.add_parser(
        "daily",
        help="Update then publish to Kaggle if there is new data",
    )
    dp.add_argument("--max-pages", type=int, default=None)
    dp.add_argument("--page-buffer", type=int, default=2)
    dp.add_argument("--force-refresh-pages", type=int, default=0, metavar="N")
    dp.add_argument(
        "--start-page",
        type=int,
        default=0,
        help="Resume catch-up from this newest-first page index",
    )
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
    dp.add_argument(
        "--keep-staging",
        action="store_true",
        help="Keep kaggle_dataset/full-metadata.csv after publish (default: remove)",
    )
    dp.set_defaults(func=cmd_daily)

    return p


def main(argv: Optional[list[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
