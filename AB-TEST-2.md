# A/B Test 2 — working notes (delete later)

Scratch notes for the OG-vs-v2 harness test. Not a doc — a log of what
each run showed and what it suggests for the harness.

**Sides**
- **OG** — `feat/tricks-of-the-trade` @ `~/src/flowstate-v5`, API :8787.
  Ship-time Set-B (`c0f7bcc`) + pinned tricks/tests.
- **V2** — `feat/attom-provider-swap-v2` @ `~/src/flowstate-v5-attom-v2`.
  Claude's: filter ladder, pocket price groups, run records.

**Method**: `node scripts/e2e-analyze.mjs "<addr>" --api http://localhost:8787
--skip-cache --user 8NLlVN9LtfODbvKJ6jpvk9W3a8pfMDep`. Artifact per run in
`e2e/artifacts/`. Stale asserts to ignore: `jevHybrid` and
`report.jev.userOverrides` don't exist at ship-time. Caveat: the script
writes a comp-tier override on the job it tests.

**Run cards**: `node scripts/ab-run-report.mjs <artifact.json> | --job <id> |
--latest` renders timing/ARV/drivers/rules-applied/widening/concessions/
missing-rule signals to `<artifact>.report.md`.

**Versioning**: Charlotte + Dunseath ran on pure ship-time OG
(`c0f7bcc`). From Cascade on, OG carries `746d8f3` — geo hierarchy in
driver selection. From Camp Ground #2 on, `4f58d09` (directional-strip
address retry) + `14f27a8` (**insufficient is the ladder's last word** —
a verified B answer serves even when the grid enabled zero). Camp
Ground re-run proves it: served $199,922 rescue answer, was $161,145 AVM.

## Run log (hardened harness — all fixes live)

