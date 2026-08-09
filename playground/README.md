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

## 1. Build the index + NASA map layers

```bash
source .venv/bin/activate
# uses data/full-metadata.csv by default
python -m playground.pipeline.build_index

# NASA MMGIS localization (real Jezero waypoints + traverse)
python -m playground.pipeline.fetch_mmgis

# or: make data
```

Writes:

- `data/derived/images.parquet`
- `data/derived/stops.parquet` (enriched with lon/lat/easting after map fetch)
- `data/derived/waypoints.parquet`, `traverse.parquet`
- `data/derived/manifest.json`, `mmgis_manifest.json`

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
- **Photo world**: FOV-matched image planes at true body-frame poses per stop (navcam-first, angular diversity, ~40 planes)
- Hover labels, click to select, **Fly to camera**
- Inspector with proxied NASA thumbnail
- **Stereo pairs**: ranked L/R Navcam–MCZ–Hazcam matches, teal baseline in 3D, side-by-side thumbs, JSON export
- **Mission path mode**: MMGIS Jezero traverse (easting/northing) with **FU Berlin orbital basemap** (CTX/HiRISE/HRSC via proxied WMS); click to place rover, double-click to open stop cameras
- **Deep links**: URL `?view=path|stop&site=&drive=&image=` stays in sync for sharing
- **Stop search**: multi-token filter (`9 0`, sol, rmc) + “posed only”
- **Rover eye view**: first-person look through a selected image (FOV-matched photo plane); drag to look; ←/→ step images
- **Stereo depth + body-frame point cloud**: GPU/CPU disparity for a selected L/R pair; back-project into rover body frame and render as a textured 3D cloud in stop view
- **Site multi-drive world**: all drives at one site placed into a shared EN frame (MMGIS easting/northing/yaw + body poses) with photo planes and traverse polyline
- **Guided sol tour**: auto-built mission highlights (path → stop → site) with captions, play/next, keyboard, and deep links `?tour=mission-highlights&step=`
- **Perseverance 3D model** (NASA/JPL-Caltech glTF) on the mission path (selected/latest waypoint) and in stop camera view

## Rover 3D model

Official asset from [NASA Science](https://science.nasa.gov/resource/mars-perseverance-rover-3d-model/):

- File: `playground/web/public/models/Perseverance.glb`
- Credit: **NASA/JPL-Caltech**
- Placed on the map path at the selected (or latest) waypoint using MMGIS yaw; also shown at the origin of stop-local camera frames.

## Coordinate model

### Stop / eye view (aligned to the GLB)

Raw-image poses use a rover body frame (**+X** forward, **+Y** right, **+Z** down).  
The official Perseverance GLB is authored as **+X** right, **+Y** up, **+Z** forward (meters, origin near the ground). The RSM/mast is on the **−X** side of that model.

Stop view uses a single rigid map (1:1 meters, no mesh mirror, no per-part motion):

```text
three = (−body.y, −body.z, body.x)   # left, up, forward
```

plus a small chassis registration offset so fixed hazcams sit near the mesh.

The model stays in its **rest pose** — we do **not** animate mast, head, or arm for individual images. True CAHVOR centers still move with real mast/arm pointing, so mast rays form a small cloud around the static head when many pointings are shown at once. That is expected.

### Mission path

Uses MMGIS **easting/northing** (+ map yaw). Separate from stop-local body/GLB frame.

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
| `GET /api/stops/{site}/{drive}/stereo-depth?pair_id=` | SGBM disparity preview (needs OpenCV) |
| `GET /api/map/basemap?layer=ctx` | FU Berlin Jezero WMS JPEG (waypoint lon/lat hull) |
| `GET /api/map/basemap/layers` | Available basemap layer keys (ctx/hirise/hrsc/base) |

## Tests

```bash
source .venv/bin/activate
pytest tests/test_poses.py -q
```
