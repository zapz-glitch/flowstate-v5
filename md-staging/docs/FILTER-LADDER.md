# Filter ladder — how the server loosens comp rules

Product-engineer rule, set 2026-10-05. This replaces the old "flex" ladder
that multiplied every numeric rule at once (×1.15 … ×5).

## The goal

Find at least **one** comp with ARV price evidence that passes the user's
evaluation settings. The user never loosens settings by hand. The server
loosens them, one small step at a time, and stops at the first step where
an ARV comp passes. Every comp that passes at that same step is kept; the
server never loosens further just to collect more.

Least leakage is the point. Each loosening is recorded.

## What never loosens

Property type, style, stories, foundation family, road barrier, and every
other rule in the settings. Only three rules move.

## What loosens, and in what order

| Rule | Start (from settings) | Each step adds |
|---|---|---|
| Square feet | ±250 | 25% of the subject's square feet |
| Year built | ±10 | 3 years |
| Sale age | 180 days | 30 days |

Example, a 1,200 sq ft subject: square feet goes ±250, ±550, ±850; year
goes ±10, ±13, ±16; sale age goes 180, 210, 240 days.

Steps, each one a superset of the one before:

0. Strict: all three at their start.
1. Sale age alone gives one step. Going back in time is cheaper than
   giving up size or year.
2. Square feet gives one step.
3. Year built gives one step.
4. Sale age gives a second step.
5. Square feet, then year, then sale age again — and so on.

There is no fixed cap. The data is the stop: once the limits are wider
than every candidate in the area, nothing more can be gained there.

## Geography loosens last

The whole ladder runs inside one area before the next area is tried:

1. Same census tract
2. Same block group (covers comps whose tract stamp is missing)
3. Same neighborhood or subdivision name
4. Value-equivalent adjacent pocket (the existing rural rule)

"Better to go back in time than leave the tract."

## Closest to the start wins

Because each step is the smallest possible widening, the first ARV comp
found is the one closest to the strict settings. Paid enrichment follows
the same order: candidates at the tightest step are enriched first, six at
a time, up to 25.

## What gets recorded

`retrieval.paramFlex` on every run:

- `extensions` — the step the ladder stopped on (0 = strict)
- `limits` — the square-feet, year, and sale-age limits at that step
- `scope` — the area the winning comp came from
- `concessions` — plain-words list of what moved, for the report
- `factor` — the largest single-rule ratio (kept for older readers)

The stretch is evidence quality: a comp admitted at strict is stronger than
one that needed many steps or a wider area.

## What "same area" means

Census geography decides, enforced by the `geo_scope_match` rule: a comp is
in the subject's area when it shares the census tract or block group.
Provider name labels (city, zip, school district, subdivision,
neighborhood) only rank a comp; they never reject one. One town can carry
two labels ("Rex" and "Forest Park-Morrow").

The ladder widens the area by raising that rule's level: 1 tract or block
group, 2 also a matching neighborhood name, 3 also a value-equivalent
adjacent pocket.

## Switched off, not just barred

Transaction noise (extreme price outlier, package deed, bulk sale, nominal
sale) is switched off as a comp. It stays in the report with the reason.

## Verified flips and the AVM

A sale far from its own AVM normally cannot drive. A verified flip is
exempt: the AVM lags a renovation and the buy and resale are the proof. The
run notes it ("verified flip kept despite own-AVM divergence") so the gap
can be watched.

## What counts as an ARV comp

A comp is ARV evidence in one of two ways:

1. **A real flip** — bought, then resold 30 to 365 days later.
2. **It sits in the top price group of its pocket.**

Price classes (ARV, Median, Investor) come from grouping the pocket's sales
at the natural breaks in their price per square foot, the way a person
reads them. There is **no percentage test** against the subject's AVM, the
comp's AVM, or a pocket median.

- Only sales **inside the pocket** are grouped: tract first, then block
  group, then neighborhood name. Outside sales never shape the groups.
- Three or four sales are enough. Evenly spread prices show no pattern, so
  no sale is "top" just for being highest.
- A lone sale far above the pocket is an outlier, not a class — unless a
  real flip or a confident renovated read vouches for it.
- Condition (Renovated, Dated, Distressed) is a bonus. A missing read never
  blocks the ARV class. A confident read that disagrees by a full tier is
  arbitrated by the model's own scores.
- A comp must still pass the evaluation rules to drive the ARV. Being in
  the top group is never enough on its own.

Code: `apps/api/src/services/evaluation/price-groups.ts` and
`comp-classification.ts`.

## Not changed by this rule

- Set-B valuation (`packages/shared/src/appraisal/set-b.ts`)
- Price classes (ARV, Median, Investor) and condition classes (Renovated,
  Dated, Distressed). ARV price evidence is what the ladder looks for;
  renovated condition is preferred but not required, because photo and
  listing evidence can be missing.
- Building materials, roof, garage, pool, lot size: rank only.
