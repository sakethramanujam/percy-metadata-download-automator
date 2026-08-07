"""Runtime configuration for the playground API."""

from __future__ import annotations

import os
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]


def _path(env: str, default: Path) -> Path:
    return Path(os.environ.get(env, default))


DATA_DIR = _path("PERCY_DATA_DIR", REPO_ROOT / "data")
DERIVED_DIR = _path("PERCY_DERIVED_DIR", DATA_DIR / "derived")
IMAGE_CACHE_DIR = _path("PERCY_IMAGE_CACHE", DATA_DIR / "cache" / "images")
CORS_ORIGIN = os.environ.get("PLAYGROUND_CORS_ORIGIN", "http://localhost:5173")
USER_AGENT = os.environ.get(
    "PERCY_USER_AGENT",
    "percy-metadata-playground/0.1 (+local; educational)",
)
# Soft cap on cached image files (count-based LRU)
IMAGE_CACHE_MAX_FILES = int(os.environ.get("PERCY_IMAGE_CACHE_MAX_FILES", "5000"))
REQUEST_TIMEOUT = float(os.environ.get("PERCY_HTTP_TIMEOUT", "60"))
