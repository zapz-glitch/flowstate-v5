# UI Smoothness and State Audit

Branch `UI10-5-2026` · 2026-10-05 · read-only audit, no code changed for it.

Sources: my own browser measurements, plus three code sweeps (page loading, open/close motion, page states).
Items marked **(checked)** I verified myself in the browser or in the code. The rest come from the code sweeps and read as likely, not proven.

Tags: **[UI]** presentation only, inside our scope. **[WIRE]** touches data fetching, caching or handlers, outside our UI-only scope, needs your OK. **[THEME]** changes tokens or the look of shared primitives, needs your OK.

---

## 1. What I measured (checked)

Sidebar click to settled page, dev server, light theme:

| Page | What you see while it opens |
| ---- | --------------------------- |
| Property Search | route skeleton, then spinner, then a second skeleton, then "Restoring…" text, then content. About 0.7 to 0.9 s, four different loaders in a row. |
| Evaluation Settings | route skeleton, then a spinner inside the tab, then content. Two loaders. |
| Property Reports | table skeleton for about 0.3 s, then content. One loader, fine. |
| Overview | "Loading…" text in the cards for about 0.12 s, then content. |
| Tasks | "Loading…" text for about 0.02 s. |
| Offers, Analytics | not measurable here (my write-block stalls their POST data); read from code instead. |

Map and dialogs, Property Search:

| Action | Result |
| ------ | ------ |
| Hover a marker | panel appears after about 0.1 s, fades in over 0.15 s, no dropped frames. |
| Move away from the marker | panel vanishes instantly after its delay. No fade-out. |
| Click a comp card | **about 0.4 s of nothing**, 2 slow frames (up to 113 ms), then the dialog fades in over 0.17 s. |
| Close the comp dialog | vanishes instantly. No fade-out. |

Also checked in code: no `error.tsx` or `not-found.tsx` anywhere; no `prefers-reduced-motion` anywhere; the three overlays in the report page are drawn only while open (`{open && <Dialog/>}`), which kills their exit animation; the comp dialog is loaded on demand with no preload; Reports shows "Loading..." forever when its fetch fails; Settings has a Delete Account button that only shows an alert.

---

## 2. Why Offers feels smooth and the rest do not

Offers is the one page built for it. In plain words:

1. **Remembers its last list** for 30 s, so coming back paints the list on the first frame, with no spinner.
2. **One request instead of several**, and two callers share one in-flight request.
3. **Preloads the report** when you hover or click a row, so the next page has nothing to wait for.
4. **A short cover** (about 0.3 s fade) hides the page swap, so it reads as a crossfade.
5. It keeps updating quietly every 5 s.

Nothing else uses any of this. Overview, Tasks, Analytics, API Hub and Settings refetch from scratch every visit and each shows its own placeholder. Reports refetches behind a skeleton. Property Search restores your last search from storage and then fetches again.

Counted: about 9 different loading styles and about 7 different caching patterns. The same cache, timer and dedupe logic is written by hand three times (Offers queue file, Analytics page, shared fetch helper). Several screens fetch the same data twice (user profile, UI preferences, tasks, API keys).

---

## 3. Open and close motion

| Finding | Tag |
| ------- | --- |
| Comp details dialog, Evaluation Settings panel and Share dialog are drawn only while open, so they **cut out instantly** even though they have exit animations. Its sibling history panel is always mounted and works. **(checked)** | UI |
| Hover panel: no pause before it opens (sweeping across markers opens and swaps it repeatedly), no fade-out. **(checked, close)** | UI |
| Map markers carry a `title`, so the browser's own tooltip shows beside our panel. **(checked)** | UI |
| First click on a comp waits for the dialog's code to load. Preload it on first marker hover or when idle. | UI |
| Hovering a comp card re-renders the whole page and rebuilds the icon of every map marker. The icon work is the likely source of hover jank. | UI (state placement) |
| Dialog image is a second Street View request at a different size than the card's, so it is not a cache hit. Lightbox renders every photo at full size on open. | UI |
| Marker stays amber after the dialog closes. | UI |
| Sidebar collapse animates width and page padding every frame for 0.3 s, labels pop in and out. | UI |
| Sheet panel takes 0.5 s but its dark backdrop snaps in at 0.15 s. | UI |
| No shared motion values. Durations used: 150, 200, 300, 500 ms plus 0.5 s and 0.6 s keyframes; `transition-all` appears 29 times. | UI + THEME |
| Nothing respects "reduce motion". | UI |

---

## 4. States: loading, empty, error

