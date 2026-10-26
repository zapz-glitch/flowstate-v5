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
