# Flowstate — Analyze Address (browser extension)

Right-click any selected address on any webpage → **Analyze "…" in Flowstate** →
opens the Property Research page with the address prefilled and the analysis
started (the existing-report dialog still applies if you've already analyzed it).

## Install (load unpacked)

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select this `apps/extension` directory
3. Optional: click the extension → **Options** to set the dashboard URL
   (`http://localhost:3004` for local dev, `https://app.flowstate.homes` default)

Requires being signed into the dashboard — the link opens the app and session
auth applies normally.
