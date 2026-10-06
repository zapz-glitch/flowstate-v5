# National Design Studio: what we can learn, and a prototype

Updated 2026-10-06 (third pass). Sources: ndstudio.gov (four pages), TrumpRx.gov (home and its listing page), Realfood.gov and techforce.gov, each loaded in a browser. Values below were read from the sites' own computed styles and stylesheet, not estimated from pictures. Nothing here copies their files.

## What the studio is

The National Design Studio is a White House office (formed August 2025, led by Chief Design Officer Joe Gebbia). It redesigns high-traffic federal sites. Its stated aim: less friction ("months reduced to minutes") and standard, trustworthy design.

## The themes (four sites, one family)

| Site | Surface and ink | Type | Controls |
| ---- | --------------- | ---- | -------- |
| ndstudio.gov | flat `#f2f2f2`, ink `#010101`. No cards at all | PP Neue Montreal: 450 for body and headings, 530 for 12 to 14px captions, 700 for display lines. `-0.02em` on 44px headings; text at 14px and under is never tightened | plain text links with an arrow; the current nav item is underlined; no rounded controls on show |
| TrumpRx.gov | warm cream `#f5f4eb`, ink `#333334`; cards are a slightly darker fill, no border | three faces: a serif for display, Geist for body (400 to 500), Geist Mono in sentence case for a few small facts. 16px text is tightened a little (`-0.015em`) | 36px buttons, 6px radius: a filled ink primary, two outlined nav buttons at about 50% ink (repeated in-card outlines are 15%), and a segmented control whose active segment is a solid ink fill |
| Realfood.gov | warm black `#110000`, cream `#fdfbee`, hairlines at 20% | a heavy grotesque at 700 throughout, even 14 to 24px text; one monospace capitals line (the "official website" banner) | pills |
| techforce.gov | near-black `#0a0a0a` with near-white type and one orange panel | **Inter** (the typeface this app ships): 500 for headings, tightened hard (`-0.075em`), 400 for body | 6px radius, 40 to 48px tall |

## What they have in common

1. **A quiet canvas and one ink.** Near-black on a neutral or warm surface, or the reverse. Color is kept for meaning.
2. **Few weights, and small text left alone.** Two of the four sites use one family. Body and headings are close in weight on three of them. Nothing at 14px or under is tightened on any.
3. **Hairlines in two strengths** on ndstudio.gov: 10% ink for inner lines, 20% for section rules. Little shadow.
4. **Clear button levels.** A filled ink primary, outlined secondaries, plain text for the rest. The selected item in a group is a solid ink fill.
5. **Plain words.** Labels are ordinary sans. Monospace is rare and mostly sentence case.
6. **Quiet motion.** About 150 ms by default, mostly ease-out.

## What my first two passes got wrong

Two rounds of independent review (six readers and three skeptics, then five checkers and two skeptics) found these. All are fixed, and this document was corrected.

First version of the prototype:
- **Monospace capital labels.** I called this the studio's "voice". ndstudio.gov uses none. Labels are back in Inter.
- **Tight letter-spacing on everything.** I had tightened 9 to 11px text, which made it harder to read.
- **A font setting that did nothing.** Two of three font features I switched on have no effect in our Inter file; the third forced fixed-width digits everywhere.
- **"White cards" that were not white.** Every card was the same gray as the page.
- **Hairlines too faint.** 6% ink, weaker than the studio's 10% and weaker than our own theme.
- **One line that grayed every border on the page.** The build merged a skin rule into the rule for every element. Check-box rings, the green notice border and the map legend rings all lost their color.

The rebuild, caught by the second round:
- Bringing left-out comps back to full strength made their **empty check boxes look ticked**, and faded the photo in the compare panel, whose whole job is comparing photos.
- The white search-field style also painted the **manual ARV box**.
- The valuation box got a **doubled right edge** when its tiles wrap (1100 and phone widths).
- MEDIAN as a white chip was the **one pure-white thing in dark mode**.
- Two of my new tests **could not fail**, and one read the wrong box.
- This document called techforce.gov a white site (it is near-black) and overstated the studio's type rules.

## Where Flowstate stands

- Already close: a neutral or warm paper surface with near-black ink, hairline cards, small radius, Inter.
- Worth taking (now in the prototype): one ink; a solid ink fill for the selected tab; three button levels; meaning colors darkened until they can be read.
- Our own step, not the studio's: **data on white cards over a gray page.** ndstudio.gov has no cards and TrumpRx cards are a slightly darker fill. A grid of 33 comps needs grouping that their sparse pages do not.
- Not a fit: the studio's marketing scale (huge headlines, wide whitespace, full-bleed photos, a serif headline). Underwriting is dense, and bigger valuation figures do not fit their tiles.

