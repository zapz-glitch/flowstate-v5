# UI Screenshot Review

Companion to `UI-10-5-2026.md`. Every UI change on branch `UI10-5-2026` must
pass this gate, using screenshots of the running app, before it is called done.

## Visual acceptance gate

- [ ] hierarchy immediately understandable
- [ ] primary information dominates secondary information
- [ ] typography consistent
- [ ] spacing rhythm consistent
- [ ] alignment precise
- [ ] component density appropriate
- [ ] no unnecessary pills
- [ ] no unnecessary icons
- [ ] no decorative UI noise
- [ ] prices / property facts immediately scannable
- [ ] classifications visually distinct
- [ ] photographs given appropriate prominence
- [ ] no text truncation
- [ ] no accidental wrapping
- [ ] no overflow
- [ ] hover states verified
- [ ] selected states verified
- [ ] dark/light theme verified if applicable
- [ ] desktop verified
- [ ] narrower viewport verified
- [ ] screenshot reviewed after implementation

## Screenshot tool (verified working 2026-10-05)

```
cd /tmp && LD_LIBRARY_PATH=$HOME/.local/lib/playwright-deps \
  node ~/code/ui-snap.js <path> <name> <light|dark> <width> <height>
# example: ... /dashboard/analyze before dark 1440 900
```

- Output: `~/code/ui-shots/<name>-<theme>-<width>.png` (outside the repo).
- Signs in through the API, blocks every write call (so the report page cannot
  autosave), hides the Next.js dev badge, and prints the final URL, theme,
  blocked-write count, and whether the page overflows sideways.
- Check the printed URL. If it is not the dashboard path, the sign-in failed.
- Servers: dashboard `localhost:3100` (this branch), API `localhost:8787`.
- Known issue: `/dev-login` double-encodes the session cookie, so it lands on
  the landing page. Not fixed here (backend side, off limits). The script
  signs in directly instead.

## How to use

1. Take a **before** screenshot of the real page (`http://localhost:3100`, writes blocked).
2. Implement. Take an **after** screenshot.
3. Walk the gate above against the after screenshot. Fix, then screenshot again.
4. Copy the template below into the log. Mark each box. Any unchecked box needs a reason.

## Review template

```
### <date> — <component / page>
Screenshots: before <path> · after <path> · narrow <path> · dark <path>
Requirement:
Defects found:
Fixed:
Gate: <n>/21 checked. Unchecked and why:
```

## Review log

Newest first.

### 2026-10-05 — Decisions on four review findings
Screenshots: `hdr-batch-light-1440`, `hdr-cdarv-light-1440`, `hdr-seo-light-1440`
1. Same title-only header on every dashboard page (decided): Batch Import, SEO Engine, CDARV, Admin Panel, User Management, Observability and API request detail now use `PageHeader`. Subtitles are gone; useful values moved to the right side (user count, request time). Not changed: the two record-detail headers (a user's name with email and join date; a run's address with status and job ID), which carry data, not a section title.
2. Existing Reports dialog on Property Search now stays mounted after first open, so it fades out like the settings panel and comp dialog (decided).
3. Comp rules stay removed from the page entirely (decided).
4. Street View: the photo on the subject card and the subject card in the hover panel now open Street View in a new tab, as the comp cards already did; the comp details dialog photo already did (decided; the map has no Street View button).
Verification: unit 21 pass for the touched files and the whole suite passes; end-to-end 26 of 26, twice in a row.
Not verified in a browser: Admin Panel, User Management and Observability. The local test user is not an admin and is redirected, so those three were checked by type check and lint only. The CDARV page lost its "Experimental / Shadow" label and the note that production underwriting is unaffected.

### 2026-10-05 — Comp rules off the subject card, one-row buttons, costs line into the valuation header
Screenshots: `after10-search-{light,dark}-1440`, `after10-search-light-1100`, `after10-search-light-390`
Requirement: remove the comp rules from the subject card; the five deal buttons in one horizontal row; move "Close / Carry / Invest / Wholesale" into the valuation header, right-aligned (Close left, Wholesale right); drop List from it (it is already the List tile).
Done: rules line and its plumbing removed (the comp rules are no longer shown anywhere on the page); `DealActions` is back to a single row (stacked mode removed); the costs line is in the valuation header at the right; the footer is gone, so the map and tiles gained its height.
At 1100px wide the card is too narrow for five buttons in one row (about 395px needed, 343px available) so they wrap to two lines there; at 1440 they are one row.
Tests: unit (SubjectGridCard, DealActions) updated; e2e adds "five buttons are one row", "no comp rules line", "valuation header carries the costs, right-aligned, List not repeated". 116 unit and 21 e2e pass.
Gate: 20/21 (hover on the buttons unchanged).

