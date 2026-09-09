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

The durable API uses isolated storage. Keep external provider calls disabled
unless a bounded test explicitly enables them.

## Local application evidence bridge

`eval_engine.local_bridge:app` runs the existing deterministic `evaluate_v4`
pipeline without PostgreSQL or provider calls. The authenticated TypeScript
application supplies provider evidence and translates the result for the
existing dashboard. This is a local candidate path, not a production worker
or durable-job replacement.

Set `V4_LOCAL_BRIDGE_ENABLED=true` and a separate random
`V4_LOCAL_BRIDGE_TOKEN` of at least 32 characters through an ignored secret
file or process environment. Do not put the token in browser configuration.
From this directory, launch with the environment already loaded:

```bash
uvicorn eval_engine.local_bridge:app --host 127.0.0.1 --port 8788 --app-dir src
```

`GET /health` identifies the `python-v4` engine. `POST /evaluate` requires
`Authorization: Bearer <token>` and an `EvaluationRequestV4` JSON body.
Supply decimal quantities as strings, an explicit evaluation date, a settings
snapshot ID, and all four canonical V4 renovation tiers. The endpoint returns
`{ "engine": "python-v4", "result": <EvaluationResultV4> }`.

Only actual sale evidence belongs in `verified_sale_price`, `is_sale`, and
`evidence_ref`. Do not infer a verified sale price from price per square foot.
Missing evidence stays missing; insufficient comparable evidence returns an
incomplete valuation, never an old-engine fallback. The existing domain
preserves the investor cohort's engineering-proposal label and the unmapped
initial offer's incomplete status.

User-directed rule update, 2026-09-08: one qualifying verified comparable is
enough to calculate a local V4 valuation. One or two qualifying comparables
produce `REVIEW_REQUIRED` with preliminary ARV, renovation, and deal results
and a limited-evidence warning. Zero qualifying comparables still produces
`INSUFFICIENT_COMPS`. No appraisal filter is relaxed to reach a count.
Selection retains the existing order: highest verified sale price first,
then newest sale date and stable identifiers, accepting up to three matches.
This rule does not introduce geographic-nearest or similarity-score ranking.

The local adapter requires `building_style_match`, using the subject and
comparable `building_style` evidence fields. Matching ignores case and
whitespace only. Ranch and Conventional remain different styles. Missing or
placeholder styles are rejected, including when both records say unknown.
One matching verified comp can produce a preliminary valuation; no matching
style evidence means no valuation. The local adapter must keep this filter
enabled when applying settings overrides.

The bridge accepts localhost Host headers only, has no browser CORS access,
and limits requests to 2 MB and 500 comparables. Bind it to loopback as shown;
do not expose it through the production tunnel or proxy.
