"""Disk cache + fetch for NASA image URLs."""

from __future__ import annotations

import hashlib
import time
from pathlib import Path
from typing import Optional
from urllib.parse import urlparse

import httpx

from playground.api import config


def _ext_from_url(url: str) -> str:
    path = urlparse(url).path
    suf = Path(path).suffix.lower()
    if suf in {".jpg", ".jpeg", ".png", ".webp", ".gif"}:
        return suf
    return ".jpg"


def cache_key(imageid: str, size: str) -> str:
    raw = f"{imageid}|{size}".encode()
    return hashlib.sha256(raw).hexdigest()[:32]


def cache_path(imageid: str, size: str, url: str) -> Path:
    config.IMAGE_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    return config.IMAGE_CACHE_DIR / f"{cache_key(imageid, size)}{_ext_from_url(url)}"


def _evict_if_needed() -> None:
    root = config.IMAGE_CACHE_DIR
    if not root.is_dir():
        return
    files = sorted(root.glob("*"), key=lambda p: p.stat().st_mtime)
    max_n = config.IMAGE_CACHE_MAX_FILES
    while len(files) > max_n:
        old = files.pop(0)
        try:
            old.unlink(missing_ok=True)
        except OSError:
            break


def get_cached_or_fetch(
    imageid: str,
    size: str,
    url: str,
    *,
    force: bool = False,
) -> tuple[Path, str]:
    """Return (path, media_type). Raises httpx.HTTPError on fetch failure."""
    if not url or not url.startswith("http"):
        raise ValueError(f"Invalid image URL for {imageid}")

    path = cache_path(imageid, size, url)
    media = "image/jpeg" if path.suffix.lower() in {".jpg", ".jpeg"} else "image/png"
    if path.suffix.lower() == ".webp":
        media = "image/webp"
    if path.suffix.lower() == ".gif":
        media = "image/gif"

    if path.is_file() and not force:
        # touch mtime for LRU
        try:
            path.touch()
        except OSError:
            pass
        return path, media

    headers = {"User-Agent": config.USER_AGENT}
    last_err: Optional[Exception] = None
    for attempt in range(1, 4):
        try:
            with httpx.Client(timeout=config.REQUEST_TIMEOUT, follow_redirects=True) as client:
                r = client.get(url, headers=headers)
                r.raise_for_status()
                path.write_bytes(r.content)
                ctype = r.headers.get("content-type", media).split(";")[0].strip()
                if ctype.startswith("image/"):
                    media = ctype
                _evict_if_needed()
                return path, media
        except Exception as e:
            last_err = e
            time.sleep(min(2**attempt, 8))
    assert last_err is not None
    raise last_err
