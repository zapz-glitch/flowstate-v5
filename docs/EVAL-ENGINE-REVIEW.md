# Eval Engine — New Ruleset vs Old: Coverage Review

**Verdict first: the new doc is a better MATH contract, the old doc was a
better EVIDENCE contract. New alone: ~7/10. Old alone: ~8/10. Both
together: ~9/10.** The new doc tells me exactly how to adjust and cap;
the old doc told me what evidence is trustworthy, when to look deeper,
and what to do when the pool is thin. For evaluating properties I need
both halves — the sections below are what the new file dropped.

## What the new doc covers better than v1

- **Concrete adjustment schedule.** Fixed dollar/percent lines for
  bed/bath, garage, lot, foundation (4-directional incl. crawlspace),
  construction material — v1 only had directional rules for foundation
  and left the rest to "paired sales."
- **Location Index Bridging** — a measurable way to judge an out-of-block
  comp (median $/sf ratio bands) vs v1's vague "similar value" language.
- **Retrieval spec** — 35–50 comps, 1.0mi, 6–12mo: v1 never specified
  pool size or radius.
- **Output JSON contract** — preliminary vs final ARV, flags, adjustment
  matrix per comp.
- **4-way foundation schedule** incl. crawlspace — v1's FOUNDATION-001
  was 2-group directional only.

## In the OLD doc, NOT covered by the new doc

1. **Paired-sales primacy.** v1: derive adjustments from matched local
   pairs first, fixed numbers last resort. New doc is fixed-$ schedules
   only. → *Question: when a clean local pair exists, does the pair or
   the schedule win?*
2. **Transaction noise / self-sale.** v1 excluded the subject's own sale,
   investor acquisition legs, non-arm's-length prints. New doc is silent
   — an agent following it could pick the subject's own distressed print
   as a comp.
3. **Missing data doctrine.** v1: missing sale date → flag "date
   unknown", never silently drop or trust; renovated comps worth a
   lookup, distressed not. New doc silent.
4. **Verified flips.** v1: confirmed buy→renovate→resell is the strongest
   ARV-band proof. New doc silent.
5. **Recency rule.** v1: one-time 10% deduction on sales >180 days;
   better older twin beats a closer recent comp. New doc has a 6–12mo
   window but no staleness adjustment.
6. **Thin-pool protocol.** v1 §8a: `widen` (go back in time, same
   geography) and `deepen` (enrich thin comps), 2-round cap. New doc has
   no retry path — a pool with zero Tier-1 comps has no defined behavior.
7. **"One excellent renovated comp can set ARV"** + strong-Tier-2
   fallback when no renovated comp exists. New doc demands 3–5 Tier-1 —
   silent on Tier-1-empty pockets (real: San Antonio runs had 1 usable).
8. **±25% GLA weight rule.** Your earlier GLA spec halved a comp's weight
   beyond ±25% variance — this file doesn't carry it. Intentional?
9. **Twin-preference ordering** (style match, closest twin beats rule
   conformance). New doc's hard filters could exclude the best twin.
10. **Confidence, pocketScore, dealEconomics.** The harness verdict
    schema requires `conf`, `pocketScore`, `dealEconomics` — the new
    output JSON omits all three. Needed for the report + offer queue.
11. **Outlier band.** v1 had an explicit `outlier` band for bad data
    ($850/sf prints). New doc has 3 tiers, no outlier class.
12. **ARV envelope / failure mode.** What happens when nothing supports
    an ARV — low-conf verdict vs fallback engine? New doc silent (the
    30-min deterministic fallback lives in code, not the doc).

## Code-vs-doc mismatches to resolve

- Hard filters (year ±10, GLA ±250–500, lot ±2500): code applies these as
  *preferences*, not gates. Hard-gating them shrinks thin pools to zero
  in practice — recommend keeping them as selection weights, or the doc
  needs an explicit "relax when pool < 3" ladder.
- Location Index needs per-block-group median $/sf — the bundle carries
  comp BGs but medians per foreign BG need ≥3 comps there to be real.
- Retrieval spec (35–50 @ 1mi) — provider calls already return ~25–30;
  hitting 50 needs a second provider fetch (fine, widen does it).
