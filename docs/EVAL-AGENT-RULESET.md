# Evaluation Agent Ruleset (v1)

Source of truth for the Evaluation Agent, written in natural language. The
agent's job is to find the comparable sales that are the closest possible
match to the subject property — the twins, the spitting image — and to
reason about them the way an appraiser would. Every rule below is a
preference toward that twin. When the perfect spec does not exist, the
agent selects the evidence with the fewest and least important differences
rather than stretching, inflating, or inventing data. That judgment —
picking what is closest to this source of truth — is exactly what the
harness is for.

Operating mode: the agent calls the deployed Flowstate API for all property
data, enrichment, calculations, CLEF, permits and photos, then reasons over
the outputs using this document. It never modifies production evaluation
code.

## 1. The goal

Produce the After Repair Value (ARV): what the subject property will sell
for once renovated to the standard shown by the renovated comps. Along the
way, keep the evidence bands clean so the trends stay visible — what
investors pay for ugly or investment-grade stock, what lived-in
move-in-ready stock sells for, and what clearly renovated stock sells for.

## 2. The pipeline this rides on

When a property is searched in Property Search or queued via the API, the
production stack does the deterministic work — the agent supplies the
judgment:

- Subject details come from the ATTOM MCP provider.
- Comparables are pulled relative to the subject, then a geocode request
  returns the block-group GEOID. Sales matching the subject's block group
  are enriched first, neighborhood matches second, tract matches only as
  the fallback tier.
- Comp selection and the deduction adjustments (square footage,
  bed/bath) are the harness's responsibility — historically deterministic
  code under the appraisal rules, now guided by this ruleset.
- In parallel, the subject's condition is classified: Clef reads up to 4
  curb-appeal photos, and GPT-6 Luna vision reads all the photos and picks
  the renovation level. Listing descriptions and photos supply condition
  evidence for both subject and comps — but price is the strongest
  evidence, because it is the outcome of what buyers actually paid.
- Permits are pulled for the subject: permits outside the threshold go
  into the renovation budget; no permits means assume no real work was
  done — nothing is added.
- The server renders the evaluation: ARV (price per square foot averaged
  across the selected comps when several qualify), renovation
  budget/level, the pre-approved profit margin, the wholesale fee, the
  subject's own AVM from the data provider, and the valuation formula
  math.
- The client mirrors the server's selection — only comps selected
  server-side appear selected client-side. Client edits (comp reselect,
  evaluation settings, renovation line-item costs) recompute locally;
  whether those recomputes also render server-side is an implementation
  choice.

## 3. Geography and location — where comps come from

- **Block group is the strongest geographic unit.** It is the smallest
  atomic statistical geography defined by the U.S. Census Bureau, carries a
  unique 12-character GEOID, and is bounded by streets and physical
  features — which is what makes its comps the highest-likelihood matches
  for physical similarity and value parity.
- **Neighborhood** is a localized, often informal community area with no
  official standardized federal geocode. It is still effectively required:
  it carries the similar values and proximity we need, so prefer comps
  inside the subject's neighborhood whenever they exist.
- **Census tract is a fallback tier, never a lead.** It is too large for
  primary selection — it skews away from the closest properties in
  proximity and value parity — but tract-matched comps may still be
  enriched and used when block-group and neighborhood tiers produce
  nothing. Enrichment follows the same order: block group first,
  neighborhood second, tract last.
- **Major roads and physical barriers are a major negative.** A
  near-perfect twin sitting across a highway, major road, railroad, or
  other clear neighborhood divider loses to a same-side twin and needs a
  location adjustment — but the physical match can still outweigh the
  barrier when that comp is the best evidence available.

## 4. The twin spec — what the ideal comp looks like

Selection preferences, roughly in order of importance:

- **Style match.** Same property style as the subject. A renovated ranch
  comp beats a higher-priced renovated two-story when the subject is a
  ranch — closer twins win even at a lower sale price.
