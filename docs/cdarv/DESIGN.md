# CDARV — Comp-Derived After Repair Value

Stage-1 audit and design for the human-curated learning loop. This document
records the actual integration points found in this repository, the storage
and hosting plan, permissions posture, and the production behavior CDARV is
forbidden from changing.

## 1. What exists today (audited)

| Need | What the repo already has | Path |
|------|---------------------------|------|
| Production evaluator | TypeScript appraisal + valuation pipeline (authoritative, unchanged) | `apps/api/src/services/{appraisal,valuation,analysis,evaluation}` |
| Report store | `saved_reports` in Cloudflare D1 — `full_response_json` contains the **entire evaluated comp pool** (`comps.items`), per-comp filter/adjustment audit (`appraisalRules`), pipeline enable flags, and the final selection (`compGroup`, `asIsCompIds`, `afterRenovationCompIds`) | `apps/api/src/db/schema.ts` |
| Human feedback loop | Batch review stamps (`feedback_status = validated / improve`) + manual comp re-selection that **rewrites** `full_response_json` (so the stored report is the human-approved state) | `apps/api/src/routes/user-reports.ts` |
| Existing adjustment/aggregation logic | `recalculateReport(saved, jobId, selectedCompIds)` — eligibility + ARV = mean(adjusted $/sqft) × subject sqft; re-runs valuation from the report's `appliedSettings` snapshot | `apps/api/src/services/evaluation/recalculate.ts` |
| Renovation target | `appliedSettings.rehabLevelIndex` + `valuation.rehabLevel` (Lipstick → Full Gut) + `rehabTable` snapshot stored per report | `apps/api/src/services/valuation/types.ts` |
| Python backend | `services/eval-engine` — FastAPI + SQLAlchemy 2 + Alembic, Postgres-only durable store, bearer-credential auth (`V4_API_CREDENTIALS` sha256 records), lease-claim worker (`python -m eval_engine.worker.main`) | `services/eval-engine/` |
| PostgreSQL | `flowstate-v4-staging-postgres` (Render, PG 17) + compose.dev isolated PG | `render.staging.yaml`, `compose.dev.yaml` |
| Durable private storage | R2 `REPORT_ASSETS` bucket (report photos). Snapshot/model payloads are ≤ ~1 MB at this scale → **stored in Postgres** (JSONB/bytea) for the foundation; R2 promotion path noted below | — |
| Dashboard API surface | `apps/api` session-auth routes; dashboard fetches via `fetchApi` (`src/lib/client-api.ts`) with cookie credentials | `apps/api/src/routes/*` |

## 2. Architecture

```
EXISTING EVALUATOR (apps/api, unchanged)
        │ saved_reports (D1)
        ▼
POST /cdarv/submissions            ← apps/api route, session auth
        │ loads report rows from D1, forwards payloads
        ▼
CDARV service (services/ml, FastAPI on Render-style host)
        │ snapshots → review queue → human corrections → approvals
        │           → versioned datasets → train jobs → model registry
        │                                            │
        ▼                                            ▼
   /cdarv/* proxy (apps/api, session auth)    cdarv_jobs queue
   dashboard UI                                 worker: python -m cdarv.worker.main
                                                     │ train / shadow_score
                                                     ▼
                                          POST /internal/cdarv/recalculate
                                          (apps/api — runs production
                                           recalculateReport for shadow ARV)
```

- **Package**: `services/ml` (`cdarv` package) — separate boundary from
  `eval_engine`; shares only infrastructure conventions, never code paths.
- **Database**: existing Postgres (`DATABASE_URL`), own `cdarv_*` tables and
  own Alembic chain under `services/ml/alembic/`. No writes to `v4_*` or D1.
- **Worker**: separate process (`cdarv_jobs` claim/lease, same pattern as the
  V4 worker). Training never runs inside a web request.
