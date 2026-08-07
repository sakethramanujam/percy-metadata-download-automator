#!/usr/bin/env bash
# Daily metadata update + Kaggle publish.
# Intended for cron / systemd.timer.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ -f "$ROOT/.venv/bin/activate" ]]; then
  # shellcheck disable=SC1091
  source "$ROOT/.venv/bin/activate"
fi

export PATH="$ROOT/.venv/bin:${PATH:-}"

LOG_DIR="${PERCY_LOG_DIR:-$ROOT/logs}"
mkdir -p "$LOG_DIR" "$ROOT/data"
LOG_FILE="$LOG_DIR/daily-$(date -u +%Y%m%d).log"

{
  echo "==== $(date -u +%Y-%m-%dT%H:%M:%SZ) daily start ===="
  python "$ROOT/scripts/metadata.py" daily "$@"
  echo "==== $(date -u +%Y-%m-%dT%H:%M:%SZ) daily end (exit $?) ===="
} >>"$LOG_FILE" 2>&1