## The prototype (Property Search only)

Open Property Search and use the "Prototype: Current | Studio" switch at the bottom right (above the bottom nav on a phone), or open `/dashboard/analyze?skin=nds`. The skin is one block of CSS under `[data-skin="nds"]` at the end of `globals.css`, applied only while Property Search is open, and removed when you leave it by any route. The real theme is not edited. With the skin off the loaded page is pixel-identical to before, apart from live map imagery; the switch no longer takes a place in the page's layout.

What it changes:
- **Surfaces.** Flat gray page, no gradient, dot grid or corner marks. Subject card, comp cards, valuation box, top bar, search card and the compare panel's cards are white. 10% hairlines; one 20% rule under the tier tabs.
- **Type.** Inter throughout. Normal spacing on small text; headings and 16px-and-up figures slightly tightened. Figures at 600.
- **Controls.** Prep offer and Run are the same filled ink, and the same pale slab when they cannot be used. No margin, No offer, Download Report, Pull and Validate share one outline. Re-run and Evaluation Settings stay plain text. The selected tier tab is an ink fill. Deal buttons and tier tabs are 6px and at least 24px tall.
- **Comp cards.** A comp left out of the ARV dims its photo, not its numbers; pointing at it or tabbing into it brings the photo back; the compare panel and touch screens do not dim. An empty check box shows no ghost tick. The ARV stamp is ink on amber (it was white on amber, close to unreadable). MEDIAN takes the card's own surface, which leaves blue for the subject alone.
- **Meaning colors.** Green, amber and red text is one step darker in light so it passes contrast. The notice keeps its tint; its title is ink. Checked ARV boxes are one green on the card and in the detail dialog.
- **Dark.** Realfood's warm black, a step calmer, cream text, stronger hairlines. The SUBJECT label on the photo and the "on" switch can be read.
- **Details.** Keyboard focus rings are drawn inside photo links, check boxes, permit thumbnails and the settings headers (they were clipped). Permit steps to come are hollow. A dialog opened by mouse does not show a ring on its Close button. Printing from the dark skin uses paper colors.

What it does not change: the data, the typeface file, the map, any behavior. Layout moves by a few pixels where buttons got taller.

Measured after the last change: text below readable contrast on the first screen, 85 with the skin off and 0 with it on (light); 9 and 0 (dark). An independent full-page scan of every state found 0 with the skin on. Small text with tightened spacing: 0. Dark print: 4 dark blocks and cream text with the skin off; 1 block and paper colors with it on (the printed comp table still grays its excluded rows, as before).

Known and left: the switch floats over the bottom right of the comp list, so it can sit on a card until you scroll; it is a prototype control and goes away with the prototype.

To remove the prototype, delete: `components/prototype/SkinPreview.tsx`; its import and its mount in `analyze/page.tsx`; the "PROTOTYPE SKIN" block in `globals.css`; `src/lib/skin-css.test.mjs`; and the "Skin prototype" block in `tests/ui-polish.e2e.ts`. The `data-deal`, `data-surface`, `data-stamp`, `data-in-arv`, `data-notice` and `data-action` attributes do nothing without the skin and can stay or go.

## Found on the way, outside the skin

These exist with the skin off and are not fixed in the real theme:
- With browser storage blocked the whole app fails to load (unguarded reads in `theme-provider.tsx`).
- In the current light theme about 580 small gray, green, amber and red texts on this page are under the readable-contrast line (about 430 in dark).
- Keyboard focus rings are clipped on photo links, comp check boxes, permit thumbnails and settings headers.
- Field edges and the "off" switch are under 3:1 against their background.
- Small click targets: 34 copy buttons at 12 by 12px, the Permits toggle at 16px tall.
- Printing from a dark theme leaves cream text and dark blocks on white.
- A code comment in `PropertyMap.tsx` says marker color shows the evidence class; all included comps are one green now.

## Decisions for you

1. Keep, adjust or drop the Studio look?
2. If kept: make it a real theme you can choose anywhere? That edits the theme, so only on your word. Several fixes above (contrast, focus rings, print) would then help every theme.
3. Comp card badges. The prototype takes the calm, low-risk step. Two bigger ideas were proposed and need your call: hide MEDIAN when every comp has it (33 of 33 on the test report), and a single chip style with a small colored dot for price class. Both need to be seen on comps that are Renovated, As-is and Flip, which the test report does not have.