| Address | OG before → after | OG path | V2 ARV | Appraiser read |
|---|---|---|---|---|
| 3709 Charlotte Dr, Rex GA | $211,315 → $198,571 → **$247,953** | Fox Run anchored but ARV floored at maintained-band median — pocket's maintained sales ($215–256k, rescued via sale-age/label T1b + time-adj) out-earned the anchor | $253,000 | ? |
| 2184 Dunseath Ave NW, Atlanta | $313,966 → $421,427 → **$443,467** | T1b rescued 1956 Main St (v2's anchor) + Rando Ln past label vetoes; Rando anchored, uplift, ceiling $497k→$443k. Top of appraiser band | $402,294 | ~$450–525k |
| 2973 Cascade Rd SW, Atlanta | $280,640 → $280,640 | unchanged verified anchor | ? | ? |
| 3420 Coles Creek Dr, Buford | $471,346 → $471,346 | unchanged verified | ? | ? |
| 2191 Camp Ground Rd SW, Atlanta | $161,145 → $199,922 → $249,753 → **$201,305** (uplift removed) | +2 rescues → self-heal Rux→Dale Ln → contributory uplift; verified | AVM floor | ? |
| 6225 Tennis Dr, Fairburn | $267,904 → $267,904 | honest AVM floor (below-AVM invariant held) | ? | ? |
| 214 Taft St SW, Atlanta | $158,187 → **$244,820** (unchanged post-uplift — the number was anchor+ceiling, uplift capped away) | 4 stale rescues incl. both Upshaw + Aiken (anchored, time-adj −10%); uplift, ceiling $286k→$245k. Aiken ~1yr stale — watch | ? | ? |
| 2782 Centerville Rosebud Rd | $254,524 → $408,002 → **$332,831** | Evidence bands replaced price thirds: maintained $152/sf · renovated $171/sf — lower but condition-honest | ? | ? |
| 194 Cedar Mill Dr, Dallas GA | $462,903 → **$442,080** (uplift removed) | T0 anchor — self-heal to 108 Longwood Pl, +$77,120 uplift, ceiling cap at answer; full machinery, verified | ? | ? |

| 2151 Shadowwood Dr, Marietta | **$347,743** | T0 anchor verified — 1 rescue | ? | ? |
| 2772 Palm Dr, East Point | — | **provider miss** — 'Palm Dr'/'Palm Drive' both not-found (resolution, not harness) | ? | ? |
| 1343 Emory Rd, Atlanta | **$959,002** | 7 rescues past city-label noise; self-heal +$68k; Druid Hills pocket | ? | ? |
| 951 Oriole Ln SE, Marietta | **$405,670** | clean T0 anchor; median-tier at face value (no uplift) | ? | ? |
| 2623 Preston Dr, Decatur | **$280,776** | 8 rescues — whole pocket hidden behind 'Decatur vs Atlanta-Decatur' labels | ? | ? |
| 1300 Nash Rd NW, Atlanta | **$283,799** | 2 zip-label rescues, self-heal | ? | ? |

**Verified-answer rate: 6/8 now (Tennis honest floor).** Dunseath headline —
floored at AVM before hardening, now a verified pocket answer ~5% from
v2's number and at the bottom of the appraiser's band.

### Pre-hardening log (for reference)
| Address | OG ARV | OG path | V2 ARV | Appraiser read |
|---|---|---|---|---|
| 3709 Charlotte Dr, Rex GA | $211,315 | T0 anchor, attempt 1 verified (low conf — all-bigger bracket) | ? | ? |
| 2184 Dunseath Ave NW, Atlanta | $313,966 | **AVM floor, unverified** — 0/43 comps enabled | $402,294 (verified, 1956 Main St anchor) | ~$450–525k |
| 2973 Cascade Rd SW, Atlanta | $280,640 | T0 anchor, attempt 1 verified — geo tier dropped 2 out-of-tract drivers | ? | ? |
| 3420 Coles Creek Dr, Buford | $471,346 | T0, attempt 1 — geo dropped 3, self-heal re-anchored (floor→Sturbridge), URAR +$84k, ceiling capped $505k→$471k, flex ×3 | ? | ? |
| 2191 Camp Ground Rd SW, Atlanta | $161,145 → **$199,922** after `14f27a8` | T1 rescued Rux Rd (lot-only fail) → B verified $199,922; serve-path fix now delivers it (was AVM $161,145) | AVM floor | ? |
| 6225 Tennis Dr, Fairburn | $267,904 | AVM floor, unverified — flex ×5 left 1 comp; retail-band driver (sim 1.5, 1.8mi) capped at $244,827, **below as-is AVM** → floor | ? | ? |
| 214 Taft St SW, Atlanta | $158,187 | T0 anchor, attempt 1 verified — median-tier driver (Upshaw, sim 8.1), land ladder T3, contrib uplift +$41,612, ceiling capped $199,799→$158,187 | ? | ? |
| 2782 Centerville Rosebud Rd, Snellville | $254,524 → $321,663 → $354,773 → **$408,002** | T2 pocket-tiers [tract]: 17 cleaned sales, bands $109/$152/$174 per sf; +marginal repricing (`8801630`), +land ladder inside tiers (`b9391db` — ±20% cap bound, subject 1.38ac vs pocket third-acre) | ? | ? |

Tricks checklist (run card §): on the pocket path — marginal sqft+land
✓, cleaning ✓, tier discipline ✓, pocket tiers ✓, anchor-not-blend ✓
(band carries); ceiling/gate/heal/uplink n/a by design. On comp path
(Coles Creek) — all 11 tricks + geo tier fire ✓.

### Centerville Rosebud — the lot rule was right, the name veto wasn't
- Subject lot 1.38ac vs pocket 0.2–0.36ac — `lot category mismatch`
  correctly excluded same-street sales (2831 CR Rd sold $483,650 on a
  third of the land).
- **19 comps killed by name vetoes inside the tract** — worst example
  yet; includes a same-street comp. Name matching remains candidate #1.
- New gap: pocket tiers don't lot-normalize — for a big-lot subject the
  ARV band may overprice (subject 1.38ac vs pocket 0.2–0.36ac — watch
  whether $321,663 survives appraiser scrutiny vs the old AVM $254,524).
  Fix: lot-adjust the band members before median (comp price minus its
  land delta vs subject).

### Taft St — the near-miss that mattered
- 248 Upshaw St Sw (same street, $198,752, 850sf) died ONLY on sale age
  — 461d vs flexed max 270d. It was the supporter the uplift needed:
  with it, ARV lands ~$199,799 instead of capping at $158,187.
- Flex ladder stops at fixed steps (×1.5 → 270d) — it doesn't "widen
  until the pocket gains one more comp." Evidence sat one notch out.
- 1651 Aiken ($290k) died on sale age too — the user's outlier instinct
  was right, but date killed it, not outlier machinery. Ceiling rules
  would have handled it fine.
- 1684 Thornton ($185k) died on lot (12k sqft vs subject ~5k, 2.4×) —
  correct exclusion.

### Taft St — median substitute working when served
- Median-tier driver anchored and served: 214 Upshaw St Sw carried the
  ARV (sim 8.1), contributory uplift +$41,612, ceiling cut to $158,187.
- Confirms the Camp Ground fix: median evidence reaches the report when
  the comp survives as *enabled* — the gap is only the insufficientComps
  serve-path, not the driver logic.
- Over-cap land adj correctly downweighted (36% > ±25% cap).

### Tennis Dr — the below-AVM invariant working
- Deepest widening yet: 10 extensions, ×5 (age→900d, sqft→±1250,
  year→±50, dist→5mi, lot→±12500). Still only 1 comp enabled; its
  siblings on the same street stayed disabled.
- B did engage: retail-band driver (5785 Colonist, $230k, 1.8mi),
  land ladder fired (T1 vacant-land $2.02/sf → +$17,576), ceiling cut
  $257,403→$244,827 — then the "ARV can't sit below as-is AVM" check
  failed it and the report served AVM $267,904 unverified. Honest:
  weak evidence named, floor labeled.
- If v2 answers lower than AVM here, check whether it dropped the
  below-AVM invariant or found better evidence.

### Camp Ground — BOTH floored to AVM; the blocker was the lot rule
- V2 also served its AVM — the filter ladder only widens sqft/year/
  sale-age. Rux Rd's *only* failure was lot size, which the ladder never
  moves — so the same evidence stayed out of reach on both sides.
- **The shared gap is now the lot rule** — audit K8 (soft under ~2× the
  subject's lot, hard above) or a wider rescue allow-list. Lot mismatch
  is all-or-nothing on both branches.
- OG difference worth keeping in mind: OG did *find* the answer (B
  verified $199,922 on the rescued comp) but couldn't serve it.
- All 38 grid-killed; T1 rescue brought back 3844 Rux Rd ($194,900,
  880sf, lot-only fail) → B anchored it, `attempt 1 — verified`,
  ceiling-capped at $199,922.
- Served `valuation.arv` = subject AVM $161,145 (`arvSource: avm`)
  anyway — `insufficientComps` keys off grid-enabled count, so the
  rescue-verified answer never reached the response. **Same
  dual-number defect as Dunseath, worse:** this time B was *verified*,
  not just computed.
- Fix candidate: `insufficientComps` should count rescued+verified
  drivers, or the serve path should prefer a verified B result over
  the floor. (Boundary: which B verdicts may override a floor.)

### Coles Creek — every trick fired
- Flex ladder ×3 (8 extensions) still left 8 comps dead on sqft alone —
  smaller-home pocket again (Fallen Oak, Harvest Ridge, Arbor View).
- Geo tier dropped Knoll Crest / Morning Meadow / Oklahoma Dr.
- Self-heal caught the same-street floor anchor (3410 Coles Creek
  $338,499 → re-anchored to Sturbridge $421,143).
- URAR contributory +$84,144 → outlier ceiling cut $505,287 → $471,346
  (0 supporters — the Woodcrest rule live).

Note: "Cascade Rd SW" fails ATTOM resolution outright; "Cascade Rd"
resolves attomId 26145152 (same parcel). Directional-suffix fragility at
provider lookup — Fulton (13121) parcel bridge not registered at
ship-time. Provider-path gap, not harness.

## What the runs showed

### Dunseath — OG was honest but toothless
- Not one rule — the AND of every hard filter emptied the pool: 13×
  major road, 16× era mismatch, 7× sqft gap (>±500), 5× condo type,
  4× lot size, 3× subdivision name. 43 comps, zero survivors.
- 5 comps failed on **sqft alone** — real same-era pocket sales
  (1935 Sumter 958sf/$400k/1948, 1981 Sumter 999sf/$241k, 2048 Claude,
  1682 Abner, 1854 Francis). Smaller homes are what this pocket is.
- The comp v2 anchored on — **1956 Main St, $419,900, same street** —
  died on a string compare: `subdivision "ES SPINK PROP" ≠ "WHITLEY
  HEIGHTS"`. Label noise vetoed the best evidence. (v2 made name-geo
  rank-only; this run proves why.)
- T1 rescue can't help: it only rescues exactly-one-failure=lot-size.
- Retry ladder ran correctly: widen +0 comps, deepen +8 fields, final
  unverified → served the subject AVM ($313,966) as the answer.
- **But** Set-B's T2 pocket-implied computed $418,562 from 28 same-tract
  sales — exactly the audit's predicted OG number. The served ARV and
  the bMechanics answer disagree inside one response.

### Charlotte Dr — OG clean
- T0 anchor attempt 1, verified. Confidence `low` honestly flagged
  (all-bigger bracket). Anchor + bounding support both visible.

## Improvement candidates (for whichever harness ships)

0. **Don't sleep on median-priced comps as ARV substitutes.** When no
   renovated/ARV-tier evidence exists, median-marked comps are a real
   answer — B already accepts them as drivers and prices the uplift
   (Coles Creek ran on median drivers). But the serve layer still
   treats "no AR evidence" as insufficient → AVM floor (Camp Ground:
   rescued median driver verified $199,922, AVM $161,145 served).
   Fix: a verified median-driven answer should serve as a labeled
   "ARV estimate from median comps" (low conf), not fall to the floor.

1. **The size grid shouldn't zero the pocket.** A comp 600sf smaller is
   evidence — that's what the size adjustment exists for. Options: let
   the filter ladder widen sqft (v2's approach), or drop hard sqft at
   the grid and let contribution math + verification handle it.
2. **Pocket-implied beats AVM floor when it has depth.** T2 had 28
   same-tract sales ($267/sf) yet the pipeline served the AVM
   ($313,966 vs $418,562). When T2 is well-supported it is *market*
   evidence — the fallback order should prefer it over a model floor.
   At minimum: don't serve two different numbers in one response.
3. **Bracketing is honest but could guide retry.** all-bigger means the
   pool overshot the subject's size — a widen step toward *smaller*
   comps would fix the bracket, not just flag it.
4. **Verify-vs-serve transparency.** "attempt 1 — verified" vs Dunseath's
   3-attempt unverified trail is good signal; surface it consistently
   (attemptTrail exists in bMechanics — does the report show it?).
5. **e2e script stale asserts** — jevHybrid/userOverrides blocks; also
   the comp-tier PUT mutates the saved report. For A/B cleanliness a
   read-only compare mode would help.

## How v2 won Dunseath (mechanism)

Ladder ran step 0 inside the tract — **1956 Main St (1,242sf, $419,900)
passed strict sqft (324 < 500)**; OG killed it only on the subdivision
string compare. Name-geo rank-only admitted it, enrichment vouched its
price group, contribution = $419,900 − ~$40k land + ~$22k size →
$402,294 anchor, attempt 1 verified. Bolton $1.6M stayed out: lot rule
still hard + lone-outlier can't vouch itself into the top price group.

**Transferable to OG, ranked:**
1. Kill the string-match veto inside a proven tract — surgical, no
   ladder needed. (Main St, 2060 Claude, 2233 Rando all died on names.)
2. Sqft is repricable, not a veto — 5 comps failed on sqft alone; the
   marginal-rate math already handles size gaps.
3. Keep physical-truth rules hard (lot, type, road) — that's what
   stopped the $1.6M outlier.
4. Serve the deeper floor — T2 pocket-implied ($418,562, 28 tract
   sales) should outrank the AVM when it has depth. Don't serve two
   different numbers in one response.
5. Lone-outlier rule: one sale far above the pocket is noise unless a
   flip/confident read vouches it.

### URAR ceiling codified (`fe5ca5f` area commit)
- A comp needing >25% total adjustment — measured by whichever engine
  asks most (grid totalAdjustment OR our marginal size+land reprice vs
  its sale) — is now a **bound, not a driver**. Stays in the evidence
  pool and the outlier ceiling; can't anchor or support. Proof in
  set-b-tricks.test.ts.
- This is the appraiser rule we distilled: reprice marginally (size
  taper 50/40/30, land ladder ±20%), then judge — >25% total adj =
  different product, use it as a bound and find better evidence.

### Band spec (owner decision)
- Curve: **renovated → maintained → dated/distressed** (dated top of the
  bottom band, severe distress at its bottom). One member = a band.
- `bConditionClass`: curb read votes; sale label corroborates;
  unlabeled → maintained.
- Carrier cascade: renovated → maintained (replaces ARV when no flips
  exist — not a confidence penalty, it's what the pocket is) → dated
  pocket picks the **best curb-rated** sales → distressed last.
- Don't optimize for unseen pockets; iterate on real runs.

## Watch list for next runs

- Does OG's anchor land where v2's ladder lands when evidence is dense?
- Does v2's price-group ARV class match OG's tier discipline on flips?
- Any address where OG withholds but v2 answers — is v2's answer
  defensible or a stretch?
