# Evaluation system spec — the machinery around the harness

Status: proposed, for product-engineer review. No code yet.

This spec covers the layers AROUND the rules. The rules themselves
(`docs/APPRAISER-RULESET.md`, `docs/APPRAISAL_HARNESS.md`, the keep/drop
audit) are not re-opened here — the audit owns them.

```
Facts ──→ Harness ──→ Trace ──→ Compliance ──→ Result ──→ Feedback
                                                        │
         Change control ── reruns the full address set ──┘
```

The product loop this serves: run an address → the evidence is frozen →
the answer replays offline forever → a rule change shows what moved on
every recorded address → findings get fixed in batches, not per-address.

---

## Layer 1 — Facts

**Requirement:** the exact evidence the answer used is frozen and
replayable — subject, comps with their stamps, options, valuation date.
No frozen facts, no compliance, no change control.

**Exists today:**
- `set-b-snapshot.ts` — one record per run, inputs frozen per `evaluateB`
  call, `served` block (what was priced on, not just what Set-B said),
  manifest (harness version = content hash of rules + input door),
  SHA-256.
- Store: DO → R2 (`evaluations/{jobId}/{sha}.json`) → `analysis_runs`
  row pointer. Saved before the answer is used. A record that never
  reached R2 is never dropped.
- Read: `GET /v1/analyze/jobs/:jobId/snapshot`.

**Gaps:**
- The snapshot freezes what the *rules* saw — not what the *pipeline*
  did upstream (which comps got fetched, why a candidate was dropped
  before enrichment, the wave budget). F22 (recalc can't reproduce a
  rung 4–5 answer) lives here. Decide: is a comp-pool record part of
  Facts, or is pool construction itself harness (goes in the snapshot
  inputs)? Recommended: the pool record belongs to Facts — it IS the
  evidence set.
- Enrichment waves (approved decision): rank on free data → enrich top 6
  → stop at 3–6 good → next 6, ceiling 25. Not built. When built, the
  wave log becomes part of the record — which calls were spent, on whom.

**Not a requirement:** freezing provider payloads beyond what the rules
read. The snapshot deliberately excludes address/names/extra provider
fields — keep it that way. If the dashboard needs display data, that's
the report, not the snapshot.

## Layer 2 — Harness

**Requirement:** one evaluator, the approved rules, the same answer for
the same inputs on any surface.

**Exists today:** `evaluateB` (ship-time Set-B restored), the verify
ladder (widen → deepen; devalue/stale rungs dropped in the audit),
input door (`set-b-input.ts`), manifest stamping.

**Gaps:** the audit's keep/drop list is decided but not all landed —
that's harness work, tracked there, not here.

**Not a requirement:** a second evaluator, a browser-side copy of the
rules, a Python engine. All three already killed by decision.

## Layer 3 — Trace

**Requirement:** every decision and every dollar in the record names the
rule that produced it. Compliance can't audit what it can't point to.

**Exists today:** free-text flags per decision (land adj, verification
stamps, drops, reconcile weights) — the content is there, the IDs aren't.

**Needed — and no more:** a stable rule ID per flag emission point.
`land_adj`, `verify_divergent`, `driver_drop_similarity`, etc. — drawn
from the ruleset's own names so a flag reads as `rule + evidence`, not
prose. No new trace format, no spans, no telemetry system. The flag list
with IDs IS the trace.

**Cut:** a separate decision-log subsystem. The snapshot + flagged calls
already answer "what did the rules do"; don't build a second ledger.

## Layer 4 — Compliance

**Requirement:** prove each evaluation follows the rules — and catch when
a code change moves an answer.

**Exists today:**
- `npm run replay` / `replay:all` — snapshot → re-run on today's rules →
  exact / MISMATCH / DRIFT / INVALID; scoreboard written to
  `.data/replay-scoreboard/`.
- Known-defect tests pin today's wrong behavior and fail when it's fixed.

**Gap:** the *auditor* — nothing reads a record and checks conformance
against the approved ruleset ("did this run follow rule 4?"). Replay only
says "same / moved". An auditor says "this answer violated the pocket
rule." — **defer it.** While the keep/drop list is still landing, an
auditor would be re-written weekly. Build it when the ruleset settles:
it reads snapshots + rule IDs and emits violations, offline.

## Layer 5 — Result

**Requirement:** the answer carries two honest grades.

