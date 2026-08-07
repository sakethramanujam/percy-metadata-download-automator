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
uvicorn playground.api.main:app --reload --host 0.0.0.0 --port 8000
```

Health: http://127.0.0.1:8000/api/health (also via your LAN IP)

## 3. Run web UI

```bash
cd playground/web
npm install
npm run dev -- --host 0.0.0.0 --port 5173
```

Open:

- http://localhost:5173
- http://&lt;machine-ip&gt;:5173 from another device on the LAN

Vite proxies `/api` to the backend on this machine.

## UI features (v1 + polish)

- Stop list + bottom **path strip** (stops ordered by first sol)
- Instrument **layers** (NAVCAM / MCZ / HAZCAM / OTHER)
- **Sol timeline** slider with histogram, Play/Pause progressive reveal
- 3D poses, look **rays**, optional multi **frustums**
- Hover labels, click to select, **Fly to camera**
- Inspector with proxied NASA thumbnail
- **Stereo pairs**: ranked L/R Navcam–MCZ–Hazcam matches, teal baseline in 3D, side-by-side thumbs, JSON export
- **Mission path mode**: schematic 3D trail of `(site, drive)` stops ordered by sol (not map coordinates); click a node to open that stop’s local camera cloud

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
| `GET /api/stops/{site}/{drive}/stereo-pairs` | Ranked L/R stereo candidates |

## Tests

```bash
source .venv/bin/activate
pytest tests/test_poses.py -q
```