| Finding | Tag |
| ------- | --- |
| Reports list: a failed fetch renders `Loading...` forever. **(checked)** | UI + WIRE |
| Report detail: every failure, including network errors, says "Report Not Found". | WIRE |
| Settings: if preferences fail to load, the page proceeds with blanks, and the next Save overwrites the saved ones. Data-loss risk. | WIRE |
| Settings: Delete Account only shows `alert('...not yet implemented')`. **(checked)** | WIRE |
| Evaluation Settings: two config loads silently fall back to defaults, so a user can save over real settings without knowing the load failed. | WIRE |
| Tasks: a failed load looks like "No tasks yet." A failed create shows nothing. **(checked, load)** | WIRE |
| Analytics and API Hub Usage: a failed load leaves "Loading…" or a spinner forever. | WIRE |
| About 10 places swallow errors with `catch(() => {})`. About 13 different error banners; only Overview has an alert role and a retry. | UI + WIRE |
| 12 or more different empty states; none has a next action. | UI |
| Loading screens exist for 6 routes only. Overview, Offers, Tasks, Analytics and API Hub have none. | UI |
| Skeletons that do not match their page: Evaluation Settings (no tab strip), Reports (extra eyebrow line, no mobile version), Report detail (own title and wrong back link), Settings. | UI |
| Spinners and "Loading…" have no `role="status"`. | UI |

Headers: API Hub and Settings still do not use `PageHeader`. Settings is also the furthest from the type scale and tokens (about 94 raw colors, no tokens).

Standards drift, counted by the sweep: Evaluation Settings alone has about 124 text sizes under 12 px; Offers, Analytics and the report page use 9 to 11 px labels; about 69 of 135 files use hard-coded palette colors.

---

## 5. Proposed standard (one kit, used everywhere)

**Opening a page**
1. Every route gets a `loading.tsx` whose skeleton matches the real layout (same header, same row heights), built from one `PageHeader`-based skeleton.
2. One loader per page: the route skeleton. No spinner or "Loading…" text on top of it.
3. Pages that fetch on the client paint their shell and skeleton immediately and swap in data without moving anything.
4. Later, one shared warm-cache pattern based on Offers (see Wave 3).

**Opening and closing components**
1. Overlays stay mounted and use their built-in enter and exit. Panels that are drawn on demand get a short fade-out.
2. Motion values come from three tokens: fast 150 ms, base 200 ms, slow 300 ms, one ease. Backdrop and panel share a duration.
3. Hover panel: about 150 ms intent delay before opening, fade in and out, no browser tooltip.
4. Everything stops animating under "reduce motion".

**States** (new shared components)
- `LoadingState` (small spinner or text, `role="status"`, fixed min height).
- `SkeletonRows`, `SkeletonTable`, `SkeletonStat`.
- `ErrorState` (says what failed and the cause, a Retry button, no apology, `role="alert"`).
- `EmptyState` (title, one line, a real next action, no big icon).
- `InlineStatus` for saving, saved, copied (plain text, no pills).

---

## 6. Fix plan, in order

**Wave 1 · UI only, small, high payoff.** Fix the felt clunk first.
1. Keep the three report overlays mounted so they fade out.
2. Hover panel: intent delay, fade-out, remove marker `title`.
3. Preload the comp dialog code on first marker hover or idle.
4. Update only the previous and next marker icons on hover (cache icons).
5. Clear the amber marker when the dialog closes.
6. Reports error text: replace "Loading..." with a real error state.

**Wave 2 · UI only, the shared kit.**
1. Build `LoadingState`, `EmptyState`, `ErrorState`, `InlineStatus`, skeleton variants.
2. Add `loading.tsx` for Overview, Offers, Tasks, Analytics, API Hub; fix the four mismatched skeletons; one loader sequence on Property Search and Evaluation Settings.
3. `PageHeader` on API Hub and Settings; move Settings to tokens and the type scale.
4. Replace the ad-hoc empty states and banners page by page.

**Wave 3 · WIRING, needs your OK.**
1. One shared warm-cache hook modeled on Offers, replacing the three hand-written copies, then used by Overview, Tasks, Analytics, Reports, API Hub.
2. Remove the duplicate fetches (user, UI prefs, tasks, API keys).
3. Hover-prefetch for sidebar links.
4. Stop swallowing errors and the data-loss paths: Settings prefs overwrite, Evaluation Settings default fallback, Tasks, Analytics, Usage.
5. `error.tsx` / `not-found.tsx`; Delete Account stub; report detail error messages; the `viewInflight` key bug in Analytics.

**Wave 4 · THEME, needs your OK.**
1. Card corners 12 px to the theme's 6 px; buttons from full pills to the theme radius.
2. A 12 px text floor, removing the 9 to 11 px sizes.
3. Semantic color classes (success, warning) in place of raw emerald, amber, red, blue.
4. Motion tokens and the reduced-motion rule in the config and global CSS.

