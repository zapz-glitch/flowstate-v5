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

Small sample, single labeler. Decision: proceed with clef-flash for **water** and **exposure** only.
