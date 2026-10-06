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

## 2. Geography and location — where comps come from

- **Block group is the strongest geographic unit.** It is the smallest
  atomic statistical geography defined by the U.S. Census Bureau, carries a
  unique 12-character GEOID, and is bounded by streets and physical
  features — which is what makes its comps the highest-likelihood matches
  for physical similarity and value parity.
- **Neighborhood** is a localized, often informal community area with no
  official standardized federal geocode. It is still effectively required:
  it carries the similar values and proximity we need, so prefer comps
  inside the subject's neighborhood whenever they exist.
- **Census tract is disregarded.** It is too large and skews selection away
  from the closest properties in proximity and value parity.
- **Major roads and physical barriers are a major negative.** A
  near-perfect twin sitting across a highway, major road, railroad, or
  other clear neighborhood divider loses to a same-side twin and needs a
  location adjustment — but the physical match can still outweigh the
  barrier when that comp is the best evidence available. (Owner-confirmed
  as a negative, not an exclusion.)

## 3. The twin spec — what the ideal comp looks like

Selection preferences, roughly in order of importance:

- **Style match.** Same property style as the subject. A renovated ranch
  comp beats a higher-priced renovated two-story when the subject is a
  ranch — closer twins win even at a lower sale price.
- **Living area: ±250–500 sqft preferred range** for selection (overrides
  the earlier ±250). Beyond it, the comp can still be used — with the full
  square-footage adjustment from Section 6.
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
  concrete to concrete, wood to wood. See FOUNDATION-001 in Section 6 for
  the directional value rule.
- **Bed/bath count:** preferred to match, but differences are adjustable
  for the value beds and baths add in that submarket or pocket. Not a hard
  gate.
- **Missing data:** if a comp is otherwise an excellent twin but a field is
  missing — foundation, construction material, lot size — keep the comp
  and treat that field as unknown. Never assume it matches, never drop the
  comp for the gap alone. Weigh it accordingly.

## 4. The evidence bands

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

## 5. Sale recency

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

## 6. Adjustments — market-derived first

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
foot carries structural, material and utility cost:

```
adjustment = market rate per sqft  ×  full |comp sqft − subject sqft|
```

- Direction: subtract when the comp is larger, add when it is smaller.
- Worked example from the spec: subject 2,000 sqft, comp 2,300 sqft,
  $50/sqft market rate → −$15,000 (not −$2,500, which is what adjusting
  only past the 250 threshold would give).
- Per the source-of-truth interview, a comp that is bigger or smaller than
  the subject only commands **50% of the price per square foot** for the
  size difference — so the default rate is 0.5 × the local $/sqft unless
  paired sales in that pocket demonstrate a stronger rate. (Flagged for
  owner confirmation.)

**FOUNDATION-001 — directional:** concrete and concrete-block foundations
are equivalent. Wood, pier-and-beam and crawlspace are a separate group.
Concrete and block are stronger long term and depreciate less, so crossing
the groups adjusts only one way:

- Subject is the wood group, comp is concrete/block → deduct 10% from the
  comp's price.
- Subject is concrete/block, comp is the wood group → leave the comp
  alone. No upward adjustment is taken.

## 7. Evidence quality rules

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

## 8. Discipline

- The mission is the apples-to-apples comparison — the spitting image, the
  twin. Every deviation from the spec is a step into other genres of
  fruit.
- Never inflate, never stretch, never invent. Use only the data present;
  when data is missing, say so and weigh the comp accordingly.
- These rules are preferences toward the twin, not brittle gates — the
  harness exists to select what is closest to this source of truth, and
  judgment is expected where the spec bends rather than breaks.