---

## 8. Status: Waves 1 and 2 (2026-10-05)

Approved by the user: Waves 1 and 2 only. Waves 3 and 4 not started.

### Done and verified in the browser
Wave 1
- Comp dialog, Evaluation Settings panel and Share dialog stay mounted, so they fade out. Measured: close was instant, now fades over about 0.18 s.
- Hover panel: opens after a 140 ms pause, fades in and out (close was instant, now about 0.13 s). Comp markers no longer show the browser tooltip.
- Comp dialog code is preloaded when the browser is idle. First open: 0.44 s before anything showed, now about 0.23 s. Second open: about 0.07 s.
- Map markers: hovering a card now updates only the two markers that change, with icons built once.
- The amber marker clears when the comp dialog closes.
- Reports: a failed fetch now shows "Couldn't load your reports" with a Try again link, instead of "Loading..." forever.

Wave 2
- New shared kit: `ui/states.tsx` (`LoadingState`, `EmptyState`, `ErrorState`, `InlineStatus`) and layout-shaped skeletons in `ui/skeleton.tsx` (`SkeletonPageHeader`, `SkeletonRows`, `SkeletonTable`, `SkeletonStat`). All announce themselves to screen readers and stop animating under reduced motion.
- Loading screens added for Overview (shared dashboard default), Offers, Analytics, Tasks, API Hub. Fixed to match their pages: Evaluation Settings (now has the tab strip), Reports (no eyebrow, has a phone version), Report detail (no wrong title or back link), Settings, Property Search (no visible text).
- One loader per page: inline "Loading…" text and spinners replaced by matching skeletons on Tasks, Analytics, Offers, Overview (recent requests), the three API Hub tabs, and the five Evaluation Settings tabs. Property Search's "Restoring your last report" now uses the same skeleton instead of a spinner.
- Empty states moved to `EmptyState` (no big icon, a next step where one exists): Reports, Tasks, Offers, Analytics. Internal wording removed from the Analytics one.
- API Hub and Settings now use `PageHeader`. Settings moved from 94 hard-coded neutral and red colors to theme tokens and the type scale (same sizes), its Danger Zone icon was removed, and its Menu Bar card now reserves its space while loading.
- Tab strips scroll inside themselves on narrow screens (fixes the sideways page scroll on API Hub and Evaluation Settings at phone width).

### New finding (not fixed, needs your OK)
`cn()` (the class-merge helper in `lib/utils.ts`) silently drops a custom type size such as `text-caption` or `text-body-sm` whenever a color class like `text-foreground-tertiary` follows it, because it treats both as text colors. About 29 spots in 12 files lose their intended size this way (Overview, API Hub tabs and others). The fix is one small change that teaches the helper about the custom sizes, but it will change how those spots look (they will shrink to the size their authors wrote), so I did not apply it. My new components avoid the problem.

### Not done from Wave 2
- Replacing the 6 copy-pasted red/green banners in Evaluation Settings with `ErrorState` and `InlineStatus`.
- Overview: the Monthly Usage and Rate Limits cards still pop in when data arrives (their space is not reserved).
- Property Search still shows the idle header and search card for a moment before the restored layout replaces them.
- Hover on the moved deal buttons (same styles as before).

### Found, belongs to Wave 3 (data fetching), untouched
Silent failures that look like empty or loading: Tasks, Analytics, API Hub Usage, Settings preferences (overwrite risk), Evaluation Settings default fallback; report detail says "Report Not Found" for every error; Delete Account is a stub; Offers and Analytics failed-fetch states have no retry.

### Found while writing the tests (2026-10-05)
- **Fixed:** `formatShortDate` showed a date-only value (a sale date such as "2016-04-14") one day early in US time zones, because it was read as UTC midnight and shown in the viewer's zone. My screenshots missed it because the test browser runs in UTC. Date-only values now format as UTC; timestamps still show in the viewer's zone. Covered by a unit test across six time zones.
- **Same pattern, not fixed:** the print table in `ComparablesSection` formats `comp.saleDate` with `new Date(...).toLocaleDateString` (month and year only, so it only shows near a month boundary), and Overview formats `usage.resetDate` the same way ("resets Oct 31" may read a day early). Both are worth moving to the shared formatter.

---

## 7. Open questions

1. Start with Wave 1 and 2 now (all UI only)?
2. May I touch data fetching for Wave 3, or do you want that handed to whoever owns the data layer?
3. May I change the shared theme items in Wave 4?
