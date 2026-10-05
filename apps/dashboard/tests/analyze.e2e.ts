// UI E2E: sign in (restored session) → Property Search → run an address →
// the report renders. The deterministic steps drive the form; the agent only
// judges completion, and replays cached once verified.
import { test } from '@e2e-dev/web'
import { expect } from 'e2e'

const ADDRESS = '8952 Sterling Ln, Port Richey, FL 34668'

test('analyze produces a report with comps', { session: 'local', platforms: ['web'], timeout: 420_000 }, async ({ app, agent, screen }) => {
  // ?address= auto-runs — skips the collapsed-search-card locator entirely.
  await app.open(`/dashboard/analyze?address=${encodeURIComponent(ADDRESS)}`)
  // A prior report for this address pops "Existing Reports Found" — click
  // through to a fresh run when it appears.
  const newAnalysis = screen.getByRole('button', 'New Analysis')
  try {
    await expect(newAnalysis).toBeVisible({ timeout: 15_000 })
    await newAnalysis.tap()
  } catch { /* no prior reports — the run started directly */ }
  // The pipeline streams progress for ~1–3 min; the agent polls the screen
  // and only spends a model call when the observation changes.
  await agent.waitFor('the analysis has finished and a results report is showing', { interval: 2000, timeout: 360_000 })
  await expect(screen.getByRole('button', 'ARV').first()).toBeVisible({ timeout: 30_000 })
  // A finished report renders actionable comp cards — the 'Add to ARV'
  // buttons only exist on a completed comp list (layout text varies across
  // report variants: Valuation hero, report-only notice, manual-selection).
  await expect(screen.getByRole('button', 'Add to ARV').first()).toBeVisible({ timeout: 30_000 })
})
