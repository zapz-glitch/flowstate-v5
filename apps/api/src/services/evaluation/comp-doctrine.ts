/**
 * Comp-selection doctrine — the first-principles rules the appraiser
 * (Opus) applies when choosing comps and setting ARV, and the rules the
 * classifier (haiku) notates compliance against. Source of truth:
 * docs/EVAL-AGENT-RULESET.md — keep this string in sync with it.
 * (Workers can't read the filesystem, so the doc is inlined here.)
 */
export const COMP_DOCTRINE = `# Comp First Principles — selection & ARV doctrine

## What the ARV is
The price the subject sells for after the scoped rehab — set ONLY by genuinely renovated retail sales. As-is, distressed, investor-marketed, and nominal sales are the floor (as-is value), never ARV evidence, however updated they look.

## Hard rules — the gate enforces these in code
1. Priceable only: a comp missing sale price or square footage can't carry ARV weight.
2. Distress overrides vision: nominal_sale, foreclosure, or investor-marketed listings can never drive ARV even if photos look renovated.
3. Flagged comps are not evidence: data_error price sanity, non-arm's-length, disabled comps.
4. Pocket discipline: pricing weight goes to in-pocket comps (same block group > neighborhood > census tract) while usable in-pocket comps sit unpicked. Off-pocket drivers with in-pocket comps available is a violation.
5. The ARV must sit inside the price envelope of the renovated comps actually selected (±10%).

## Comp rules — what qualifies a sale as evidence (haiku notates these)
- Real arm's-length sale: no nominal/distressed-sale transaction flags, no data_error.
- Priced in market: sale price + square footage present; $/sf coherent with the pocket.
- Recency: within the preferred sale-age window (stale sales are flagged).
- Geo: same block group preferred; census tract acceptable; outside that is weak evidence.
- Usable condition read: listing evidence sufficient to classify (description or photos).
- A comp missing a rule is still listed — annotated with what it lacks, never silently dropped.

## Selection judgment
- Prefer the tightest-geo evidence of equal quality — block-group comp outranks tract comp.
- A comp priced wildly off its condition group (>1 IQR from the group's price core) is not evidence — outliers get trimmed before they can distort the ARV.
- Verified renovation proof (permit trail, flip resale, explicit remodel language) outweighs a dated-looking stamp.
- One unusual comp shouldn't carry the whole verdict — anchor on the group's middle, not its edge.
- Withholding reasons loses credibility: notes and flags surface evidence gaps rather than hiding them.
`
