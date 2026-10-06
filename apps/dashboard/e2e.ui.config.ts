import type { E2EConfig } from 'e2e'
import { web } from '@e2e-dev/web'

// Config for the UI tests that need no model (tests/ui-polish.e2e.ts): they
// drive the page with exact locators, so no agent and no API keys are involved.
//
//   APP_URL=http://localhost:3100 \
//   E2E_USER_LOCAL_PASSWORD=... \
//   npx e2e run --config e2e.ui.config.ts
//
// The dashboard and its API (default :8787) must already be running. The test
// user's password comes from E2E_USER_LOCAL_PASSWORD (never committed); the
// email defaults to the local dev user.
export default {
  targets: [
    {
      engine: web(),
      app: { url: process.env.APP_URL ?? 'http://localhost:3000' },
    },
  ],
  credentials: {
    // A static value must be 6+ characters at load time; the real one is
    // supplied per run by E2E_USER_LOCAL_PASSWORD.
    local: { username: process.env.E2E_LOCAL_EMAIL ?? 'local@flowstate.test', password: 'set-E2E_USER_LOCAL_PASSWORD' },
  },
} satisfies E2EConfig
