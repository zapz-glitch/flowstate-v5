# Flowstate — Send Address (browser extension)

Highlight an address on any webpage → right-click → **Send "…" to Flowstate** →
a new tab opens the Property Research page with the address prefilled and the
analysis started (the existing-report dialog still applies if you've already
analyzed it).

The toolbar button opens Property Search. Pin it from the puzzle-piece menu.

## Install (load unpacked)

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select this `apps/extension` directory
3. Optional: click the extension → **Options** to set the dashboard URL
   (`http://localhost:3000` for local dev, `https://app.flowstate.homes` default)

After pulling a change, press the reload arrow on the extension card.

If you are signed out, sign in on the tab that opens — the address is kept and
the analysis starts right after.

## Tests

- Unit: `node --test apps/extension/tests/flowstate-url.test.mjs`
- End-to-end (needs `npm run dev`): `node apps/extension/tests/send-address.e2e.mjs`
  — loads the extension in Chromium, sends an already-analyzed address while
  signed out, signs in, and checks it lands on the analyze page. Writes
  `.data/extension-e2e/`.
