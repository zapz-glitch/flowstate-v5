# Flowstate Evaluation V4 Python service

This scaffold will provide the deterministic V4 evaluation engine and durable
job API. Python is the authoritative V4 financial calculator. The existing
TypeScript application remains the authenticated product shell and integrates
through the versioned HTTP contract in
`docs/eval-v4/TS_PYTHON_CONTRACT.md`.

## Local development

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
V4_TEST_PROFILE=true uvicorn eval_engine.main:app --port 8004 --reload --app-dir src
```

Run tests from this directory:

```bash
PYTHONPATH=src python -m pytest tests -q
```

The current executable surface is health/readiness plus a test-profile-only
synchronous stub. Candidate runs use isolated storage and keep external
provider calls disabled unless a bounded test explicitly enables them.
