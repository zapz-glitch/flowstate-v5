# Evaluation playbook

What we ask the computer to do with our data, in plain words. Product
rules here were set by the product engineer on 2026-10-05. Change them only
with sign-off. Each rule names the code that enforces it and the test that
proves it.

## The goal

Given one address, estimate what the house will sell for **after** the
stated renovation (the ARV), then work back to a buy price. The standard:
would a top residential appraiser support this answer, with this evidence,
under these rules?

The valuation math is not the hard part. **The filter is.** A perfect
formula on leaked comps is a wrong number.

## The four ideas

1. **The user's evaluation settings are the ideal.** The user never loosens
   them to make a deal work. The server loosens them, in a fixed order, and
   records every step.
2. **Least leakage.** Every loosening is a leak we chose. Small steps,
   fixed order, stop at the first good comp.
3. **Rules first, then groups.** A sale must pass the rules before its price
   means anything.
4. **The server computes; the dashboard shows.** One calculator.

## Fast testing

```
npm run eval -- "2184 Dunseath Ave NW, Atlanta, GA 30318"
npm run eval -- "addr one" "addr two"
npm run eval -- --job job_123...      # re-print a finished run
```

Needs the local API (`wrangler dev` on :8790) and the local test login.
Prints a card: ARV, buy, grade, anchor, how far the ladder went, the price
classes, and the comps used. Full results save to `.data/evals/`. Target:
under 60 seconds per address. Each run spends provider calls.

Free checks, no provider calls:

```
cd apps/api && npm test          # rule proofs
npm run replay:snapshots         # frozen runs must not drift
npm run audit:snapshots
```

## Rule 1 — How the server loosens rules (the filter ladder)

Full text: `docs/FILTER-LADDER.md`.

- Only three rules move: square feet, year built, sale age.
- Each turn adds: **25% of the subject's square feet**, **3 years**,
  **30 days**. Start values come from the settings (±250, ±10, 180 days).
- Order: sale age alone first (going back in time is cheaper than giving up
  size or year), then square feet, year, sale age in turn.
- No fixed cap. The data is the stop.
- Stop at the first turn where one ARV comp passes. **One is enough.** Keep
  every comp that passes at that turn; never loosen to collect more.
- A comp that fails a rule that never loosens cannot stretch the ladder.

One ladder, two callers: the paid-enrichment search in
`apps/api/src/durable-objects/analysis-job.ts` (search "Filter ladder") and
`evaluateWithFallback` in `apps/api/src/services/appraisal/index.ts`. The
old year-first expansion ladder, the vintage year cap, the era-class match,
and the forced "nearest comps" fallback are gone. When nothing passes, the
result is `insufficient` and a labelled floor is used.

Code: `apps/api/src/services/appraisal/filter-ladder.ts`.
Proof: `apps/api/tests/filter-ladder.test.ts`, `sqft-ladder.test.ts`.

## Rule 2 — What "same area" means

- Census decides: same **tract**, then **block group**, then **neighborhood
  name**. Geography loosens last: better to go back in time than leave the
  tract.
- Provider name labels (city, zip, school district, subdivision) only rank
  a comp. They never reject one. One town can carry two labels.

Code: `evaluateGeoScopeMatch` and `NAME_SCOPE_RANK_ONLY` in
`apps/api/src/services/appraisal/evaluator.ts`.
Proof: `apps/api/tests/geo-hierarchy.test.ts`, `same-area-rule.test.ts`.

## Rule 3 — What counts as an ARV comp

Two ways, and only two:

1. **A real flip**: bought, then resold 30 to 365 days later.
2. **It passes the rules and sits in the top price group of its pocket.**

Price classes are **ARV, Median, Investor**. Condition classes are
**Renovated, Dated, Distressed**. They are different things.

- Groups come from the natural breaks in price per square foot among the
  sales that pass the rules **inside the pocket**. Never borrow sales from
  outside: that describes a market the subject does not have.
- Three or four sales are enough to see groups. Evenly spread prices show
  no pattern, so no sale is "top" just for being highest.
- **No percentage test.** Not against the subject's AVM, the comp's AVM, or
  a pocket median.
- Condition is a bonus, not a gate. Photos and listing text are not always
  there. A top-group sale that passes the rules is taken as a renovated
  product.
- Median price and Dated condition are fallbacks. Investor price and
  Distressed condition are floors.

Code: `apps/api/src/services/evaluation/price-groups.ts`,
`comp-classification.ts`.
Proof: `apps/api/tests/price-groups.test.ts`,
`comp-classification-chain.test.ts`.