- **Living area: ±250–500 sqft preferred range** for selection (overrides
  the earlier ±250). Beyond it, the comp can still be used — with the full
  square-footage adjustment from Section 7. A comp whose GLA varies more
  than ±25% from the subject loses half its selection weight.
- **Year built: ±10 years preferred** — construction technology improves
  every decade. If ±10 fails, widen to ±12, then ±14, and keep stepping out
  2–3 years per iteration until the closest spec is found. Pre-1970 stock
  can stand as its own era group. All else equal, the closer year-built
  match wins.
- **Lot size: ±2,500 sqft preferred.** For rural subjects or large
  parcels, drop the fixed range entirely and match on similar acreage and
  land use with judgment instead.
- **Pool:** if the subject has a pool, prefer comps with pools. If the best
  renovated twins lack one, use them anyway and adjust for the cost of a
  pool in that submarket — do not keep searching past good twins for a
  pool comp.
- **Construction and foundation material:** match where possible —
  concrete to concrete, wood to wood. See FOUNDATION-001 in Section 7 for
  the directional value rule.
- **Bed/bath count:** preferred to match, but differences are adjustable
  for the value beds and baths add in that submarket or pocket. Not a hard
  gate.
- **Missing data:** if a comp is otherwise an excellent twin but a field is
  missing — foundation, construction material, lot size — keep the comp
  and treat that field as unknown. Never assume it matches, never drop the
  comp for the gap alone. Weigh it accordingly.

## 5. The evidence bands

Human reviewers group comps psychologically into bands. The agent must do
the same and protect them — dirty bands let the agent hallucinate.

- **AS-IS band** — distressed, investment-grade stock; what investors pay
  for ugly houses.
- **MEDIAN band** — lived-in, move-in-ready stock: updated or maintained,
  with no significant renovation investment.
- **ARV band** — clearly renovated stock with forced appreciation from
  value-add renovation and construction.
- **Outliers** — lot sales, intra-family transfers, package or
  multiple-property transactions, or any unexplained price sitting well
  above the renovated band. An unexplained high-price comp is an outlier:
  exclude it from the ARV calculation.

**Price is king; condition is evidence in the investigation.** When price
suggests ARV but condition suggests MEDIAN, the price position carries the
weight. A distressed property that sold near MEDIAN or ARV prices does not
stay in the AS-IS band — its price places it.

## 5a. Stating your bands — the verifier contract

The harness independently computes the same three bands from the comp
evidence and grades the verdict against them. Alongside `bands` (your
per-comp assignment), every selection must state band edges:

```jsonc
"bandEdges": {
  "as_is":  { "low": 110000, "high": 145000, "mid": 130000, "compIds": ["…"] },
  "median": { "low": 160000, "high": 195000, "mid": 178000, "compIds": ["…"] },
  "arv":    { "low": 240000, "high": 285000, "mid": 265000, "compIds": ["…"] }
}
```

- Each band's `low`/`high`/`mid` are its scaled-price edges and median —
  scale each member's price to the subject's living area the way §7
  bracket math does, then take min/max/median.
- `compIds` lists that band's members. Every comp belongs to exactly one
  primary band — no dual membership, and an AS-IS-classified comp never
  appears in the ARV band.
- Self-check before submitting: `low ≤ mid ≤ high` inside each band.
- A band the evidence cannot support (fewer than two real members) is
  simply omitted — `INSUFFICIENT_DATA`, not an error. Never fabricate a
  band to look complete.
- The bundle's `evidenceBands` field shows the harness's own edges. They
  are advisory: state what the evidence argues, then defend it — the
  grade records agreement, it never overturns your verdict.

## 6. Sale recency

- Prefer sales within 180 days. The more recent the sale, the steadier the
  price-per-square-foot assumption, because less market fluctuation has
  accumulated against it.
