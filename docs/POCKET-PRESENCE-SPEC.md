# Scoring Spec v2 — Pocket, Economics, Evidence Quality

Status: **draft — replaces the v1 pocket-presence spec.**

The offers queue needs three independent judgments per evaluated
property, computed **after the eval completes** — once ARV, median band,
as-is, and list price are locked. Scores are stored, not recomputed at
queue-read time.

## Scores

| Score | 0–10 | Question it answers | Cache unit |
|---|---|---|---|
| **Pocket** | tract/neighborhood desirability | Do people want to move here? Do investors want to buy here? | per pocket (90d) |
| **Economics** | acquisition likelihood | Can we buy this at our number? | per property |
| **Overall** | blend | How strong is this lead overall? | per property |
| **Evidence quality** | flag, not a score | Was our comp pool clean enough to trust? | per property |

Evidence quality stays OUT of the pocket score — a thin comp pull
doesn't mean a bad pocket. It displays as a flag (strong/thin) next to
the score instead of silently dragging it.

## Pocket identity

`censusTract` + `censusBlockGroup` + `subdivision`/`neighborhoodName` —
the statistical anchor AND the lived-market name, both kept. Queries hit
the tract/block group directly, never the name alone — every pocket has
a real statistical identity, so coverage is uniform across submarkets.

## Pocket score — what goes in

**Produced by the eval (free, uniform coverage):**

| Input | Source |
|---|---|
| Median price band (25–75th pct of enabled comps) | `compPool[].salePrice` |
| Pocket price trend — rising / flat / declining | time-adjustment mechanics + pocket price groups already in the payload |
| Turnover velocity — recent-sale density | `compPool[].saleDate` distribution |
| ARV band vs median band delta | report.arv vs comp pool band |

**Fetched once per pocket (cached 90d):**

| Source | Query |
|---|---|
| Serper / Scrapfly fallback | desirability evidence for the tract+subdivision — school district, demand, buyer/investor activity, reputation |
| Clef (`clef-flash`) | structured score-question on geo + evidence → verdict + probabilities |
| GPT-6 Luna | independent read over same evidence → then the **final merge call**: Clef verdict + its own analysis + band/trend/velocity inputs → final score + rationale |

## Economics score — what goes in

The operator's question: "can I acquire this at my wholesale number?"
Two sub-scores, both reasoned by Luna:

### Cost fit — does ARV − list hold the whole cost stack?

Not a fixed dollar target. The eval already computes every cost —
rehab + carrying + closing + wholesale fee + investor profit — and the
buyPrice (MAO) where they all fit. The question is whether ARV − list
covers that stack with room to spare, and whether the required discount
below list is negotiable. Rough guide: workable deals negotiate
~$30–50k off list; the MAO itself is the ceiling.

| Input | Source |
|---|---|
| ARV | `report.arv.value` |
| As-is value | `report.arv.asIsValue` |
| List price | `subject.listPrice` / `listingDetails.listPrice` |
| Wholesale price | queue item / lead |
| Cost stack | renovation + carrying + closing + wholesale fee + investor profit (deal-params) |

### Achievability — will the seller take our number?

All already in `subject.listingDetails` — **zero fetches**:

| Signal | Source | Read |
|---|---|---|
| Days on market | `listingDetails.daysOnRedfin` | long sit = motivated or fishing |
| Price-drop cadence | `listingDetails.saleHistory` price-change events | drops every ~30d = motivated; never dropped = fishing/out to lunch |
| Contract fallouts | `saleHistory` pending→relisted cycles | multiple fallouts = deal-hungry BUT ⚠️ flag it on the card — "find out why" |
| View/save counts | not captured today — Zillow scrape (enhancement) | hot views+saves = priced right, real demand |

Operator rules baked in: a discount from list is always expected (list
is usually rich, especially when sitting); wholesale≈list + hot views =
priced right; wholesale≈list + 30-90+ DOM + no drops = fishing.

### Card flag

`fell out of contract N times — find out why` renders as a note on the
property card whenever saleHistory shows a pending→relisted cycle.

## Evidence quality flag

`strong | thin` — from enabled/examined share, outlier share, in-pocket
comp share. Displayed next to the scores so a low pocket score with thin
evidence reads differently than one with strong evidence.

## Overall score

Deterministic blend — default **50/50** pocket/economics (weight is a
decision, see below). Scores stand alone; overall is just the sort key.

## Flow

1. Eval completes → run_records payload locks (bands, list price, geo).
2. Post-eval scoring job: pocket (gather → Clef ∥ Luna → Luna merge) +
   economics (Luna over bands) + evidence flag → write `property_scores`.
3. Queue read: SQL join only — instant, zero external calls.
4. New pocket → score once, reuse 90 days. Refresh on timer.

## Storage

- `pocket_scores` (per pocket): dynamics verdict, evidence, 90d TTL.
- `property_scores` (per jobId): pocketScore ref, economicsScore,
  overallScore, rationales, evidence flag.
- `metro_map` unchanged.

## Open decisions

- [ ] Overall weight: 50/50, or economics-weighted (60/40)?
- [ ] Economics needs wholesale price — engine items have it; api items
      may only have listPrice. Fallback chain: listPrice → wholesalePrice →
      neutral 5?
- [ ] Evidence-quality display: flag chip vs tooltip?
