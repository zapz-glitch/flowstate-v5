# National Design Studio: what we can learn, and a prototype

2026-10-06 · Sources: ndstudio.gov (its page and its own stylesheet), and its sister sites TrumpRx.gov and Realfood.gov, looked at in a browser. Also: Wikipedia and Dezeen on the studio. Nothing here copies their files; the typeface is licensed, so the prototype keeps ours.

## What the studio is

The National Design Studio is a White House office (formed August 2025, led by Chief Design Officer Joe Gebbia). It redesigns high-traffic federal sites (Login.gov, TrumpRx.gov, Realfood.gov, America.gov and others). Its stated aim: less friction, "months reduced to minutes", and standard, trustworthy design.

## The themes (three sites, one family)

| Site | Surface | Type | Mood |
| ---- | ------- | ---- | ---- |
| ndstudio.gov | neutral `#f2f2f2`, white, near-black ink `#010101` | PP Neue Montreal (a grotesque), tight tracking `-0.02em`, large regular-weight headlines | plain, editorial, calm |
| TrumpRx.gov | warm cream, soft shadows | big serif headline, grotesque body, a monospace voice for small facts, mint chip for a positive number | friendly, warm, objects as illustration |
| Realfood.gov | deep warm black, cream text | very heavy grotesque, all-caps mono for the "official site" line, full-bleed photography | loud, cinematic |

Values read from the studio's own stylesheet: ink `#010101`, muted `#6b6b6b`, secondary `#3a3a3a`, surface `#f2f2f2`, hairlines 10% black, link blue `#3760f2`, danger `#bf000f`, radius `0.375rem` (6px) with some full pills, one easing curve (ease-out cubic), 0.15s default transitions, type steps 12 / 14 / 16 / 30 / 44 / 60 / 104 px.

## What they have in common

1. **A quiet canvas and one ink.** A neutral or warm surface, near-black (not pure black) text, almost no accent color. Color is saved for meaning (a mint chip, a red error).
2. **One typeface doing all the work**, with tight negative letter-spacing, and a big jump in size between the headline and everything else. A monospace voice for labels, counts and "official" lines.
3. **Hairlines instead of boxes.** 1px 10%-black borders, small radius, little or no shadow.
4. **Buttons with a clear order.** One dark filled primary, hairline-outlined secondaries, plain text for the rest.
5. **Plain language and confident numbers.** Big figures, short sentences.
6. **Quiet motion.** 150 ms, one ease-out curve.

## Where Flowstate already is, and where it differs

- Already close: the light "LED" theme is a warm paper surface with near-black ink; hairline cards; small radius; Inter with tabular figures; calm motion.
- Differences worth testing: a *neutral* surface under *white* cards (we use warm tinted cards on a warm tint); tighter letter-spacing and a monospace voice for labels; a dark filled primary with outlined secondaries (we use quiet text for all five deal buttons); a warm black with cream text for dark mode.
- Not a fit for us: the cinematic photography, the 100px+ headlines and the generous whitespace. Underwriting is dense; those would cost screen space.

## The prototype (Property Search only)

Open Property Search and use the small "Prototype: Current | Studio" switch at the bottom right, or open `/dashboard/analyze?skin=nds`. The skin is a block of CSS under `[data-skin="nds"]` at the end of `globals.css`, applied to the page only while Property Search is open. The real theme is not edited; "Current" or leaving the page restores today's look exactly. Property Reports, Offers, the landing page and login never see it.

What it changes: neutral `#f2f2f2` surface with white cards; ink `#010101` with `#3a3a3a` / `#6b6b6b` text; 10%-black hairlines; tight `-0.02em` headings; uppercase labels in the monospace voice; **Prep offer** as the dark filled button and No margin / No offer outlined; warm black with cream text in dark mode.

What it does not change: layout, spacing, the data, the typeface file, the map, any behavior.

To remove it: delete `components/prototype/SkinPreview.tsx`, its one line in `analyze/page.tsx`, the `[data-skin="nds"]` block in `globals.css`, and the `data-deal` attributes in `DealActions.tsx` (harmless to leave).

## Decisions for you

1. Keep, adjust or drop the Studio look? If kept, which parts: the neutral surface, the mono labels, the button order, the dark mode.
2. If kept, should it become a fourth theme preset (next to LED, Outdoor, Night, Dawn) so it can be chosen anywhere, not just here? That edits the theme, so I will only do it when you say so.
