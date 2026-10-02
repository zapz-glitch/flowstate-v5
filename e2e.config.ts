import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';
import { openai } from '@ai-sdk/openai';

export default {
  // OPENAI_API_KEY (gpt-6-luna key) backs every agent.* step.
  agents: {
    default: {
      model: openai('gpt-6-luna'),
      system: 'You are a thorough QA agent. Verify every outcome.',
    },
  },
  targets: [{
    engine: web(),
    app: {
      // Defaults to the production dashboard for smoke runs; override with
      // APP_URL=http://localhost:3000 to run against a local `npm run dev`.
      url: process.env.APP_URL ?? 'https://flowstate.homes',
      // Or let the runner start the dev server:
      // command: { executable: 'npm', args: ['run', 'dev'] },
    },
  }],
} satisfies E2EConfig;