- **Dashboard**: `apps/dashboard` → `apps/api` `/cdarv/*` session-auth proxy →
  CDARV service. One auth boundary; the browser never sees service tokens.
- **Failure isolation**: every CDARV call from apps/api is additive; if the
  CDARV service is down, production analysis routes never call it — the only
  coupling is the user-initiated submit/proxy surface, which fails closed.

## 3. Data model (Postgres, `cdarv_*` tables)

| Table | Purpose |
|-------|---------|
| `cdarv_snapshots` | Versioned report snapshots: verbatim `report_json`, provenance (report/job/user ids, report created_at, appliedSettings, rehabLevel+index, evaluator selection summary, code version), completeness flag. Unique `(report_id, content_hash)` — resubmission is idempotent. |
| `cdarv_reviews` | Review versions per snapshot. Status: `needs_review → approved / needs_more_evidence / excluded`. Corrections create new versions; history is immutable. |
| `cdarv_comp_labels` | Per-comp reviewer labels per review version: `strong_arv / usable_with_adjustment / unsuitable / not_reviewed` + structured `reasons[]` + note. **Unreviewed is not negative.** |
| `cdarv_preferences` | Pairwise judgments: "prefer comp B over comp A for this subject+target, because …". |
| `cdarv_external_comps` | Reviewer-added comps outside the original pool: source, transaction identity, availability date, evidence. |
| `cdarv_approvals` | Per review version: `comp_ranking_approved` and `valuation_benchmark_approved` are **separate** scopes; `gold_standard` + assigner + supporting evidence. |
| `cdarv_datasets` + `cdarv_dataset_members` | Frozen manifests: exact `(snapshot_version, review_version)` pairs, split assignment (train/val/test), feature-spec version, code version, counts, geography summary. |
| `cdarv_jobs` | Background queue (train / shadow_score): lease/claim like `v4_evaluations`. |
| `cdarv_models` | Registry: name, version, dataset_id, feature contract, metrics, artifact (bytea pickle), status (`candidate / shadow / retired`). Never overwritten. |
| `cdarv_shadow_state` | Singleton row: `active_model_id` — set only by explicit activation. |
| `cdarv_predictions` | Shadow results: snapshot, model, selected comp ids, scores, shadow ARV + recalc response, input hash, status (`scored / insufficient_evidence / error`). |
| `cdarv_guidance` | Versioned human guidance records linked to representative examples. |

## 4. Feature contract (`cdarv` feature-spec v2)

Default model inputs are **property facts only** — explicitly excluded:

- Rule echoes: `is_enabled`, per-filter pass/fail scores, adjustment
  amounts, `rank_in_report`, `isBestMatch` (kept on the example row as
  `rule_context` for comparison, never inputs by default).
- Cotality AVM: `subject.avm.*` — research-only, asserted excluded by test.
- Post-selection fields and the report's own `valuation.*`.

Included: geography (distance, same subdivision/neighborhood/street),
physical similarity (sqft/beds/baths/year/lot/stories diffs, pool/garage/
style match with `_known` indicators — unknown never defaults to match),
market (sale age vs the report's own date, price, $/sqft), and
**renovation-target features**: the report's intended rehab level index and
the comp's condition/renovation evidence vs that target (not the subject's
current distressed state). Missing inputs stay missing (NaN + `_known`),
surfaced as data gaps in monitoring.

## 5. Training and split discipline

- Only **approved** review versions contribute labels; `not_reviewed` comps
  are dropped, not treated as negatives.
