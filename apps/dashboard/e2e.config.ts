import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { E2EConfig } from 'e2e'
import { web } from '@e2e-dev/web'
import { openrouter } from '@openrouter/ai-sdk-provider'

// e2e loads no .env itself — pull the API's local secrets (OPENROUTER_API_KEY
// and friends) into the runner process so the agent model authenticates.
process.loadEnvFile('../api/.dev.vars')

// WSL2 lacks the system libs Playwright's chromium needs (libnspr4, libnss3,
// libasound). They live unpacked at ~/.local/lib/playwright-deps — no sudo.
// If a proper `playwright install-deps` ever runs, remove this.
const pwDeps = join(process.env.HOME ?? '', '.local/lib/playwright-deps')
process.env.LD_LIBRARY_PATH = [pwDeps, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':')

// Local dev credentials — read from the untracked fixture, never committed.
const login = JSON.parse(
  readFileSync('../../.data/local-candidate/login.json', 'utf8'),
) as { email: string; password: string }

export default {
  targets: [
    // Engine-free target for fetch+schema API tests — no browser boots.
    { name: 'api', platform: 'api' },
    {
      engine: web(),
      app: {
        url: 'http://localhost:3000',
        // `npm run dev` at the repo root brings up BOTH the dashboard (:3000)
        // and the wrangler API (:8787) via turbo — the UI tests need both.
        // reuseExisting attaches to a dev stack already running.
        command: {
          executable: 'npm',
          args: ['run', 'dev'],
          cwd: '../..',
          startupTimeout: 120_000,
          log: '.e2e/logs/app.log',
          reuseExisting: true,
        },
      },
    },
  ],
  agents: {
    default: {
      // Same provider+model the vision service already runs on — key comes
      // from apps/api/.dev.vars via loadEnvFile above.
      model: openrouter('google/gemini-2.5-flash'),
      context:
        'flowstate is a real-estate underwriting dashboard. Vocabulary: ' +
        'ARV (after-repair value), comps/comparables, buy price, wholesale ' +
        'price, rehab level, flip, distressed sale, offer disposition. ' +
        'The analyze page is titled "Property Search" with an address field ' +
        'and a Run button; results render a Valuation card and a Comparables ' +
        'section. Insufficient-comps runs render a notice instead of an ARV.',
    },
  },
  credentials: {
    local: { username: login.email, password: () => login.password },
  },
} satisfies E2EConfig
