.PHONY: index map data api web test status merge-checkpoint publish update catchup reload-api

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

status:
	.venv/bin/python scripts/metadata.py status

merge-checkpoint:
	.venv/bin/python scripts/metadata.py merge-checkpoint

publish:
	.venv/bin/python scripts/metadata.py publish

# Resume catch-up from a page index (default 0 = newest)
update:
	.venv/bin/python scripts/metadata.py update --workers 6

# Example: make catchup START=4800
START ?= 0
catchup:
	.venv/bin/python scripts/metadata.py update --start-page $(START) --workers 6

reload-api:
	curl -s -X POST http://127.0.0.1:8000/api/reload || true
