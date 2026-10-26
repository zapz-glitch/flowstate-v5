# Satellite site reads — Clef go/no-go test (2026-10-25)

Plan step 1 for adding satellite lot reads to the B harness (code decides; Clef supplies facts).

**Set:** 20 lots from saved reports (comps that earlier Decisions reads called waterfront /
corner / large lot / exposed / plain). Esri World Imagery, wide (~600 m) + close (~180 m) tile,
same as `fetchSatelliteTile`. Labels by Claude from the images; owner spot-check pending.
Lot 11 dropped (map pin lands in woods). Lots 7 and 19 are low-confidence labels.

| Reader | Waterfront y/n | Busy road / commercial y/n | Large lot y/n | Premium (one pick) | Time |
|---|---|---|---|---|---|
| **clef-flash** | **19/19** | **19/19** (choice question) | 14/19 | 13/19 | ~1.3 s |
| clef (27B) | 19/19 | 17/19 | 17/19 | 10/19 | ~1.2 s |
| Past Decisions reads | — | 18/19 | — | 10/19 | — |

Findings
- Waterfront and busy-road/commercial exposure are reliable on clef-flash. Exposure **side**
  (front/back/side) is not — use yes/no only.
- Pool and large lot are unreliable from aerials. Use data instead: ATTOM `pool`, and lot size
  vs the comp pool's median (`lotSizeAcres`) in code.
- Corner/cul-de-sac is untested: none of the 4 "corner" candidates were corners. Needs more lots.
- Past Decisions premium reads were wrong on ~half: 4 false "waterfront" (golf, creek, park), 3 false "corner".
- Esri returns HTTP 500 on the 640 px close-up in parts of Phoenix; 512 px works. `fetchSatelliteTile`
  should retry at 512.
- 2–3 of 20 map pins don't sit on the house; reads on those lots are noise either way.

## Owner spot-check round 1

- Lot 16 (5347 N 2nd Dr): **backing** commercial, not siding (house faces the private drive).
- Lots 15 and 20 (94th Ave, Seminole): **fronting** — 94th Ave is a double-yellow through road.
  My question had told Clef "two-lane streets don't count"; reworded to "a road with a painted
  center line counts; only quiet streets with no center line don't."
- Lots 12 and 13 confirmed as labeled.
- OpenStreetMap tags 94th Ave `highway=residential`, so map road class would also miss it.

Re-run with corrected labels + reworded question (busy road / commercial, yes/no):

| Reader | Exposure y/n | Misses |
|---|---|---|
| clef-flash | 17/19 | lot 1 false alarm (golf course edge), lot 15 missed (score 0.40) |
| clef (27B) | 18/19 | lot 4 false alarm (street + park behind) |

Small sample, single labeler. Decision: proceed with clef-flash for **water** and **exposure** only.

## Round 2 — pins and pools

- Lot 5 (7462 Water Silk Dr): owner confirmed **backs water AND has a pool**. One "pick the
  strongest premium" answer can't hold both, so every attribute becomes its own yes/no.
- ATTOM `pool` is blank on 4 of 5 lots that visibly have one. Can't rely on it.
- Pool yes/no from aerials: clef-flash 12/19, clef 14/19 — screened pools are hard from above.
  Pool should come from the listing (description/features + listing photos), aerial as a backup.
- Map pins: ATTOM's pin is >15 m off the house on 6/20 (7470 Thoreau 58 m — owner confirmed
  the real house is beside the image center). Geocodio returned `rooftop` on 18/20; its two
  `range_interpolation` answers were 65 m and 118 m off. None of our Google keys can geocode yet
  (API not enabled / referer-locked / billing off).

## Build + first end-to-end (2026-10-26)

Shipped on `feat/b-harness-site-reads`:

- **Reader** `apps/api/src/services/site-read` — Geocodio rooftop pin only
  (else unknown) → Esri aerials (640 → 512 → USGS) → clef-flash water,
  clef 27B busy road → KV cache by pin. Pool: MLS field → description
  (shared pools stripped) → pool permit → county field. No aerial pool.
- **Cutoffs** (from the 19 lots): water yes ≥0.60, no ≤0.30; busy road
  yes when 27B NEUTRAL ≤0.30, no when ≥0.45; between = unknown.
- **Set-B trick 12** (`og-2026.10.26.1`): when the pool holds a
  site-matched comp that can carry an ARV, comps that differ on water or
  busy road step down to bounds — seat (agent) picks included. Pool
  differences only rank lower (−1 similarity). Unknown never excludes.
- Saved reports carry `site` on subject + comps; API and dashboard recalc
  replay it. `SITE_READS_ENABLED=false` turns the reads off.

Tests: 6 unit (site match) + 4 unit (reader) + 1 integration, full API
suite 46/46, snapshot replay 11/11 with 0 drift.

### E2E — 7462 Watersilk Dr N, Pinellas Park (job_1792992726782_5d104f9a1c754520)

- Subject read: waterfront **yes**, busy road **no** — matches owner label.
  Pool came back unknown → fixed: the subject's permit "Pool/att spa/deck/gas"
  now reads as pool (owner label: has a pool).
- Comps: 26/28 read (2 were $100 sales outside the candidate set).
  waterfront 6 yes / 17 no / 3 unknown; busy road 6 / 17 / 3.
- Comp pool: unknown on all — the default harness pulls no comp listings,
  ATTOM pool blank. Pool rule is a no-op until comp listing text exists.
- Site reads cost ~17s cold inside `set_b_arv` (cached after).
- **Bug found:** the agent seat named one inland comp (7253 Bryce Pt) as
  sole driver; the rule only filtered inside the seat's picks, so it just
  flagged. Fixed by applying the site check to the driver pool before the
  seat picks are honored.
- Replay of the saved run through the fixed code: ARV **$1,173,719 →
  $1,531,041** (low confidence, one driver: 7394 Kindal Pt, waterfront,
  same subdivision, 0.09 mi, $1.675M at 4,510 sf). 8 comps dropped for
  water/busy-road mismatch. **Needs owner check** — the water reads on
  the dropped Bayou Club comps decide this swing.