- Any sale older than 180 days takes a **one-time 10% deduction** — the
  market has been dipping. The deduction does not scale with age: an
  8-month-old comp and an 11-month-old comp get the same single
  adjustment.
- Recency does not beat a better twin: an excellent twin that sold 8
  months ago is preferred over a somewhat worse 60-day match, with the
  10% time adjustment applied.

## 7. Adjustments — market-derived first

Fixed dollar adjustments are a last resort. Wherever local evidence
exists, derive the adjustment from the market using **paired sales**:

1. Find two recently sold homes in the same neighborhood that are nearly
   identical in size, age and condition.
2. Isolate the tested feature — for example 3-bed vs 4-bed, or pool vs no
   pool — as the only major difference between the pair.
3. Subtract the sale prices. The leftover dollar amount is the
   market-derived adjustment.
4. Verify with one or two more pairs to confirm the number is consistent.

This applies to bedroom and bathroom differences, to pool value (the cost
of a pool in that submarket), and to the per-square-foot rate.

**Square footage** is adjusted linearly from the very first square foot of
difference — appraisers do not use threshold brackets, because market
buyers do not discount the first 250–500 sqft as free space. Every square
foot carries structural, material and utility cost. The full GLA spec:

**Step 1 — bracketed selection.** Select 3–5 renovated comps from the
subject's subdivision / neighborhood / block group (0.5-mile max radius),
sold within the last 6 months, prioritizing a *bracketed* set:

- At least 1 comp smaller than the subject's GLA.
- At least 1 comp larger than the subject's GLA.
- If a comp's GLA variance exceeds ±25% of the subject, reduce that
  comp's weight by 50%.

**Step 2 — the marginal GLA rate.** The marginal value of extra square
footage is 40% of the blended renovated $/sqft:

```
Avg_Comp_$/sqft   = sum(selected comp sale prices) / sum(selected comp GLAs)
Marginal_GLA_Rate = Avg_Comp_$/sqft × 0.40
```

Adjust each comp linearly across the full difference:

```
GLA_Delta            = Subject_GLA − Comp_GLA
Adjusted_Comp_Price  = Comp_Sale_Price + (GLA_Delta × Marginal_GLA_Rate)
```

Direction: add when the comp is smaller, subtract when it is larger.
Preliminary ARV is the weighted average of the adjusted comp prices.

**Step 3 — ceiling and floor guardrails.**

- **Ceiling (prevent over-improvement):** find the subdivision's highest
  *renovated* sale (`Max_Renovated_Price`). If the preliminary ARV
  exceeds it, cap: `Final_ARV = Max_Renovated_Price` and set flag
  `CEILING_CAP_APPLIED` — a renovated valuation may never claim a value
  higher than the best renovated sale that exists. Regression is real: a
  buyer willing to spend record money leaves the pocket for a
  neighborhood where that price is the average, not the maximum.
- **Floor (prevent undervaluation):**
  `ARV_Floor = max(Min_Renovated_Price × 0.90, Max_Distressed_Price × 1.15)`.
  If the preliminary ARV falls below it, raise to the floor and set flag
  `FLOOR_GUARDRAIL_APPLIED`.

Before declaring the ceiling real, expand the search — go further back
(12–24 months) in the immediate pocket and, only if the block group is
truly empty, to competing similar-value block groups — to look for a
renovated sale at the subject's scale. This is what `widen` is for
(Section 8a).

**Step 4 — output.** The verdict reports the preliminary ARV, the final
ARV after guardrails, the applied flags (`NONE`, `CEILING_CAP_APPLIED`,
`FLOOR_GUARDRAIL_APPLIED`, `WIDE_GLA_BRACKET` — the last when no larger
comp exists to bracket the subject), and an itemized adjustment matrix:
per comp, base price, GLA delta, marginal adjustment, final adjusted
price.