### 2026-10-05 — Tests and push
Verification: types clean, lint clean, unit 19 files / 116 tests passing, end-to-end 19 of 19 passing against the branch dev server. Mutation check: with the original instant-close dialog behavior put back, the end-to-end fade test fails; with the fix it passes.
Found by the tests: sale dates one day early in US time zones (fixed).
Not covered by automated tests: the hover panel's 140 ms open pause (timing too tight to assert reliably), the Reports error state (a server-side failure cannot be triggered from the browser), live Google Maps controls (do not render in the test browser).

### 2026-10-05 — Smoothness plan, Waves 1 and 2
Screenshots: `w2-*`, `preview-*` (temporary preview page, deleted), `loading-*`; measurements from `interact.js` / `nav.js` / `wheel.js`
Requirement: approved Waves 1 and 2 of `UI-SMOOTHNESS-AUDIT.md` (UI only).
Measured before to after: comp dialog close instant to 0.18 s fade; hover panel close instant to 0.13 s fade, 140 ms open pause; comp dialog first open 0.44 s to 0.23 s (second open 0.07 s); Evaluation Settings opening shows one loader instead of two; Property Search opening has no spinner in its sequence.
Defects found while verifying: shared `cn()` drops custom text sizes (reported, not changed); the kit's first version lost its caption size to it (fixed in the kit); the tab strips overflowed sideways on a phone (fixed).
Row-jump scroll re-tested after the changes: unchanged, rows land 8 px under the bar.
Gate: 18/21. Unchecked: hover on moved buttons; dark mode of every new skeleton (checked Settings, Tasks, API Hub only); error state shown live (rendered in a temporary preview, not triggered by a real failure).

### 2026-10-05 — Comp rules on the same row as the deal buttons
Screenshots: `after8-search-light-1440`, `after9-search-{light,dark}-1440`, `after9-search-light-1100`, `after9-search-light-390`
Requirement: comp rules on the same row as Prep offer.
Done: the foot of the subject card is one strip: comp rules on the left (two lines), the five buttons on the right (two lines: Prep offer / No margin / No offer, then Re-run / Evaluation Settings). All five buttons cannot share one line with the rules in a 545px card, so each side wraps to two lines.
Defects found: at 1100 wide the rules column got too thin and broke mid-phrase; "Year Built" touched its value.
Fixed: the rules column has a minimum width, so on a narrow card it drops to its own line above the buttons; added a gap in the stat rows.
Gate: 20/21 (hover on moved buttons unchanged).

### 2026-10-05 — Comp rules into the subject card, Condition under Sq Ft
Screenshot: `after7-search-light-1440`
Requirement: comp rules inside the subject property box, beneath its content; Condition value in the Sq Ft column.
Done: the rules are their own row inside the card, above the actions row, left-aligned. Condition now starts under the Sq Ft label and its value follows the label, so "Light Cosmetic" sits under the Sq Ft column and is not cut off.
Gate: 20/21 (hover on moved buttons unchanged).

### 2026-10-05 — Action buttons right, comp rules bottom-left, Property Search empty-state header
Screenshots: `before-idle-light-1440`, `after-idle-{light,dark}-1440`, `after-idle-light-390`, `after6-search-{light,dark}-1440`, `after6-search-light-1100`, `after-expanded-light-1440`
Requirement: all five deal buttons on the right; comp rules bottom-left under the subject card; replace the "/v1/analyze" card header (icon tile + subtitle) and the idle hero with title-only headers matching the other menu pages.
Done: one right-aligned row (Prep offer, No margin, No offer | Re-run, Evaluation Settings); "Comp rules" line sits left under the subject card, one line at 1440; empty state is `PageHeader` "Property Search" plus the input card with no header; when a property is loaded and the search card is expanded, its header is the plain title "Search an address" with the collapse arrow.
Removed: the eyebrow "Flowstate | Property underwriting", the line "Search an address. Underwrite the deal.", the icon tile, "/v1/analyze", "Property details, comparables, and valuation".
Verified: empty-state title lines up with the other pages (y≈34); wheel row-jump still lands every row at 8px under the bar (313, 661, 1010 …; up returns to 0); no sideways scroll at 1440/1100/390.
Gate: 20/21. Unchecked: hover on the moved buttons (same styles).

