.PHONY: index api web playground test

index:
	.venv/bin/python -m playground.pipeline.build_index

api:
	.venv/bin/uvicorn playground.api.main:app --reload --host 127.0.0.1 --port 8000

web:
	cd playground/web && npm run dev

test:
	.venv/bin/pytest tests/ -q