- Split by snapshot (all of a subject's comps stay together); test = latest
  ~20% by report date (time-aware); train/val hash-split of the remainder.
- Manifest records exact versions + code version + feature spec; the
  dataset builder re-reads only those pinned versions.
- Metrics distinguish: agreement-with-original-evaluator (diagnostic) vs
  agreement-with-reviewer (training signal) vs outcome accuracy (later —
  no outcome evidence exists yet).

## 6. Shadow operation

- `shadow_score` job: score eligible comps (a model cannot make an
  ineligible comp eligible — eligibility = stored appraisal rule result),
  pick top-3, call `POST /internal/cdarv/recalculate` on apps/api which runs
  the real `recalculateReport` — **no duplicated financial formulas**.
- `insufficient_evidence` is a first-class result — never force a number.
- Predictions are CDARV-only rows; nothing writes back to `saved_reports`.
- No invented confidence intervals — supporting evidence and data-gap
  counts are displayed instead.

## 7. Implementation status

Implemented and verified (see §8 for verification):

- `services/ml` package: domain (submissions, reviews, labels, features v2,
  datasets, training, shadow, monitoring, registry, guidance), persistence
  (`cdarv_*` models, db, repositories), FastAPI service, worker, CLI,
  Alembic chain (`services/ml/alembic/versions/0001_cdarv_initial.py` —
  generated from ORM metadata so migration and models cannot drift).
- `apps/api`: `POST /cdarv/submissions` (resolves report ids or job ids,
  owner-scoped), transparent `/cdarv/proxy/*` (session → bearer), and
  `POST /internal/cdarv/recalculate` (shared-token auth → production
  `recalculateReport`). All fail closed when `CDARV_API_URL` is unset.
- `apps/dashboard`: `/dashboard/cdarv` — review queue, snapshot review
  form (labels + reasons + preferences + decisions), models/registry
  (activate/deactivate), performance. "Send to CDARV" on report detail.
- `Dockerfile` + `render.staging.yaml` entries (web + worker + dedicated
  `flowstate-cdarv-staging-postgres`), `autoDeployTrigger: "off"`.
- Hashed `requirements.txt` via pip-compile (`--require-hashes` install,
  same discipline as eval-engine).

Scaffolded / needs real data: outcome-accuracy monitoring (no renovated-
resale outcome data exists yet); guidance records (schema + routes exist,
no curation UI beyond storage); external-comp evidence capture (schema +
review form fields exist).

Blocked / requires product engineer:

- **Cotality/CoreLogic license**: storage, retention, and ML-training use
  of comparables data must be confirmed before real reports are approved
  for training. Schema records provider + provenance for later exclusion.
- **Secrets/deployment**: `CDARV_INTERNAL_API_TOKEN` (service + apps/api),
  `CDARV_TS_API_URL` + `CDARV_TS_INTERNAL_SECRET` (worker → apps/api
  recalc), `CDARV_API_URL` (apps/api → service) not provisioned.
- **Postgres**: staging blueprint declares `flowstate-cdarv-staging-postgres`;
  production home TBD (existing Postgres vs dedicated). Alembic must run
  wherever the DB lives — `alembic upgrade head`.
- **Worker capacity**: training is single-process CPU sklearn (small) —
  fine on the 0.5c worker; reassess if datasets grow.
- **Artifact storage**: model pickles live in `cdarv_models.artifact_blob`;
  promote to R2 if/when artifacts grow past comfortable row sizes.

## 8. Local runbook

```bash
cd services/ml
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt

# DB (sqlite allowed only for tests/local)
export CDARV_TEST_PROFILE=true
export CDARV_DATABASE_URL=sqlite:///cdarv.db
export CDARV_INTERNAL_API_TOKEN=dev-token

PYTHONPATH=src .venv/bin/alembic upgrade head   # or: python -m cdarv init-db
PYTHONPATH=src .venv/bin/uvicorn cdarv.app:app --port 8005
PYTHONPATH=src .venv/bin/python -m cdarv.worker.main   # second shell

# apps/api side: set CDARV_API_URL=http://localhost:8005 and the same
# CDARV_INTERNAL_API_TOKEN in .dev.vars; worker needs CDARV_TS_API_URL
# (the apps/api base URL) + CDARV_TS_INTERNAL_SECRET (DASHBOARD_INTERNAL_SECRET
# equivalent shared with apps/api).
```