### 2026-10-05 — Subject card compaction, deal actions, rules placement
Screenshots: `after4-search-light-1440`, `after5-search-{light,dark}-1440`, `after5-search-light-{1100,390}`
Requirement: tighten the subject card; put Prep offer / No margin / No offer / Re-run / Evaluation Settings on it; move the comp rules to the right of the All/ARV/Median/Investor row.
Done: header copies the comp card's two lines (address + price, area + price label); last sale is one line; Condition spans two columns (no more "Li…"); address shown without ZIP so it no longer cuts off; thumbnails smaller; gaps tightened; an empty construction line no longer leaves a gap. Actions are a strip across the foot of the card (decisions left, Re-run and Evaluation Settings right) and were MOVED from the valuation header, not copied. Comp rules sit at the right end of the tier row, wrapping to two lines.
Measured: card details about 43px shorter (281px before; 268px now including the new 30px actions strip). Wheel row-jump re-tested with the taller comps bar: still lands every row at the same spot.
Gate: 19/21. Unchecked: hover states on the moved buttons (same styles as before, not re-checked), phone: the valuation box is clipped by its fixed-height column (was already so). Open: SUBJECT badge in dark mode.

### 2026-10-05 — Comp list scroll: one notch = one row
Screenshots: `wheel-before`, `wheel-mid`, `wheel-final` (1440); measured scroll positions at 1440 (2 columns) and 1100 (1 column)
Requirement: the jump that lands on the first comp row must repeat for every row, down and up, through the whole comparable section.
Before: notch 1 jumped to row 1, then each notch crept 56px.
Defects found: the glide stalled 2px short of its target (the browser rounds scroll positions). The first row's own stop sat 24–41px from the comps-header stop.
Fixed: stops now exist for every row of cards, flush under the pinned comps bar; the glide moves at least 1px a frame; the comps-header stop covers row 1.
Result: 1440 rows land at 306, 679, 1028, 1376 … (about 348px apart, gap under the bar 8px every time); 1100 rows at 439, 883, 1286 …; eight notches up returns to 0. At the very bottom the last notch up moves only the remaining distance.
Gate: 17/21 (hover/selected states and print: not touched; theme: light only, no visual change in dark). Open: trackpad and touch still scroll freely by design.

### 2026-10-05 — Property Search round 2 (map buttons, comp rules, hover cards)
Screenshots: `after3-search-*` (light 1440/1100/390), `before-hover-light`, `after-hover-light`, `after2-hover-dark`
Requirement: remove map buttons (keep legend, bottom-right zoom, full screen; right-click exits full screen); move the comp-rules line above the comps with a title; make the subject card in the hover panel identical to the comp card.
Defects found: right-click handler first compared the wrong element (full screen element is not the map div) and never fired; fixed and re-tested. Subject card differed from comp card: no copy button, no Price/delta slots, Tract instead of Sold, "Sf" capitalised, address cut off, unequal heights.
Fixed: both cards now use one shared set of pieces (`property-card-parts.tsx`), same six fact rows, equal height, same address style.
Gate: 19/21. Unchecked: hover states on the map controls (none left), Google's own zoom/full-screen buttons did not render in the test browser (they did not before either), so I could not see them. Open: SUBJECT badge on the main card in dark mode.

### 2026-10-05 — Property Search cleanup (subject card, permits, map)
Screenshots: before `before-search-*` · after `after-search-*` / `after2-search-*` (light 1440, dark 1440, light 1100, light 390, toggle states)
Requirement: drop the duplicate Meadow Brook pill; move the comp-rules line to the bottom-right of Permits; left-align the permit photo with "Permits"; remove the Street View button and give its space to the map; flag redundancies; valuation box tips only.
Defects found: broken photos left zero-width thumbnails that still took flex gaps (photo sat 24px right). On a phone, the map already overflowed onto the valuation header (not caused by this change).
Fixed: failed photos are now dropped from the gallery (photo aligns at x=1111, same as "Permits"). Map controls float on the map at 1024px+ and stay a bar above it below that.
Gate: 19/21. Unchecked: no text truncation (address and Condition still truncate; flagged, not changed), photographs on the permit row (n/a). Open: 8 marker partly under the toolbar; phone map overlap.

### 2026-10-05 — Page headers (Overview, Reports, Evaluation Settings, Tasks, Offers, Analytics)
Screenshots: before `~/code/ui-shots/before-*` · after `after-*` / `after2-*` (light 1440, dark 1440, light 390)
Requirement: title only, buttons stay, remove unhelpful info.
Defects found: Offers/Analytics titles sat ~8px above the sidebar logo line (band top padding dropped). Evaluation Settings overflows sideways at 390 (tab row, not the header).
Fixed: restored band top padding; titles now line up at the logo line.
Gate: 18/21 checked. Unchecked: hover and selected states (header has none; buttons unchanged), photographs (n/a). Open: Evaluation Settings tab row at 390.
