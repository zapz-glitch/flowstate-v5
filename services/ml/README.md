# CDARV — Comparables-Driven ARV machine-learning foundation

CDARV learns which comparables belong in an ideal report. It consumes
human-approved ("ideal") reports from the production report database,
extracts labeled comp-selection examples, trains a model, and emits
**shadow predictions** — comp selections and ARV estimates scored by the
model, stored separately, never written back to production underwriting.

## Boundary

- CDARV is its own Python package. It shares no code, database, or deploy
  unit with `services/eval-engine` (which only ever *produces* evaluation
  data) or `apps/api` (which only ever *produces* reports).
- Input: reports stamped `feedback_status = 'validated'` via the
  batch-review loop — the report JSON already contains the entire evaluated
  comp pool (`comps.items`), per-comp filter results and adjustments, and
  the reviewer-approved selection (`compGroup`, `afterRenovationCompIds`,
  `asIsCompIds`). Post-selection fields are labels, never features.
- Output: `shadow_predictions` rows keyed by model version inside CDARV's
  own SQLite store. Nothing here can mutate a production report.

## Layout

```
src/cdarv/
├── reports.py    # full_response_json → IdealReport + CandidateComp (labels)
├── features.py   # per-comp feature vector (61 features, leak-free contract)
├── store.py      # SQLite: ideal_reports, comp_examples, model_versions,
│                 #          shadow_predictions
├── ingest.py     # SqliteReportSource (D1 file) + HttpReportSource (prod API)
├── model.py      # baseline logistic ranker, artifact versioning
├── metrics.py    # per-report top-k precision/recall, grouped split
├── shadow.py     # shadow selection + shadow ARV vs actual
└── cli.py        # python -m cdarv <command>
```

## Setup

```bash
cd services/ml
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

Run everything from this directory with `PYTHONPATH=src` (same convention
as eval-engine):

```bash
PYTHONPATH=src .venv/bin/python -m cdarv --help
PYTHONPATH=src .venv/bin/python -m pytest tests -q
```

## Workflow

```bash
# 1. Point at a D1 SQLite file (local wrangler DB or `wrangler d1 export`)
python -m cdarv ingest --db cdarv.db --source sqlite --d1 /path/to/d1.sqlite

# …or pull from the production API (needs an fs_ API key)
python -m cdarv ingest --db cdarv.db --source api \
  --api-url https://api.flowstate.homes --api-key fs_...

# 2. Train the baseline comp-selection model
python -m cdarv train --db cdarv.db --target arv --name baseline

# 3. Score shadow selections over every stored report
python -m cdarv shadow --db cdarv.db --model latest

# Inspect state / export examples for offline experiments
python -m cdarv status --db cdarv.db
python -m cdarv dataset --db cdarv.db --out examples.jsonl
```

Ingestion is idempotent: reports are keyed by content hash, so re-running
`ingest` only picks up new or re-stamped reports.

## Prod export endpoint

`GET /v1/ml/ideal-reports?limit=25&cursor=<cursor>` on `apps/api` —
standard `Bearer fs_...` auth, scoped to the key owner's reports,
cursor-paginated (`limit` ≤ 50). Each item carries the full stored
analysis JSON plus the feedback stamp.

## Model

Baseline: pointwise logistic regression (`sklearn` Pipeline:
median-impute → scale → LogisticRegression, class-balanced) scoring
P(comp ∈ ideal selection). Reports are split as groups — a report's comps
never straddle train/val. Metrics: log-loss, ROC-AUC, and per-report
top-k precision/recall/exact-match against the reviewer-approved
selection. Artifacts are pickled `{model, feature_names, target,
dataset_hash}` dicts registered in `model_versions`.
