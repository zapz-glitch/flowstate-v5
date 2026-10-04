# The official harness — what shipped and won the A/B test

The A/B winner is **Set-B** — the trade-tricks methodology, ported from
`scripts/ab-eval.py`. It lives in
`packages/shared/src/appraisal/set-b.ts` (ship-time = commit `c0f7bcc`,
restored 2026-10-04). One pure function: `evaluateB(subject, comps, opts)`
→ one answer. ~570 lines. Everything below is what it actually does.

## The pipeline order

```
grid filters (upstream) → enabled comp pool
    ↓
pool rates (land + size, measured from the pool itself)
    ↓
contributions — each comp repriced to the subject
    ↓
verification — stale/divergent sales dropped
    ↓
tier discipline — renovated → median → weak → retail band
    ↓
anchoring — most-similar comp sets ARV; others bound, never blend
    ↓
self-heal → condition uplift → outlier ceiling → confidence
    ↓
cascade: T0 anchor → T1 rescue → T2 pocket → T3 AVM → T4 assessed → T5 report-only
```

The pipeline wraps it in a verify-and-retry ladder: **widen** (more
comps) → **deepen** (more evidence on the comps it has). If the answer
still isn't verified, it falls to the labeled floor — never a made-up
number.

## The rules, in plain words

1. **The grid first.** Upstream appraisal rules decide which comps are
   even usable — distance, size, lot, property type. Set-B only sees the
   enabled pool.

2. **Rates are measured, not assumed.** The pool itself yields a
   per-square-foot size rate (a slope fit over ≥5 comps, tract first)
   and a land rate (vacant-land sales → assessed-value curve → per-parcel
   fallback). If neither can be measured, a tapered guess (50/40/30% of
   $/sf) prices the size gap.

3. **Every comp is repriced to the subject.** A comp's contribution =
   its sale price + the size gap at the marginal rate + a land
   adjustment (capped at ±20% of its sale, ignored under $1,000).
   A comp needing >25% total adjustment still counts — at half weight.

4. **Verification gates who may drive.** A sale stamped *stale* or
   *divergent* (its price can't be squared with its own AVM) can sit in
   the pool but can never set the value.

5. **Classify first, then pick.** Every usable comp lands in one of
   three evidence classes — *renovated anchors, medians, as-is*. The
   pick happens inside a class: renovated-labeled comps drive first
   (similarity ≥ 3), then medians, then the **retail band** (within
   70% of the pool's top $/sf). Only as-is left → **ARV is withheld** —
   floor evidence can't price a renovation.

6. **Geo order never changes: tract → block → neighborhood.** On the
   first pass and every retry, the class pick looks for tract matches
   first, then block-group matches, then neighborhood matches — for
   renovated anchors, medians, and as-is alike. Rural pockets get the
   pocket-equivalence rule (decisions, `HARNESS_FINDINGS_LOG.md`).

7. **One anchor sets the value.** Inside the picked class, the
   most-similar driver is the anchor; ARV = its repriced contribution.
   The rest bound the range — never blended. Drivers under 60% of the
   anchor's similarity score get dropped.

8. **Self-heal.** If the anchor is the *floor* of its own driver set,
   it was the worst comp — the answer re-anchors to the median driver.

9. **Condition uplift is earned, not automatic.** Only when every
   driver is median-tier: measured market gap between renovated and
   median sales (needs ≥2 premium comps), else **rehab cost × 80%** —
   the appraiser never credits renovation dollar-for-dollar.

10. **Outlier ceiling.** ARV above the top verified contribution needs
   ≥2 drivers supporting it — otherwise it's capped. One comp can't
   push the answer past all the other evidence.

11. **Bracket + confidence.** All-smaller or all-bigger driver sets are
    flagged (no size bracket = weaker evidence). Confidence: low if
    bracketed or capped; high needs ≥3 drivers and a clean run.

## The calibrated constants ("tricks of the trade")

| Knob | Value |
|---|---|
| Adjustment cap before downweight | 25% |
| Outlier supporters needed | 2 |
| Land factor / land cap | 0.35 / ±20% |
| Retail band | 70% of top $/sf |
| Similarity gate / minimum | 60% of anchor / 3.0 |
| Clef confidence floor | 30 |
| Rehab fractions | Gut 95% · Heavy 85% · Full Cosmetic 75% · Light 45% · Lipstick 30% |

## What it is NOT — the guardrails that came later (and went)

After Georgia, layers got added for every bad case: price terciles
deciding tiers, a weighted 3-sale reconcile replacing the anchor,
devalue/time-adjust rungs, softened lot rules, land-extraction "land
play" outputs. The audit measured them on 48 saved pools — **each
layer moved answers away from real comp prices** (in-band: 16→13→11;
extreme: 9→16→15). Fourteen were dropped; nineteen survived review.
Full accounting: `docs/HARNESS_KEEP_DROP_AUDIT.md`.

## Its real defects (known, and OG's own)

Being the winner doesn't make it clean. The audit flags:

- The "renovated" comp tier is picked by price with no ceiling — a
  $1.6M outlier still reads as "premium"
- Most answers rest on one comp yet get called "verified" (32 of 42)
- "Stale" is a price test, not a date test — a recent cheap sale counts
  as stale
- Confidence says "low" on 43 of 48 runs — the label carries no info
- The market-measured uplift is dead code; only cost×80% ever ran
- Subdivision matching is exact-string — spelling variants miss

Those get fixed on top, one approved change at a time — with the
snapshot scoreboard catching what each one moves.
