# percy-metadata-automation

Daily automation for Perseverance (Mars 2020) raw-image **metadata**:

1. Pull new rows from NASA’s public RSS/JSON API  
2. Maintain a local `data/full-metadata.csv`  
3. Publish a new version to the Kaggle dataset  
   [`sakethramanujam/mars2020imagecatalogue`](https://www.kaggle.com/datasets/sakethramanujam/mars2020imagecatalogue)

## Setup

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

### Kaggle CLI auth

The modern Kaggle CLI (v2+) uses either:

- **Access token** (preferred): `~/.kaggle/access_token`, or  
- **Legacy API key**: `~/.kaggle/kaggle.json` (`{"username":"...","key":"..."}`)

Interactive login:

```bash
kaggle auth login
```

Verify:

```bash
kaggle config view
kaggle datasets status sakethramanujam/mars2020imagecatalogue
```

## Bootstrap local data

Prefer seeding from the existing Kaggle dataset, then catching up to NASA:

```bash
python scripts/metadata.py init --from-kaggle
python scripts/metadata.py update          # fetch anything newer than the seed
python scripts/metadata.py status
```

Other options:

```bash
# From a local CSV you already have
python scripts/metadata.py init --from-file path/to/metadata.csv

# Full scrape from NASA (very slow — tens of thousands of pages)
python scripts/metadata.py init --full
```

## Daily update

Update local CSV and publish to Kaggle **only if new rows were added**:

```bash
python scripts/metadata.py daily
```

Or step by step:

```bash
python scripts/metadata.py update
python scripts/metadata.py publish -m "Manual metadata refresh"
```

Wrapper (logs under `logs/`):

```bash
./scripts/run_daily.sh
```

### Schedule with cron

```bash
crontab -e
```

Run every day at 06:00 UTC (replace with the absolute path to your clone):

```cron
0 6 * * * /path/to/percy-metadata-automation/scripts/run_daily.sh
```

### Schedule with systemd (user timer)

`~/.config/systemd/user/percy-metadata.service`:

```ini
[Unit]
Description=Percy metadata daily update + Kaggle publish

[Service]
Type=oneshot
WorkingDirectory=%h/path/to/percy-metadata-automation
ExecStart=%h/path/to/percy-metadata-automation/scripts/run_daily.sh
```

`~/.config/systemd/user/percy-metadata.timer`:

```ini
[Unit]
Description=Run Percy metadata update daily

[Timer]
OnCalendar=*-*-* 06:00:00
Persistent=true

[Install]
WantedBy=timers.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now percy-metadata.timer
systemctl --user list-timers | grep percy
```

## CLI reference

| Command | Purpose |
|---------|---------|
| `status` | Local rows vs NASA total |
| `init --from-kaggle` | Seed from Kaggle dataset |
| `init --from-file PATH` | Seed from local CSV |
| `init --full` | Full NASA scrape |
| `update` | Incremental download of new images |
| `publish` | `kaggle datasets version` upload |
| `daily` | `update` + conditional `publish` |

Useful flags:

- `--data-dir DIR` — default `./data` (or `PERCY_DATA_DIR`)
- `--max-pages N` — cap pages (testing / slow networks)
- `daily --always-publish` — push even with no new rows

## 3D playground (local)

Explore poses and images interactively (Three.js + FastAPI):

```bash
python -m playground.pipeline.build_index
uvicorn playground.api.main:app --reload --port 8000
# other terminal:
cd playground/web && npm install && npm run dev
```

See [playground/README.md](playground/README.md).

## Layout

```
data/                         # local full-metadata.csv + state.json (gitignored)
data/derived/                 # parquet index for playground (gitignored)
kaggle_dataset/
  dataset-metadata.json       # Kaggle dataset id / description
scripts/
  metadata.py                 # main CLI
  run_daily.sh                # cron/systemd entrypoint
  *_metadata.csv              # small historical samples
playground/
  pipeline/                   # CSV → parquet index
  api/                        # FastAPI
  web/                        # Vite + React Three Fiber UI
```

## Notes

- NASA feed is newest-first (`order=sol+desc`). Updates pull the newest pages covering the image delta, then **dedupe on `imageid`**.
- After a long outage, the first `update` may download many pages; that is expected until local state matches NASA’s total.
- Full catalogue size is large (~1M+ images). Prefer `init --from-kaggle` + `update` over `init --full`.
