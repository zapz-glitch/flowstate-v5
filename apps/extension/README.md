# Flowstate — Send Address (browser extension)

Send a property address from any webpage to Flowstate for an evaluation.

## Three ways to send

- **Right-click → Send to Flowstate.** Highlight an address first, or
  right-click anywhere on a listing page and the extension reads the address
  off the page.
- **Alt+Shift+F** on a listing page. Chrome keeps Alt+F for its own menu, so it
  cannot be the default; change the key at `chrome://extensions/shortcuts`.
- **Toolbar button → Send this page to Flowstate.** The popup also lists what
  you sent, with status and result.

The address comes from, in order: the highlighted text, the listing's
structured data (Redfin, Zillow, Realtor and most listing sites publish it),
then the page title. Pages that show no full address (Facebook Marketplace)
need a highlight.

## What happens after a send

- **With an API key** (Options): the evaluation starts in the background. No
  tab opens. A notice appears when it is done, with ARV and offer; click it,
  or the row in the popup, to open the report. The toolbar badge counts runs
  in progress, so you can send several listings in a row.
- **Without a key**: a new tab opens Property Search with the address
  prefilled and the analysis started. If you are signed out, sign in on that
  tab and it carries on.
- **Already analyzed**: either way, an address that has a report goes straight
  to that report instead of running again. This lookup uses your dashboard
  sign-in.

## Install (load unpacked)

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select this `apps/extension` directory
3. Click the extension → **Settings**:
   - Dashboard URL: `https://app.flowstate.homes` (default) or
     `http://localhost:3000` for local dev
   - API key: make one in Flowstate under API Hub. Stored on this computer
     only (`chrome.storage.local`).

After pulling a change, press the reload arrow on the extension card.

## Tests

- Unit: `node --test apps/extension/tests/*.test.mjs`
- Integration: `node apps/extension/tests/extension.integration.mjs` loads the
  extension in Chromium against a stand-in Flowstate. Spends nothing.
- End-to-end (needs `npm run dev`):
  - `node apps/extension/tests/send-address.e2e.mjs`: no key, signed out →
    send → sign in → analyze page.
  - `node apps/extension/tests/background-send.e2e.mjs`: background send
    against the local API. **Runs one real evaluation.**
  - Both write `.data/extension-e2e/`.