## Rule 4 — Noise stays out

- A lone sale far above the pocket is an outlier, not a class, unless a
  flip or a confident Renovated read vouches for it.
- Transaction noise is **switched off** as a comp: extreme price outlier,
  package deed, bulk sale, nominal sale. It stays in the report with the
  reason.
- A sale far from its own AVM cannot drive. **A verified flip is exempt**;
  the run notes it so the gap can be watched.

Code: `stampVerification` in `apps/api/src/services/evaluation/index.ts`,
`bIsUnfit` in `packages/shared/src/appraisal/set-b.ts`.

## Rule 5 — The valuation (Set-B, "tricks of the trade")

Unchanged original. One anchor sets the value; the others bound it.

| Trick | Value |
|---|---|
| Size gap priced at a share of the comp's $/sf | 50% up to a 10% gap, 40% up to 25%, 30% beyond. A measured pool slope wins when 5+ comps allow it. |
| Land adjustment cap | ±20% of the sale |
| Adjustment cap before a comp is down-weighted | 25% |
| Outlier ceiling | above the top evidence needs 2 supporters |
| Similarity gate | 60% of the anchor's score, minimum 3.0 |
| Retail band | 70% of top $/sf |

Code: `packages/shared/src/appraisal/set-b.ts`. The original Python is
`scripts/ab-eval.py` at commit `31cdd3f`; the faithful port is `set-b.ts`
at `c0f7bcc`. `HARNESS_VERSION` bumps on every rule change.

## Rule 6 — What a checked box means

- A checked comp is **in the ARV calculation**. Fresh from the server, only
  the anchor and other drivers are checked.
- The user may check **any** priced comp, including one the server
  excluded. The server never picks a rule-failing comp on its own, but a
  person may.
- Checked comps are **averaged**, each first repriced to the subject by the
  same size and land math. Graded low confidence and labelled "operator
  selection".
- Reset restores the server's own pick.
- Last save wins. The page always saves the copy the server last sent
  back, so a save is never an older version of the report.

Code: `apps/api/src/services/evaluation/recalculate.ts`, the PUT handler in
`apps/api/src/routes/user-reports.ts`, `isCheckedForArv` in
`apps/dashboard/src/hooks/use-analysis-evaluation.ts`.
Proof: `apps/api/tests/recalculate-no-stale-arv.test.ts`.

## Reading a result

| Grade | Meaning |
|---|---|
| verified | 3+ drivers with clean evidence |
| weak | thin, stretched, or soft evidence. Still an answer. |
| floor | no comp evidence; a labelled fallback |
| withheld | no defensible answer |

"All driver comps are smaller than the subject" means the size trick did
the work. It is a caution, not a fault.

## Known gaps (not built yet)

- The ladder stops at the first top-group comp and can miss a verified flip
  sitting one or two turns further out.
- Price per square foot favors small houses. Rules-first grouping limits
  this; it does not remove it.
- When the area widens past the tract, the radius rule is dropped and
  membership decides: a shared neighborhood name, or a value-equivalent
  pocket. The pocket reference there is the subject's own (AVM per square
  foot or scope medians), not one built from same-tract comps.
- With no cap on sale age, a very old sale can pass the rules. It is still
  stamped stale and cannot drive the value.
- Foundation families (slab/block/concrete together; wood/pier/crawl
  together) and "materials rank only" have not been re-checked against the
  code.
- The server's own answer is one anchor. Averaging applies only to boxes
  the user checks.
- No frozen fixtures yet for the new ladder; replay re-scores saved comps
  and does not exercise the search.

## Addresses run so far (2026-10-05)

| Address | ARV | Anchor | Ladder | Time |
|---|---|---|---|---|
| 2184 Dunseath Ave NW, Atlanta, GA 30318 | $455,173 | 1935 Sumter St NW, $400,000 | turn 4, tract | 23s |
| 3709 Charlotte Dr, Rex, GA 30273 | $252,975 | 5857 Mistyview Dr, $242,300 | turn 3, tract | 55s |

Both graded weak for size. Neither is checked against a known right answer.

## To do — after address fine-tuning (not started)

Asked for by the product engineer on 2026-10-05. Do these only after the
address tuning pass is finished.

1. **"Tear down" means full gut.** When a listing description says tear
   down (Clef condition read), classify the condition as needing a full gut
   renovation, and set the rehab level to Full Gut.
2. **Assess lot value alongside ARV.** Estimate the lot's value for the
   subject and show it in the subject property box. Keep it separate from
   the ARV: lot value is its own number, not an input that changes the ARV
   unless a rule is approved for that.
