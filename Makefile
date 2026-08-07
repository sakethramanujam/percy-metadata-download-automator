.PHONY: index map api web playground test

index:
	.venv/bin/python -m playground.pipeline.build_index

map:
	.venv/bin/python -m playground.pipeline.fetch_mmgis

# Full local data prep: image index then NASA map join
data: index map

api:
	.venv/bin/uvicorn playground.api.main:app --reload --host 0.0.0.0 --port 8000

web:
	cd playground/web && npm run dev -- --host 0.0.0.0 --port 5173

test:
	.venv/bin/pytest tests/ -q
