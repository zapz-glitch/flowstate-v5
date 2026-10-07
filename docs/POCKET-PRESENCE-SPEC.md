# Pocket Presence — Design Spec

Status: **proposed — awaiting sign-off before implementation.**

Goal: the offers queue groups leads by metro, and inside each metro orders
properties by how strong their comp pocket is — so the most desirable
underwrites surface first. Scoring is cheap because pockets are scored
once and reused: a property carries its pocket; the pocket carries the
score.

## 1. Pocket identity

Every evaluated property already carries geography in its run record.
The pocket is the tract / block group / neighborhood trio:

1. `censusTract` + `blockGroup` + county — the statistical anchor
2. `neighborhoodName` + city + state — the lived-market anchor
3. `zip` — last resort

The pocket carries both identities (tract+block for stability, name for
humans); a property joins whichever the payload has.

Normalization: lowercase, strip punctuation/spaces, e.g.
`oakwood-estates|marietta|ga`.

## 2. `pocket_scores` table (D1)

| column | notes |
|---|---|
| `pocket_key` | PK — normalized key above |
| `display_name` | "Oakwood Estates" |
| `metro` | resolved metro umbrella ("Atlanta") |
| `city`, `state`, `zip` | anchor |
| `score` | 0–10 |
| `median_lo`, `median_hi` | pocket price band from comp evidence |
| `inputs_json` | deterministic inputs snapshot |
| `evidence_json` | Serper/LLM desirability evidence |
| `scored_by` | `deterministic` \| `clef` |
| `eval_count` | how many evals have hit this pocket |
| `scored_at`, `refresh_due_at` | refresh cadence ~90d or on drift |

## 3. Score composition (0–10)

| Weight | Input | Source |
|---|---|---|
| 40% | **Alpha delta** — list price vs pocket median band vs ARV band. List below the band = upside to capture; at/above = thin | run payload (deterministic) |
| 25% | **Band discipline** — comp-selection bands reused: coherence, outlier flags already emitted at eval time. Bands are the ground truth — they keep scoring honest | run payload (deterministic) |
| 35% | **Desirability + activity** — demand, reputation, momentum signals | Serper search → Clef/Luna classify, cached per pocket |

The comp-selection bands (T1/T2 tiers, price-band outliers) are written
into run_records at eval time — scoring reads them back rather than
re-deriving. Outlier flags pass through as score inputs so a pocket
built on outliers can't masquerade as clean.

Per-property pieces (alpha, density) always compute fresh from the eval's
own payload. Per-pocket pieces (desirability, band, metro) compute once
per pocket and cache.

## 4. Lifecycle

1. Eval completes → run_records row exists (already true).
2. Queue read resolves each item's `pocket_key`.
   - **Hit** → cached score + name, zero cost.
   - **Miss** → provisional deterministic score now + enqueue scoring
     job (Serper + Clef) → row written; next read is cached.
3. Re-score on refresh_due_at (90-day cadence) — plus opportunistic
   refresh when a new eval lands in a stale pocket.

## 5. Metro grouping

Umbrella = major metro, not listing city. `metro_map` table caches
city→metro (Marietta → Atlanta, St. Petersburg → Tampa Bay, Wylie →
Dallas-Fort Worth). Unknown cities classify once via LLM and cache;
unmapped → "Other". Submarkets rank inside their metro umbrella by score.

Queue response gains per item: `metro`, `pocketKey`, `pocketName`,
`pocketScore` (or grouped `{metros:[{name, items}]}`). Deadline items get
urgent styling inside their metro group — no separate pinned section.

## 6. Cost profile

- Queue read: SQL join only — instant, zero external calls.
- New pocket: ~1 Serper query + ~1 Clef/Luna classify, once.
- New city: 1 metro classify, once.
- No re-evaluation of anything already scored.

## 7. Open decisions

- [x] Pocket = tract + block group + neighborhood
- [x] Refresh: 90-day timer
- [x] Serper key — approved for flowstate-api
- [ ] Classifier: Clef (Workers AI binding) vs Luna (OpenRouter, already wired)
- [ ] Card display: numeric score + pocket name chip?

## 8. Definition of done

- Queue groups by metro umbrella; within each, sorted by score desc.
- Deadline items render urgent inside their metro.
- Every item shows score + pocket name when scored.
- Re-opening the queue costs zero external calls.
- The 391 evals already in today's queue get scored without re-running evals.
