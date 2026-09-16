# CDARV — Comp-Derived After Repair Value

CDARV is Flowstate's human-curated learning loop for comparable
selection/ranking. Saved evaluation reports are submitted for review;
humans label and approve the evidence; frozen datasets train candidate
models; an explicitly-activated model produces **shadow** comp rankings
and ARVs that never touch production underwriting.

The rules-based evaluator remains authoritative and unchanged. CDARV is
a separate package, separate database tables (`cdarv_*`), separate
processes, and a separate deploy boundary.

## Layout

```
src/cdarv/
├── reports.py              # full_response_json → IdealReport + CandidateComp
├── app.py                  # FastAPI service (uvicorn cdarv.app:app)
├── cli.py                  # python -m cdarv <command> (operator CLI)
├── api/                    # routes, schemas, deps (token auth), errors
├── domain/                 # submissions, reviews, labels, features (v2),
│                           # datasets, training, shadow, monitoring, registry
├── persistence/            # models.py (cdarv_* tables), db.py, repositories
└── worker/                 # lease-claim job runner (train, shadow-score)
alembic/                    # own migration chain — never touches v4_* or D1
```

## Data stores

- **PostgreSQL** (prod) via `CDARV_DATABASE_URL` / `DATABASE_URL` — all
  `cdarv_*` records: snapshots, review versions, comp labels,
  preferences, external comps, approvals, dataset manifests + members,
  jobs, model registry, shadow state, predictions, guidance.
- Model artifacts are stored in `cdarv_models.artifact_blob` (Postgres
  bytea) for the foundation; R2 promotion is the documented upgrade path.
- SQLite is accepted only under `CDARV_TEST_PROFILE=true` (unit tests,
  local exploration). The service and CLI refuse sqlite otherwise.

## Processes

```bash
# service (port 8005) — requires CDARV_DATABASE_URL + CDARV_INTERNAL_API_TOKEN
PYTHONPATH=src uvicorn cdarv.app:app --port 8005

# worker — lease-claims cdarv_jobs (train_dataset, train_model, shadow_score)
PYTHONPATH=src python -m cdarv.worker.main

# migrations
CDARV_DATABASE_URL=postgresql://... alembic upgrade head
```

`CDARV_INTERNAL_API_TOKEN` is a shared bearer secret between the
`apps/api` `/cdarv/*` proxy and this service — it never reaches the
browser. Shadow scoring calls back to `apps/api`
`POST /internal/cdarv/recalculate` (env `CDARV_TS_API_URL` +
`CDARV_TS_INTERNAL_SECRET`) so shadow ARV uses the real
`recalculateReport()` — CDARV never reimplements valuation math.

## Loop

1. Dashboard report → **Send to CDARV** → `POST /cdarv/submissions`
   (apps/api resolves `reportIds` or `jobIds`, fetches
   `saved_reports`, forwards the full analysis JSON).
2. Snapshot is stored immutably, keyed `(report_id, content_hash)` —
   resubmission is idempotent; changed content creates a new version.
3. Reviewer opens a review, labels each candidate comp
   (`strong_arv` / `usable_with_adjustment` / `unsuitable` /
   `not_reviewed` — unreviewed is NOT a negative), records structured
   reasons, preferences, external comps, then approves for a named scope
   (`comp_ranking`, `valuation_benchmark`) or excludes.
4. `build_dataset` freezes a manifest pinning exact snapshot+review
   versions; time-aware, report-grouped train/val/test splits; records
   feature-spec + code version and geography overlap.
5. Worker trains a CPU-only sklearn baseline; models register as
   immutable `candidate` versions with metrics + dataset identity.
6. Explicit activation sets the shadow model; `shadow_score` jobs rank
   eligible comps and compute shadow ARV via production recalc.
   `insufficient_evidence` and `error` are first-class outcomes.
7. Monitoring compares model vs reviewer and vs original evaluator.
   Agreement is diagnostic — not proof of accuracy.

## Feature contract (v2)

Model inputs exclude evaluator rule echoes (`is_enabled`, evaluator
selection, filter pass/fail counts, adjustment totals, report ordering,
`isBestMatch`), all Cotality/CoreLogic AVM fields under `subject.avm`,
and post-selection valuation outputs. Rule outputs are kept separately
in `rule_context` for diagnostics. Unknown attributes stay `NaN` with
`_known` indicators — never coerced to a match.

## Operator CLI

```bash
PYTHONPATH=src python -m cdarv --help          # requires CDARV_DATABASE_URL
PYTHONPATH=src python -m cdarv init-db         # create cdarv_* tables (dev)
PYTHONPATH=src python -m cdarv submit --d1 <d1-export.sqlite>
PYTHONPATH=src python -m cdarv queue --status needs_review
PYTHONPATH=src python -m cdarv build-dataset --name baseline --by <reviewer>
PYTHONPATH=src python -m cdarv train --dataset <dataset_id>
PYTHONPATH=src python -m cdarv worker --once   # process one queued job
PYTHONPATH=src python -m cdarv shadow activate --model <model_id> --by <user>
PYTHONPATH=src python -m cdarv shadow score --snapshot <snapshot_id>
PYTHONPATH=src python -m cdarv status          # queue/model/job counts
```

## Tests

```bash
CDARV_TEST_PROFILE=true PYTHONPATH=src .venv/bin/pytest tests -q
```

All fixtures are synthetic and live in `tests/conftest.py`; nothing in
tests can reach a real database or provider.

## Deploy

`Dockerfile` + `render.staging.yaml` entries (`flowstate-cdarv-staging`
web + `flowstate-cdarv-staging-worker` + dedicated
`flowstate-cdarv-staging-postgres`) are staged for review —
`autoDeployTrigger: "off"`. Not deployed; secrets (`CDARV_INTERNAL_API_TOKEN`,
`CDARV_TS_*`, `CDARV_API_URL` on apps/api) are still to be provisioned.