- **Evidence grade** — how strong was the evidence behind the number.
  Mostly exists: conf high/medium/low + thin/single-comp/unverified
  flags. Needed: roll them into one label the consumer can't miss
  (the F16 fix — `valuation.confidence` must not say "high" when
  mechanics say "low").
- **Process grade** — did the run obey the machinery: every rules call
  recorded, snapshot stored (has `sha256`), manifest stamped. Binary —
  pass or a named hole. Nearly free: the snapshot store already detects
  holes (INVALID).

**Cut:** don't invent a scoring rubric with letters/points. Two labels:
`evidence: verified|weak|floor` and `process: complete|incomplete`.

## Layer 6 — Feedback

**Requirement:** compare predictions to real outcomes later — the only
thing that grades the *rules* (vs the process).

**Exists today:** `saved_reports.feedback_*` fields, CDARV export route
(shadow-only, gated).

**Needed — and no more:** a capture point. When a subject later sells,
or a comp resales, record `predicted ARV vs actual sale` per run. A
table + a way to mark the outcome — that is all. An accuracy scoreboard
over the snapshot folder comes later, when there is outcome data.

**Cut:** do not build outcome ingestion, model drift dashboards, or
learning loops now. CDARV stays shadow — existing boundary.

## Layer 7 — Change control

**Requirement:** no rule change lands without re-running the full
recorded address set, and the diff-in-answers is what gets reviewed.

**Exists today:** the documented loop — edit rule → re-stamp manifest →
`replay:all` → DRIFT lines are the review artifact → approve → rebuild
fixtures, flip known-defect cases.

**Gaps:**
- **The gate isn't enforced.** `main` deploys without the scoreboard.
  Minimum: `npm run replay:all -- --strict` as a required pre-merge
  check (CI step or repo script — not a new subsystem).
- **The address set must grow.** Every live run should mint a snapshot
  candidate — a script that pulls the job's snapshot into
  `fixtures/snapshots/` is the whole mechanism. That keeps the set
  "full" by construction instead of by hand.

**Cut:** formal release windows, approval UIs, a change-request table.
Review = the scoreboard diff, recorded in the findings log.

---

## Test pyramid — what each tier is for

| Tier | Answers | Cost | Status |
|---|---|---|---|
| Unit (`set-b-rules.test.ts` etc.) | does this ONE rule fire — and *where* it failed | instant, free | exists — extend per rule as keep/drop lands (F23) |
| Replay (`replay`, `replay:all`) | does a frozen pool still give the recorded answer; what moved on a rule change | seconds, free | exists — snapshot folder grows from live runs |
| E2E (`/v1/analyze` live) | does the whole pipeline run on a real address, providers included | minutes, provider $ | manual — used to mint snapshots and validate wave/pool changes |

The hierarchy: E2E tells you *that* it failed; replay tells you *which
run's evidence* broke it; unit tells you *which rule*. Unit tests were
"no" in AGENTS.md — that rule predates this system. A unit test on a
hand-made comp pool is the cheapest way to pin a rule; it stays.

## The loop, at speed

```
live run (minutes, $)  ── mints a snapshot (facts) ──→ fixture candidate
        │                                                │
rule edit ─→ re-stamp ─→ replay:all (seconds, free) ─→ scoreboard diff
        │                                                │
   findings log ◄── review (the only approval step) ◄─────┘
        │
   hardening batch (keep/drop audit) — never per-address
```

The expensive step (live run) happens once per address; everything else
is offline. Iterating on rules never needs another provider call.

## What this spec deletes

- A compliance auditor service — deferred until the ruleset settles
- A heavyweight grading rubric — two labels suffice
- Feedback infrastructure beyond a capture point — no data yet
- Browser-side rules, second engines, parallel evaluators — already killed
- A trace/logging subsystem — flags + rule IDs are the trace
- Per-address patches — findings batch via the audit, enforced by the
  scoreboard gate

## Product-engineer decisions (2026-10-04)

1. **Pool construction is part of the record.** The snapshot covers what
   the rules ran on *and* the evidence set they were handed.
2. **`replay:all --strict` is the pre-merge gate on `main`.** Approved —
   it is the change-control layer made real.
3. **Evidence grade uses verification labels** — `verified / weak /
   floor`, driven by the price-verification stamps (corroborated = high,
   plausible = weak, unverified/divergent = floor).
4. **Outcomes are verified by hand.** The product engineer marks the real
   result in the report — no provider re-check schedule.