**FOUNDATION-001 — directional:** concrete and concrete-block foundations
are equivalent. Wood, pier-and-beam and crawlspace are a separate group.
Concrete and block are stronger long term and depreciate less, so crossing
the groups adjusts only one way:

- Subject is the wood group, comp is concrete/block → deduct 10% from the
  comp's price. Devaluing the stronger comp mirrors the wood-frame
  depreciation the market already prices in.
- Subject is concrete/block, comp is the wood group → leave the comp
  alone. No upward adjustment is taken.
- Comps inside the subject's own foundation group are left alone — no
  adjustment either direction.

## 8. Evidence quality rules

- **Missing sale dates:** a comp with no sale date is flagged "date
  unknown" — never silently dropped, never silently trusted. If it is a
  distressed fixer or otherwise low-value to the evaluation's accuracy,
  leave it out. If it could matter — above all a *renovated* comp that
  might anchor the ARV band — it is worth a sale-date lookup to rescue
  it.

- **Verified flips:** a confirmed investor purchase resold after
  renovation within a 30–365 day hold at a profit is very strong proof the
  comp belongs in the ARV band — provided the property itself is a close
  twin of the subject. Confidence rises further when CLEF, photos or the
  property description verify the renovated condition.
- **One excellent ARV comp can set ARV** when no other close ARV comp
  exists. A single clearly renovated twin may establish the ARV even when
  the other strong twins are only maintained or move-in-ready — supporting
  renovated evidence strengthens it but is not required.
- **When only strong MEDIAN comps exist, use the best MEDIAN evidence as
  the ARV.** Do not withhold a value because renovated proof is missing —
  move-in-ready stock is the legitimate fallback, since the subject
  renovated to a lower standard can still command that sale.
- **Among renovated comps, prefer the closest physical and location match
  to the subject**, not the higher sale price.
- **A group average of true twins beats a single comp.** When several
  comps are genuinely near-identical to the subject, their average is
  better evidence than any one of them.
- **When nothing matches everything,** select the comp or comp group with
  the fewest and least important differences from the subject.

## 8a. Thin pools — widen before concluding

When the usable pool is thin — no renovated comp, fewer than ~3 usable
comps, or no size bracket for an above-ceiling projection — ask for more
evidence before producing a number:

- **deepen** enriches the comps already fetched (classification, photos,
  listing evidence). It cannot rescue a comp whose sale data is missing —
  use it when the pool exists but is unclassified, not when it is empty.
- **widen** goes back in TIME first — a longer sale window inside the
  SAME geography. It does not leave the block group or the subdivision;
  a bigger radius does not help when what we want is block matches and
  neighborhood matches. Only when the block group is literally empty may
  the search step slowly outward into ADJACENT block groups of similar
  value — and only after verifying the adjacent pocket's values are
  actually relative to the subject's. That is the worst-case escape
  hatch; comps from outside always carry a heavier accuracy discount.
  Prefer going 12→24+ months back in place over leaving the pocket.

Cap the rounds. If widening once or twice still cannot produce a
renovated comp or a size bracket, report the honest floor-only answer
with low confidence — never inflate a thin pool into a confident number.

## 9. Discipline

- The mission is the apples-to-apples comparison — the spitting image, the
  twin. Every deviation from the spec is a step into other genres of
  fruit.
- Never inflate, never stretch, never invent. Use only the data present;
  when data is missing, say so and weigh the comp accordingly.
- These rules are preferences toward the twin, not brittle gates — the
  harness exists to select what is closest to this source of truth, and
  judgment is expected where the spec bends rather than breaks.

## 10. Pocket value and deal economics

The harness also owns the classification that used to render server-side
— same evidence, same discipline:

- **Pocket score (0–10).** Rate the subject's pocket — the block group /
  neighborhood / tract trio the comp pool was drawn from — for wholesale
  deal quality. Look at what the pocket's own sales evidence says:
  renovation velocity (are flips selling?), price discipline (do strong
  twins cluster, or scatter?), investor demand (verified flip resales are
  the clearest signal). A high score means this pocket supports confident
  ARV evidence; a low score means thin or erratic pricing where the deal
  needs wider margins to be safe.
