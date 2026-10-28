# Flip backtest — ARV vs known resale price

Verified flips (bought → renovated → resold) give a known after-repair
price. We run the flip's address through the harness and compare the ARV
to what it actually resold for.

## Tooling

| Piece | What it does |
|---|---|
| `verified_flips` (migration 0046) | One row per verified flip. Every saved evaluation records the flips its comps carry. |
| `verifyFlip()` (`services/verified-flips`) | Rule: both legs priced, held 30–365 days, resale ≥10% over buy, resale not distressed. **high** = buy looks like a market sale (≥$30k, gain ≤200%); **medium** = buy may be a transfer. |
| `scripts/backfill-verified-flips.mts <d1.sqlite>` | Fills the table from saved reports. No provider calls. |
| `scripts/flip-backtest.mjs <d1.sqlite>` | Picks the newest high-confidence flips per state, runs each with `rerun: true`, scores ARV vs resale. `--only` re-runs a few. |
| `rerun: true` on `/v1/analyze` | Fresh evaluation on cached provider data. `skipCache` throws every provider cache away — eval scripts were re-paying ATTOM each run. |

Results land in `.data/flip-backtest/*.json` (not committed).

## Round 1 — 2026-10-28, harness `og-2026.10.26.1`, local

20 flips: the 10 newest high-confidence per state (FL, GA), sold since
2026-01-01, resale ≥$75k. Local backfill found 58 flips in 183 saved
reports (54 high).

**Result: median miss 28% over the 19 comp-driven runs; 5 within 10%.**
Not production-ready on this evidence, but see "Local run limits": the comp
condition reader was down for every run.

| Comp-driven runs | n | median miss | within 10% |
|---|---|---|---|
| All | 19 | 27.6% | 5 |
| Florida | 10 | 22.7% | 4 |
| Georgia | 9 | 27.6% | 1 |
| One driving comp | 16 | 28.4% | 4 |
| Two or more | 3 | 15.6% | 1 |
| No driver sold after the resale | 10 | 17.9% | 4 |
| A driver sold after the resale | 9 | 29.1% | 1 |

Every run graded its own confidence `low` (or `none`) — the harness knew.
2090 Fairburn Rd (−1.3%) had no driver and fell back to the ATTOM AVM,
which already knows the resale; it is left out of the scores.

Results page: https://claude.ai/artifact/EKPsrRMApuf7KsmbmA4nhp

### What held up

- **Cache:** second pass of the same 17 flips — 0 paid ATTOM calls, all
  from our cache, 30–50% faster.
- **Repeatable:** identical ARV on all 17, both passes.
- **No self-comps:** no subject appeared in its own pool after the fix below.

### Fixed during the round

1. **Flip buy leg priced as a comp sale.** The market-context supplement
   skipped the latest-sale correction; 18 saved comps (Oct 1–10) carried
   the buy price, e.g. 2927 Banza St at $25,100 labeled "verified flip".
   One helper (`correctToLatestSale`) now covers every comp path.
2. **Subject as its own comp.** market-context returns the subject's own
   recent sale; nothing excluded it (`dropSubjectSelf`).
3. **`propertyId` ignored.** The route accepted it; the job searched by
   address only. 3 zip-less Atlanta addresses failed PROPERTY_NOT_FOUND.
4. **Cache policy:** one 30-day evaluation TTL (a stale 21-day constant
   remained); permits 7→30 days, photo reads 21→30 days; ARV key → v6.

### Misses and what drove them (proposals — need owner approval)

| Flip | Sold | ARV | Miss | Cause |
|---|---|---|---|---|
| 3209 Amalfi Cir SW | $160,000 | $468,248 | +193% | One driver, a $549k sale 0.7 mi off. Flip held 54 days for +21% — likely a wholesale, not a rehab. |
| 2928 Banza St | $200,000 | $492,200 | +146% | Both drivers **have no sale date**; the $449k one anchored. |
| 6312 Fairway Blvd | $328,000 | $593,006 | +81% | Subject inland, anchor 727 Flamingo Dr **waterfront**. No inland comp could carry an ARV, so the site rule kept the water comps (by design: never a null ARV). |
| 2960 Hogan Rd | $360,000 | $131,828 | −63% | One unidentified-condition driver; pocket trend −16%/mo applied. |
| 3925 W Norfolk St | $495,000 | $252,141 | −49% | One driver 0.93 mi off; resale is $502/sf vs a $181/sf pocket (sqft may be stale after the rehab). |

Proposals, highest expected impact first:

- **P1 — Single-comp ARVs.** 16/20 rested on one comp. Require a lone
  driver to be near and recent, otherwise mark the ARV for review. Note:
  conflicts with the owner's "1 comp is enough" filter-ladder rule.
- **P2 — Undated comps drive.** `bIsUnfit` passes `staleness: unverified`.
  A sale with no date should bound, not drive.
- **P3 — Site-rule fallback.** When no site-matched comp can carry an ARV,
  prefer the matched as-is comps (or no ARV / review) over pricing an
  inland home off a waterfront sale.
- **P4 — "High" flip needs rehab proof.** Add a renovation signal (permit
  between the legs, listing text) or a higher gain floor; Amalfi-type
  wholesales are not ARV truth.
- **P5 — Clef context overflow.** 369 Virginia Pl sent ~444k tokens to a
  65k-context model (photo batch not capped).

### Local run limits

- **Comp condition reader down in every run** (`decisions_batch+reasoning
  failed` — local `OPENAI_API_KEY` returns 401). Most comps were
  "unidentified" condition, so driver choice ran nearly blind. Production
  has the key; re-run with a working key before judging accuracy.
- Comps are pulled as of today, not as of the resale date (9/20 runs had a
  driver that sold after the resale).
- The ATTOM AVM already reflects the resale.
- Flips come from Tampa Bay and metro Atlanta only.

Migration 0046 is applied to local D1 only. Production needs
`npm run db:migrate:remote` with the next deploy.
