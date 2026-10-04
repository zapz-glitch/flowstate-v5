# Appraiser Ruleset — Set-B harness (product-engineer approved)

Source of truth for how the B harness values property. Any harness change
must trace to a rule here; rules change only with product-engineer sign-off.

## Governing principle
If a top appraiser wouldn't do it, neither does the harness. Every edge case is
solved by asking first: what would a top 0.01% appraiser do here?

## Approved rules

1. **Geography tiers** — tract first, block group second, neighborhood third;
   widen only when the closer tier has nothing trustworthy. (A same-BG comp is
   always same-tract, so inside the tract tier, BG matches rank first.)
2. **Verification** — stale or divergent sales never set value.
3. **Weighting** — sale price is 80% of the condition call, Clef 20%. Clef also
   classifies comps for the user in the dashboard.
4. **Banding** — comps without a Clef read are banded (floor/median/upper) by price.
5. **Pocket rate** — the closest-tier renovated comp carries the most weight;
   if none is trustworthy, step out one tier. Comps outside the subject's
   market area (rule 14) never carry weight.
6. **Minimum 3 sales, reconciled** — no single-comp anchoring. Reconcile at
   least 3 closed sales (3–6 typical), most weight to the best comp (closest
   tier, verified condition, least adjustment). If the closest tier has fewer
   than 3, widen the search for the rest and state why.
7. **Size integrity** — marketed vs tax sqft divergence with no permit →
   comp excluded from ARV.
8. **Tricks of the trade** — marginal $/sf size adjustment, lot/land value
   adjustment, condition adjustment, outlier ceiling (above top sale only with
   ≥2 supporters), within-tier least-adjustment weighting.
9. **Truth loop** — widen pool → deepen evidence → time-adjust stale sales;
   keep the closest verified answer.
10. **Fallback order** — ARV → median value → AVM (last resort only).
11. **Median-tier condition uplift** — market-derived first: the pocket's
    renovated-vs-median price gap. If unmeasurable, 70% of rehab cost.
    Never above the pocket's top verified sale.
12. **Size-adjusted banding** — price bands rank comps by their price adjusted
    to the subject's size, not raw $/sf (raw $/sf makes big houses look cheap).
13. **No size double-count** — when the marginal $/sf size adjustment applies,
    bed/bath adjustments are skipped; they apply only when room count differs
    at similar size (e.g. 3-bed vs 4-bed, same sqft).
14. **Market area, not just names** — a subdivision name is a hint. Two
    properties share a market area when sales values agree (pocket $/sf within
    ~15%), housing stock matches (era/style), and no physical boundary
    separates them (major road, rail, water). Near-match names (spelling,
    EXT/SUB/phase) count only if values agree; different names count if values
    + stock + contiguity agree; matching names with divergent values do not.
15. **Comp selection** — no similarity-score cutoff. Use the 3–6 most
    comparable sales (least adjustment, closest, most recent). Avoid comps whose
    gross adjustments exceed ~25% of sale price; allow one only in a thin pool,
    with the reason stated.

## Architecture principle — server computes, dashboard displays
All appraisal math (settings adjustments, tricks of the trade, every rule
above) runs on the server and is assigned per comp in the response. The
dashboard never computes valuation; comp toggles only re-combine values the
server already assigned, so API and dashboard always show the same answer.

## Open decisions
