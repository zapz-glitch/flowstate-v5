# Engineering State — flowstate-v5

> This file is a session handoff, not a log. It holds ONLY: the current
> objective, active work, live blockers, durable facts the codebase can't
> tell you (external wiring, prod quirks, secret locations), and the last
> handoff. Everything else — what changed, why, how it was verified —
> lives in git history and PRs. If you're tempted to write a narrative,
> put it in the commit message instead.
>
> Write rules: update ONLY when the objective changes, a blocker appears
> or clears, a durable external fact is learned, or the session ends.
> Never record completion narration for work that's already in a commit.

## How to work in this repo

- **E2E only — never write unit tests.** Verify by running the real
  system end-to-end (dev servers, authed curl, real API calls) or the
  `*.test.ts` regression harness (`node scripts/run-regression-tests.mjs
  api|dashboard`) — those files run real pipeline code against stub envs,
  not mocks. Write the failing check first, then implement against it.
- **The codebase is the source of truth.** Read the actual files before
  assuming behavior; this file records only what code can't tell you.
- **Typecheck, never auto-deploy.** `npx tsc --noEmit` per app after
  changes. Deploy only when the user asks.
- **Git:** branch off `main` → commit → push → PR → merge. Never commit
  to main, never merge main into a feature branch (full rules: AGENTS.md).
- **Dev env:** everything lives in this checkout — `apps/api/.dev.vars`,
  `apps/dashboard/.env.local`, `apps/api/.wrangler` local D1. After
  `npm run dev`, run `npm run dev:check`. Local login creds:
  `.data/local-candidate/login.json` (sign in at /auth/sign-in/email).

## UI / theme conventions (durable)

- **Property Search (`analyze`) is the reference layout.** Other views
  match its chrome: 64px header band aligned to the sidebar logo divider
  (the `-m-8` pull-up is intentional — nothing renders above it).
- **All overlays/menus are opaque.** `bg-popover`/`bg-background` tokens
  exist — never leave a Radix surface transparent.
- **Stale-bundle is the recurring prod failure mode.** VersionGuard
  auto-reloads tabs on new deploys; when a shipped fix "isn't working",
  suspect the stale bundle before the code.
- **List price always renders** on offer/report surfaces (`List $X` or
  `List —`), never hidden conditionally.
- **Offer price is locked to the computed value** — no editable offer
  input anywhere (product discipline rule).
- **Request shape (PR #72 ruleset):** one navigation → one composite
  authenticated view request → parallel internal reads → one response.
  Caches declare scope/key/TTL/invalidation; mutation always invalidates.
  Measure navigation/data-loading changes with `scripts/perf-audit.mjs`.

## External wiring (not in the code)

- Engine repo: `zapz-glitch/conversation-intelligence`. Push events to
  `POST /v1/activity` (Bearer `CI_INGEST_KEY`); engine pulls results by
  jobId via `notifyEvalComplete`. `/engine/queue` does a serial Close
  getLead per opp — our proxy KV-caches it (30s SWR).
- Listener Devin session `devin-fbfcfad371534372bff22b123657c41f`
  ("Conversation Engine"), org `org-6c0122ecb67544ccb259ae9b1e9cc4dc`;
  `CLOSE_API_KEY` org secret `secret-a7058ea65e1c4644af6e39ffd5c49415`.
- Prod quirks: CF edge 403s Python-urllib UA on POST (use curl/browser
  UA); `deploy.yml` does NOT run migrations (`npm run db:migrate:remote`
  separately); wrangler token may lack D1/secrets scope — remote ops can
  need OAuth login.
- Insufficient-comps evals now SAVE a report (`valuation: null`,
  `comps.insufficientComps: true`) instead of erroring — jobs endpoint
  returns `status: 'complete'` for these (post-PR-#79 contract).

## Current state

- `main` is production (auto-deploys on push). Merged through PR #79 —
  insufficient comps degrade to a saved report. Prod verification of a
  known-insufficient address (12717 Dunn Creek Rd / 1802 Hunters Gln NE,
  Marietta GA) still pending after that deploy.
- Objective: swap data provider Cotality → ATTOM for all property API
  calls (clean per-call swaps; nothing removed unless told) + add an
  ATTOM MCP server for tool calling. Working branch:
  `feat/attom-provider-swap`.
- Inventory + gap map lives in `docs/attom-migration/PROVIDER_SWAP.md`.
  Read-only scan done: adapter boundary is `PropertyProviderAdapter`
  (`services/property-api/types.ts`), selected by `PROPERTY_PROVIDER`
  env; ATTOM adapter exists but is partial (no parcel flood/AVM/building
  detail, no typeahead, no throttle/rotation).
- `ATTOM_API_KEY` is declared in `types.ts` but NOT in
  `apps/api/.dev.vars` — needed before local verification.
- Blocked on user-supplied ATTOM API docs + MCP server docs before
  implementation. User will supply corrected endpoints for any call that
  errors during the swap.

## Last handoff

PR #79 merged and deployed. New objective started: read-only provider
scan complete, migration doc committed on `feat/attom-provider-swap`.
Resume at the swap once ATTOM/MCP docs arrive — start with the doc's
"Semantic gaps" list.