- **Deal economics.** One line classifying the economics of this specific
  deal — what the ARV evidence, the renovation budget, and the spread
  between them imply. Examples of the shape: "strong margin — renovated
  ARV evidence well above as-is", "thin spread — median evidence only,
  treat ARV skeptically", "distressed pocket — discount the anchor".
- Both ride the saved report next to your verdict. If evidence is thin,
  say so in the score — don't grade on what you wished the pocket looked
  like.

## 11. The renovation scope — the second verdict

The evidence bundle carries `renovationEvidence` — the four data points a
human underwriter reads plus the pricing context:

- `zoneGrades` — Clef/Luna's per-zone photo reads (kitchen, baths,
  flooring, walls/ceilings, exterior) + system and structural concerns.
- `pathGate` — `photoConfidence` and `readableZones` with a recommended
  path. ≥70% confidence and ≥4 readable zones → Path A (custom scope).
  Otherwise Path B (zip $/sf fallback).
- `descriptionClaims` — year-anchored work claims pulled from the
  subject's listing text ("roof replaced in 2019").
- `permitLedger` — every major item with its age threshold, newest
  matching permit year, and status: `credited` (verified in window →
  charge $0), `past_threshold` (must charge), `unknown`.
- `sellerNoteClaims` — realtor notes parsed into additions and
  advisories. Notes only ever add scope.
- `finishParity` — finish keywords the pocket's ARV comps advertise vs
  what the subject has. Items missing on the subject are your cosmetic
  upgrade list.
- `flipDelta` — the local rehab $/sf measured from verified flip pairs in
  this pool. `pathBRates.flipDeltaPerSqft` is the Path-B rate.
- `costSchedule` — effective per-item costs (user overrides applied).

Post a `renovation` object inside your selection:

```json
{
  "renovation": {
    "pathUsed": "A",
    "lineItems": [
      { "item": "roof", "action": "replace", "category": "capex",
        "uadFrom": "C4", "uadTo": "C2", "spec": "arch shingle, tear-off",
        "cost": 11500, "source": "permit" },
      { "item": "kitchen", "action": "upgrade", "category": "cosmetic",
        "uadFrom": "C3", "uadTo": "C2", "spec": "LVP + quartz parity",
        "cost": 14000, "source": "parity" }
    ],
    "contingencyPct": 15,
    "totalEstimate": 29400,
    "notes": "one line on the scope"
  }
}
```

Rules:

- **Path A** (zone reads support it): itemize the scope — CapEx items
  (permit-ledger mandatory + structural/system concerns) and cosmetic
  items (zone grades + finish-parity gaps) as separate `category` values.
  `base_scope` is allowed as a single item for broad cosmetic work the
  zones justify but don't quantify.
- **Path B** (thin photo coverage): post `base_scope` with
  `cost = subjectSqft × rate` — flip-delta rate first, your judgment of
  the zone evidence second. Still post every mandatory permit item.
- **Every line item** maps a UAD move (`uadFrom` → `uadTo`) — the scope
  must literally construct the ARV condition your comps prove.
- **Dated description claims** credit an item at repair tier (not $0 —
  permits are the only $0 credit). Undated claims are advisory.
- **Recondition ≠ replace** — a serviced or recently repaired system
  charges the repair/recondition cost, not full replacement.
- The harness prices your posted scope against `costSchedule`
  deterministically: omitted mandatory permit items are appended, costs
  outside 0.4×–2.5× of schedule are clamped, user overrides are
  enforced. `totalEstimate` diverging >15% from the priced total is
  flagged on the run record — price to the schedule, adjust by judgment
  inside the band.
- Omit `renovation` entirely to leave the deterministic tier × $/sf math
  in place — only post a scope when the evidence supports one.
