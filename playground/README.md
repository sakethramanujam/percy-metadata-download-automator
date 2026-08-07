# Percy Metadata Playground

Local interactive 3D explorer for Mars 2020 (Perseverance) image metadata.

- **Index:** CSV → Parquet (poses, stops)
- **API:** FastAPI (`/api/...`)
- **Web:** Vite + React + Three.js (R3F)

## Prerequisites

```bash
# from repo root
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# metadata catalogue (seed or full catch-up)
# python scripts/metadata.py init --from-kaggle
# python scripts/metadata.py update
```

Node 18+ for the web UI.

## 1. Build the index

```bash
source .venv/bin/activate
# uses data/full-metadata.csv by default
python -m playground.pipeline.build_index

# faster dev subset:
# python -m playground.pipeline.build_index --max-rows 30000
```

Writes:

- `data/derived/images.parquet`
- `data/derived/stops.parquet`
- `data/derived/manifest.json`

## 2. Run API

```bash
source .venv/bin/activate
uvicorn playground.api.main:app --reload --host 127.0.0.1 --port 8000
```

Health: http://127.0.0.1:8000/api/health

## 3. Run web UI

```bash
cd playground/web
npm install
npm run dev
```

Open http://localhost:5173 — Vite proxies `/api` to the backend.

## Coordinate model

Each **(site, drive)** stop is its own local frame. Camera positions and look vectors come from the NASA feed. The UI does **not** merge sites into a global Mars map (that needs external localization).

Three.js uses Y-up; we map NASA `(x,y,z)` → Three `(x, z, y)` for a more natural ground plane.

## API sketch

| Endpoint | Description |
|----------|-------------|
| `GET /api/health` | Index status |
| `GET /api/stats` | Counts + top instruments |
| `GET /api/stops` | Stop list |
| `GET /api/stops/{site}/{drive}/cameras` | Posed cameras for 3D |
| `GET /api/images/{imageid}` | Full metadata row |
| `GET /api/images/{imageid}/thumb?size=small` | Proxied/cached image |

## Tests

```bash
source .venv/bin/activate
pytest tests/test_poses.py -q
```
