# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Role & Standards

You are an **expert Node.js/TypeScript developer** working with a team that has strong **UI/UX experience**. We are committed to building a **quality, robust, production-grade application**. This means:

- Write clean, type-safe TypeScript with strict mode
- Favor simplicity over abstraction — only introduce complexity when it earns its keep
- Handle errors gracefully at system boundaries (API inputs, external services, user actions)
- Keep the codebase consistent — follow existing patterns before inventing new ones
- Performance matters: synchronous derived state (`useMemo`) over async (`useEffect`) for UI calculations
- Security-first: validate all external input, hash secrets, never expose tokens client-side

## Build & Development Commands

```bash
# Install dependencies
npm install

# Run all apps in development (Turborepo)
npm run dev

# Run individual apps
cd apps/api && npm run dev      # API on Cloudflare Workers (wrangler dev)
cd apps/dashboard && npm run dev # Next.js dashboard (with Turbopack)

# Type checking
npm run typecheck               # All workspaces
cd apps/api && npm run typecheck
cd apps/dashboard && npm run typecheck

# Linting
npm run lint

# Testing
cd apps/api && npm run test      # Run API tests (vitest)
cd apps/api && npm run test:watch # Run tests in watch mode

# Database operations (from apps/api)
npm run db:generate             # Generate Drizzle migrations
npm run db:migrate:local        # Apply migrations to local D1
npm run db:migrate:remote       # Apply migrations to remote D1

# Deployment
cd apps/api && npm run deploy       # Deploy API to Cloudflare Workers
cd apps/dashboard && npm run build && npm run deploy  # Build with OpenNext, deploy dashboard
```

---

## Turborepo Monorepo Setup

This is a **Turborepo monorepo** for a real estate underwriting/valuation API platform deployed entirely on **Cloudflare**.

### Workspaces

```
flowstate-api/
├── apps/
│   ├── api/              # Hono REST API on Cloudflare Workers
│   └── dashboard/        # Next.js 15 dashboard (OpenNext on Cloudflare)
├── packages/
│   └── shared/           # Shared valuation & appraisal calculation logic
├── turbo.json            # Turbo pipeline config
├── package.json          # Root workspace config (npm workspaces)
└── CLAUDE.md
```

### Turbo Pipeline (`turbo.json`)

| Task | Depends On | Cached | Outputs |
|------|-----------|--------|---------|
| `dev` | — | No | Persistent |
| `build` | `^build` (upstream) | Yes | `.next/**`, `.open-next/**`, `dist/**` |
| `deploy` | `build` | No | — |
| `typecheck` | `^build` | Yes | — |
| `lint` | — | Yes | — |
| `db:*` | — | No | — |

Root commands (`npm run dev`, `npm run build`, etc.) delegate to Turbo, which orchestrates all workspaces in dependency order.

### Shared Package (`packages/shared`)

**`@flowstate-api/shared`** — Pure TypeScript calculation library with no runtime dependencies. Both the API and dashboard import it directly from source (no build step).

**Export paths:**
- `@flowstate-api/shared` — Main entry (re-exports everything)
- `@flowstate-api/shared/valuation` — Valuation calculations, rehab tables, tier ranges
- `@flowstate-api/shared/appraisal` — Comp evaluation, filters, adjustments, ARV

**Valuation module** (`packages/shared/src/valuation/`):
- `calculateValuation(params)` — Main valuation formula (rehab, closing, carrying, buy price, profit, ROI)
- `calculateAllRehabLevelEstimates(params)` — Pre-calculates all 5 rehab level variants
- `getArvTier(arv)` — Determines ARV tier (under501k, 501kTo999k, etc.)
- `DEFAULT_REHAB_TABLE`, `DEFAULT_TIER_RANGES` — System defaults
- Types: `ValuationParams`, `ValuationResult`, `RehabEstimate`, `RehabTable`, `TierRangeDefinition`, `MajorItem`

**Appraisal module** (`packages/shared/src/appraisal/`):
- `evaluateComparable(subject, comp, filters, adjustments)` — Full comp evaluation
- `evaluateFilter(filter, subject, comp)` — Individual filter check
- `calculateAdjustment(adjustment, subject, comp)` — Individual adjustment
- `calculateARV(subject, selectedComps)` — ARV from best comps
- `pickBestComps(evaluations, maxCount)` — Select top comps by quality
- Types: `FilterType`, `AdjustmentType`, `ComparableEvaluation`, `PropertyLike`, `CompLike`

---

## API App (`apps/api`)

### Technology Stack

- **Runtime**: Cloudflare Workers (V8 isolates, not Node.js)
- **Framework**: Hono (lightweight web framework)
- **Database**: Cloudflare D1 (SQLite) via Drizzle ORM
- **Auth**: Better Auth (email/password sessions) + SHA-256 hashed API keys
- **Async Processing**: Cloudflare Workflows (durable multi-step execution)
- **Real-time**: Server-Sent Events via Durable Objects
- **Storage**: Cloudflare KV (caching), R2 (photo storage)
- **Validation**: Zod schemas

### Directory Structure

```
apps/api/src/
├── index.ts              # Hono app entry, route mounting, CORS, global middleware
├── types.ts              # All TypeScript types (Env bindings, API response shapes)
├── db/
│   └── schema.ts         # Drizzle ORM schema (all tables)
├── lib/
│   └── auth.ts           # Better Auth setup (Kysely D1 adapter, MailChannels email)
├── middleware/
│   └── auth.ts           # API key auth, quota checking, usage logging
├── routes/               # All route handlers (see Routes section)
├── durable-objects/      # Cloudflare Durable Objects
├── workflows/            # Cloudflare Workflows
└── services/             # Business logic layer
```

### Cloudflare Bindings (`wrangler.toml`)

| Binding | Type | Purpose |
|---------|------|---------|
| `DB` | D1 Database | SQLite database (`flowstate-api-db`) |
| `API_CACHE` | KV Namespace | Property data & API response caching (7-day TTL) |
| `REPORT_PHOTOS` | R2 Bucket | User-uploaded report photos |
| `ANALYSIS_JOB` | Durable Object | Per-job state management & SSE streaming |
| `RATE_LIMIT_COORDINATOR` | Durable Object | Cross-key rate limit coordination |
| `FIRECRAWL_RATE_LIMITER` | Durable Object | Firecrawl concurrency limiter (max 50) |
| `ANALYSIS_WORKFLOW` | Workflow | Durable async analysis orchestration |

### Durable Objects

**AnalysisJobDO** (`durable-objects/analysis-job.ts`)
- One instance per analysis job (keyed by `userId:propertyKey`)
- Manages job lifecycle: `init` → `step updates` → `result`/`error`
- Serves SSE stream at `GET /sse` — clients connect via EventSource with signed token
- Stores step-specific data (property fetch results, partial analysis) for late-joining SSE clients
- Internal endpoints: `POST /init`, `POST /step`, `POST /result`, `POST /error`, `POST /step-data`, `POST /partial-result`, `GET /state`, `GET /sse`

**RateLimitCoordinatorDO** (`durable-objects/rate-limit-coordinator.ts`)
- Coordinates API key quotas across concurrent requests
- Prevents quota overshooting in distributed Workers environment

**FirecrawlRateLimiterDO** (`durable-objects/firecrawl-rate-limiter.ts`)
- Limits Firecrawl API to 50 concurrent requests
- Provides `acquireSlot()`/`releaseSlot()` pattern for rate limiting

**Important**: DO `stub.fetch()` responses MUST be consumed (`await resp.text()`) to avoid "RPC result not disposed" warnings. Never call `stub.dispose()` — consume the response body instead.

### Cloudflare Workflow (`workflows/analysis-workflow.ts`)

Multi-step durable analysis pipeline with automatic retries and parallel execution:

```
Step 1: Property Fetch (skipped when preloaded from endpoint)
  → CoreLogic/ATTOM API → subject + comps + enrichment
Step 2: Photo Fetch (parallel for all properties)
  → Zillow via Firecrawl → photos + supplemental data
Step 3: Classification (parallel)
  → Keyword analysis + optional LLM vision → as_is / after_renovation
Step 4: Appraisal Evaluation
  → 3-pass filter system → select best 3 comps → apply adjustments
Step 5: ARV & Valuation Calculation
  → Weighted ARV → rehab costs → buy price → profit → recommendation
Step 6: GHL Integration (optional, 3x retry, non-fatal)
  → Push results to GoHighLevel CRM opportunity
```

**Key architectural detail**: The route handler (`routes/analyze.ts`) pre-fetches the property bundle from CoreLogic *before* starting the workflow. This eliminates ~1-2s of Workflow checkpoint latency. The bundle is passed via `preloadedPropertyBundle` in `AnalysisWorkflowParams`. Since Workers and Workflows run in **separate isolates**, module-level state (like CoreLogic call logs) is NOT shared — stats are passed via `preloadedApiCallStats`.

**Workflow I/O types**: `AnalysisWorkflowParams` (input) and `AnalysisWorkflowResult` (output) in `workflows/types.ts`.

### Routes

| Route | Auth | Purpose |
|-------|------|---------|
| `GET /health`, `/health/db`, `/health/keys` | None | Health checks |
| `/auth/*` | None | Better Auth (sign-in, sign-up, sign-out, password reset) |
| `GET /user` | Session | User profile |
| `/user/api-keys` | Session | API key CRUD (create returns plaintext once) |
| `/user/usage`, `/user/usage/daily` | Session | Usage statistics |
| `/user/usage/logs` | Session | API usage logs (paginated) |
| `/user/usage/logs/:id` | Session | Single log detail |
| `/appraisal-presets` | Session | Appraisal rule preset CRUD (multi-preset, one default) |
| `/rehab-config` | Session | Per-user rehab pricing table (GET/PUT/DELETE) |
| `/deal-params` | Session | Deal parameters (closing%, carrying%, wholesale fee) |
| `/location-settings` | Session | Per-location overrides (state/city/zip) CRUD |
| `/major-item-costs` | Session | Per-item repair cost overrides |
| `/ghl-settings` | Session | GoHighLevel CRM config + test + field listing |
| `/user/reports` | Session | Saved reports CRUD with sharing/password |
| `/reports/:jobId` | None/Password | Public shared report access |
| `/webhooks/ghl/:secret` | URL Secret | GHL webhook receiver |
| `GET /sse/analyze/:jobId` | Signed Token | SSE real-time progress stream |
| `POST /v1/analyze` | Bearer (API Key) | Start analysis workflow |
| `GET /v1/analyze/jobs/:jobId` | Bearer (API Key) | Poll job status |
| `POST /v1/analyze/stream-token` | Bearer (API Key) | Generate signed SSE token |

### Services Layer

```
services/
├── property-api/       # Unified property data interface
│   ├── providers/
│   │   ├── corelogic.ts  # CoreLogic API (primary, with key rotation)
│   │   └── attom.ts      # ATTOM API (fallback)
│   └── types.ts          # NormalizedProperty, NormalizedComparable, PropertyBundle
├── appraisal/          # 3-pass comp evaluation engine
│   ├── index.ts          # AppraisalService (orchestrates passes)
│   ├── evaluator.ts      # Per-comp evaluation (filters + adjustments)
│   ├── filters.ts        # Filter implementations
│   ├── adjustments.ts    # Adjustment implementations
│   └── types.ts          # Filter/Adjustment types, filtersToApiParams()
├── classification/     # Property condition classification
│   └── index.ts          # Keyword analysis (58 as-is / 57 after-reno keywords)
├── valuation/          # Rehab costs, buy price, profit, ROI
│   └── index.ts          # Wraps shared package + API-specific logic
├── analysis/           # Final response assembly
│   └── index.ts          # buildAnalysisResponse(), mergeZillowData()
├── user-settings/      # Settings resolution with location overrides
│   └── index.ts          # loadUserAnalysisSettings() — used by analyze + GHL webhook
├── photo-provider/     # Photo fetching (Zillow via Firecrawl/Gemini)
│   ├── index.ts
│   └── providers/zillow/ # Firecrawl + Gemini fetchers
├── vision/             # LLM photo analysis for property condition
│   └── index.ts          # OpenRouter / OpenAI / Gemini vision
├── ghl/                # GoHighLevel CRM push
│   └── index.ts          # updateGHLOpportunity(), buildGHLCustomFields()
├── cache/              # KV caching wrapper
└── llm/                # LLM provider abstraction
```

### Authentication

**Session Auth (Dashboard routes)**:
- Better Auth with D1 storage via Kysely adapter
- 7-day sessions, 1-day update interval
- Cross-subdomain cookies (`.flowstate.homes` in prod, `localhost` in dev)
- MailChannels for password reset emails

**API Key Auth (`/v1/*` routes)**:
- Format: `Authorization: Bearer fs_<hex>`
- SHA-256 hashed in `api_keys` table
- Monthly quota tracking with auto-reset
- Rate limit headers: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`

**Dashboard Internal Auth**:
- Headers: `X-Dashboard-User-Id` + `X-Dashboard-Secret`
- Used by dashboard server components calling API without API keys

**SSE Auth**:
- HMAC-SHA256 signed tokens (5-minute expiry)
- Token generated via `POST /v1/analyze/stream-token`

**Quota levels**: free (100 req/mo, 1 key), pro (5000 req/mo, 5 keys), enterprise (unlimited)

### Database Schema (`apps/api/src/db/schema.ts`)

| Category | Tables |
|----------|--------|
| Auth | `user`, `session`, `account`, `verification` (Better Auth) |
| API | `apiKeys` (hashed keys, quota), `apiUsageLogs` (detailed request logging) |
| Billing | `subscriptions` (Stripe), `llmUsageLogs` (token tracking) |
| Reports | `savedReports` (analysis JSON, sharing, password hash) |
| Settings | `appraisalRulePreset` + `appraisalRuleFilter` + `appraisalRuleAdjustment`, `rehabConfig`, `dealParams`, `majorItemCosts`, `locationSettings` |
| Integrations | `ghlSettings` (GoHighLevel CRM) |
| Other | `processDocComments` (methodology doc comments), `reportPhotos` (R2 photo refs) |

### API Code Patterns

**Session-auth route:**
```typescript
const session = await getSession(c)
if (!session?.user) return c.json({ error: 'Not authenticated' }, 401)
const db = drizzle(c.env.DB)
// ... query with session.user.id
```

**Database access:**
```typescript
import { drizzle } from 'drizzle-orm/d1'
import { users } from '../db'
const db = drizzle(c.env.DB)
const [user] = await db.select().from(users).where(eq(users.id, userId))
```

**DO interaction (always consume response):**
```typescript
const stub = c.env.ANALYSIS_JOB.get(doId)
const resp = await stub.fetch(new Request('http://internal/init', { method: 'POST', body: JSON.stringify(data) }))
await resp.text() // MUST consume to avoid RPC disposal warning
```

---

## Dashboard App (`apps/dashboard`)

### Technology Stack

- **Framework**: Next.js 15 with App Router (React 19)
- **Deployment**: OpenNext on Cloudflare Workers
- **Styling**: Tailwind CSS (dark mode forced) + shadcn/ui components
- **State Management**: Jotai atoms (analysis state) + React hooks (settings)
- **Auth**: Better Auth client (session cookies)
- **Icons**: lucide-react
- **PDF**: @react-pdf/renderer (dynamic import, no SSR)
- **Maps**: MapLibre GL
- **Toasts**: sonner

### Directory Structure

```
apps/dashboard/src/
├── app/
│   ├── layout.tsx                    # Root layout (fonts, ThemeProvider, ServiceWorker)
│   ├── page.tsx                      # Landing page (hero, features, auth modals)
│   ├── globals.css                   # Tailwind imports, CSS variables
│   ├── (dashboard)/
│   │   ├── layout.tsx                # Protected layout (Sidebar, UserProvider, AnalysisBridge)
│   │   └── dashboard/
│   │       ├── page.tsx              # Overview dashboard
│   │       ├── analyze/              # Analysis playground (search, real-time results)
│   │       │   ├── page.tsx
│   │       │   └── actions.ts        # Server actions (queueAnalysis, getJobStatus)
│   │       ├── reports/              # Saved reports list + detail
│   │       │   ├── page.tsx
│   │       │   └── [jobId]/page.tsx  # Report detail (PDF, share, evaluation settings)
│   │       ├── evaluation-settings/  # 4-tab settings (appraisal, rehab, deals, locations)
│   │       │   └── page.tsx
│   │       ├── api-hub/              # Consolidated API management
│   │       │   └── page.tsx          # Tabs: API Keys, Usage, Logs, Integrations
│   │       ├── integrations/         # GHL CRM settings
│   │       └── settings/             # User profile
│   ├── report/[jobId]/page.tsx       # Public shared report (no auth)
│   └── reset-password/page.tsx       # Password reset flow
├── atoms/
│   └── analysis.ts                   # Jotai atoms for real-time analysis state
├── components/
│   ├── Sidebar.tsx                   # Navigation (5 items), user dropdown
│   ├── AnalysisBridge.tsx            # Wires SSE/polling into Jotai atoms
│   ├── analysis/                     # 19+ analysis display components
│   ├── report/                       # PDF export, share dialog, settings panel
│   ├── auth/                         # AuthModals, UserProvider
│   ├── landing/                      # Navbar, Hero, Features, Footer
│   └── ui/                           # 20+ shadcn/ui components
├── hooks/
│   ├── use-analysis.ts               # Consumer hook (reads Jotai atoms)
│   ├── use-analysis-sse.ts           # EventSource real-time streaming
│   ├── use-analysis-bridge.ts        # Bridge: SSE/polling → Jotai atoms
│   ├── use-analysis-evaluation.ts    # Unified evaluation display logic
│   └── use-report-settings.ts        # Report settings + synchronous recalculation
├── lib/
│   ├── auth-client.ts                # Better Auth client config
│   ├── client-api.ts                 # 100+ browser-side API helpers (fetchApi)
│   ├── api.ts                        # Server-side API helpers (cookies forwarding)
│   ├── recalc/                       # Client-side recalculation engine
│   │   ├── index.ts                  # recalculateReport(), recalculateValuationFromComps()
│   │   └── types.ts                  # EvaluationSettings, RecalcResult, CompEvaluation
│   ├── merge-utils.ts                # deepMergePartial() for SSE partial updates
│   └── utils.ts                      # cn() helper (clsx + twMerge)
└── types/
    └── analysis.ts                   # StatusMessage, AnalysisState, StepProgress
```

### API Communication (Two Layers)

**Client-side** (`lib/client-api.ts`):
- Used by `'use client'` components
- `fetchApi<T>(path)` with `credentials: 'include'` for session cookies
- 100+ typed helper functions for all API endpoints
- Types: `ApiKey`, `User`, `UsageSummary`, `AppraisalPreset`, `DealParamsConfig`, `RehabTable`, etc.

**Server-side** (`lib/api.ts`):
- Used by server components and route handlers
- Forwards cookies from `cookies()` header
- Same API base URL (`NEXT_PUBLIC_API_URL`)

### Real-Time Analysis Flow

```
User submits address → server action queueAnalysis()
  → POST /v1/analyze → get jobId + streamUrl + token
  → Connect EventSource(streamUrl?token=xxx)
  → SSE events update Jotai atoms in real-time
  → Components re-render with partial data as steps complete
  → workflow_completed → full result available
  → Fallback: SSE fails after 3 retries → switch to HTTP polling (2s interval)
```

**Jotai atoms** (`atoms/analysis.ts`):
- `activeAnalysisAtom` — Current job (jobId, streamUrl, address)
- `analysisStateAtom` — Real-time progress (status, steps, errors, partial result)
- `analysisResultAtom` — Completed analysis data
- `displayDataAtom` — Derived: result if complete, else partial, else null
- `analysisActionsAtom` — Action methods (startAnalysis, cancelAnalysis, etc.)

### Client-Side Recalculation Engine (`lib/recalc/`)

Enables real-time "what-if" analysis in the browser without API round-trips:

**`recalculateReport(data, settings)`** — Full recalculation:
1. Re-evaluates all comps against current filters/adjustments
2. Calculates new ARV from enabled comps
3. Determines ARV tier and rehab pricing
4. Computes full valuation (buy price, profit, ROI, all rehab levels)

**`recalculateValuationFromComps(comps, subject, selectedKeys, baseValuation, settings)`** — Lightweight recalc when user manually toggles comps.

**Architecture decisions:**
- Uses `useMemo` (synchronous, same render frame) — NOT `useEffect` (async, causes missed clicks)
- Always recalculates regardless of `settingsChanged` — `settingsChanged` is display-only for badges
- Comp override state tracks `isManual` flag to distinguish user toggles from settings-driven sync

### Evaluation Settings Hooks

**`useReportSettings(data)`** — Loads user settings from API, provides updaters, always recalculates:
- Fetches: preset, appraisal defaults, rehab config, deal params, major item costs
- `settings` — Current `EvaluationSettings` state
- `recalcData` — Always-fresh `RecalcResult` via `useMemo`
- `settingsChanged` — Display-only (compares serialized snapshot)
- Updaters: `updateFilter()`, `updateAdjustment()`, `selectRehabLevel()`, `updateDealParams()`, etc.

**`useAnalysisEvaluation({ data })`** — Composes `useReportSettings` + comp override + sticky bar + display merging:
- `displayValuation` — Merged valuation (recalcData + manual comp overrides)
- `displayComps` — Comps with recalculated evaluations mapped onto originals
- `compOverride` — Manual comp selection state (selectedCompKeys + isManual)
- `handleToggleComp()`, `handleResetComps()` — Comp selection actions

### UI Patterns

- **Dark mode forced**: `<html className="dark">` in root layout
- **Responsive**: Mobile bottom nav → Desktop sidebar (`pt-16 pb-16 lg:pt-0 lg:pb-0`)
- **shadcn/ui**: Radix primitives + Tailwind styling (20+ components)
- **Typography scale**: Custom classes (`text-display`, `text-heading-sm`, `text-body`, `text-caption`)
- **No-print classes**: `no-print` class hides elements in print/PDF
- **Dynamic imports**: PDF renderer loaded with `next/dynamic` to avoid SSR
- **Import alias**: `Map as MapIcon` from lucide-react (avoids shadowing JS `Map`)

---

## Core Domain Concepts

### Property Classification System

| Classification | Description | Use Case |
|---------------|-------------|----------|
| **as_is** | Distressed, needs work | Current market value / wholesale |
| **after_renovation** | Recently renovated, turnkey | Target ARV for flips |

Classification via MLS remarks keyword analysis (58 as-is, 57 after-renovation keywords) with strong/supporting confidence tiers. Optional LLM vision analysis from property photos.

### Appraisal Rules Engine (3-Pass)

Located in `services/appraisal/` (API) and `packages/shared/src/appraisal/` (shared logic).

**Filters** (pass/fail):
- `subdivision_match` — Same subdivision
- `sale_age` — Days since sale (default: 30)
- `sqft_diff` — Square footage difference (default: 250)
- `year_built_diff` — Year built difference (default: 10)
- `distance` — Miles from subject (default: 0.5)

**Three-Pass Fallback:**
1. Full filters (subdivision + all rules) → best 3 comps
2. Relax subdivision, all other filters active
3. Triple all numeric thresholds, subdivision disabled

**Adjustments** (price modifications):
- Old comp discount (up to 15% for sales >90 days old)
- Bedroom ($15,000/bed), Bathroom ($10,000/bath)
- Pool ($10,000, disabled by default), Garage ($10,000, disabled by default)

### Valuation Formulas

```
ARV            = avg((adjustedPrice / compSqft) × subjectSqft) across selected comps
Total Rehab    = (subjectSqft × perSqft rate) + Σ(major items) + additionPlay
Closing Costs  = ARV × closingCostsPercent (default 8%)
Carrying Costs = ARV × carryingCostsPercent (default 2%)
Buy Price      = ARV − Total Rehab − Closing Costs − Carrying Costs − Flip Profit
Wholesale Price= Buy Price − Wholesale Fee
Total Investment = Buy Price + Total Rehab
Projected Profit = ARV − Total Investment − Closing Costs − Carrying Costs
ROI            = (Projected Profit / Total Investment) × 100
```

**Note**: `Projected Profit` always equals `desiredProfit` (circular by design — buy price is derived from the profit target).

### Recommendation Thresholds

| Recommendation | ROI | Buy Price % of ARV |
|---------------|-----|-------------------|
| Strong Buy | > 25% | < 65% |
| Buy | > 15% | < 75% |
| Hold | > 8% | < 80% |
| Pass | ≤ 8% | ≥ 80% |

### Evaluation Settings System

All parameters are per-user configurable with location-based overrides:

| Setting | API Route | Description |
|---------|-----------|-------------|
| Appraisal Presets | `/appraisal-presets` | Named filter/adjustment configs; one marked default |
| Rehab Config | `/rehab-config` | Per-tier pricing table (5 levels × N ARV tiers) |
| Deal Parameters | `/deal-params` | Closing%, carrying%, wholesale fee, flip profit |
| Major Item Costs | `/major-item-costs` | Per-item repair costs (17 items) |
| Location Overrides | `/location-settings` | Per-market overrides (zip > city+state > state) |

**Resolution order** (most specific wins):
```
request body params → zip override → city+state override → state override → user defaults → system defaults
```

---

## External Services

| Service | Purpose | Config |
|---------|---------|--------|
| **CoreLogic API** | Primary property data (search, details, comps) | `PROPERTY_PROVIDER=corelogic`, key rotation support |
| **ATTOM Data API** | Alternate property data provider | `PROPERTY_PROVIDER=attom` |
| **Firecrawl API** | Zillow scraping for photos/supplemental data | Rate-limited via DO (50 concurrent) |
| **Google Gemini** | Zillow listing data extraction | `GEMINI_API_KEY` |
| **OpenRouter API** | Unified LLM access (vision analysis) | `OPENROUTER_API_KEY` |
| **GoHighLevel API** | CRM integration (push results to opportunities) | `GOHIGHLEVEL_API_KEY_INTEGRATION` |
| **MailChannels** | Email sending (password reset) | SMTP env vars |
| **Cloudflare D1** | SQLite database | Binding in `wrangler.toml` |
| **Cloudflare KV** | Response caching (7-day TTL) | `API_CACHE` binding |
| **Cloudflare R2** | Photo storage | `REPORT_PHOTOS` binding |
| **Cloudflare Workflows** | Durable async analysis | `ANALYSIS_WORKFLOW` binding |
| **Cloudflare Durable Objects** | Job state, SSE, rate limiting | 3 DO classes |

## Environment Variables

**apps/api/.dev.vars:**
```
PROPERTY_PROVIDER=corelogic
CORELOGIC_CLIENT_ID=
CORELOGIC_CLIENT_SECRET=
ATTOM_API_KEY=
OPENROUTER_API_KEY=
FIRECRAWL_API_KEY=
GEMINI_API_KEY=
DASHBOARD_INTERNAL_SECRET=
BETTER_AUTH_SECRET=
GOHIGHLEVEL_API_KEY_INTEGRATION=
```

**apps/dashboard/.dev.vars:**
```
BETTER_AUTH_SECRET=
NEXT_PUBLIC_API_URL=http://localhost:8787
```

---

## Key Implementation Files

| Feature | Primary File(s) |
|---------|----------------|
| Analysis endpoint | `apps/api/src/routes/analyze.ts` |
| Analysis workflow | `apps/api/src/workflows/analysis-workflow.ts` |
| Workflow types | `apps/api/src/workflows/types.ts` |
| Appraisal rules (3-pass) | `apps/api/src/services/appraisal/index.ts`, `evaluator.ts` |
| Property classification | `apps/api/src/services/classification/index.ts` |
| Response building | `apps/api/src/services/analysis/index.ts` |
| Valuation (shared) | `packages/shared/src/valuation/calculate.ts` |
| Valuation (API wrapper) | `apps/api/src/services/valuation/index.ts` |
| Property API (CoreLogic) | `apps/api/src/services/property-api/providers/corelogic.ts` |
| Property API (ATTOM) | `apps/api/src/services/property-api/providers/attom.ts` |
| User settings loader | `apps/api/src/services/user-settings/index.ts` |
| GHL integration | `apps/api/src/services/ghl/index.ts` |
| Job state (DO) | `apps/api/src/durable-objects/analysis-job.ts` |
| DB schema | `apps/api/src/db/schema.ts` |
| Client-side recalc | `apps/dashboard/src/lib/recalc/index.ts` |
| Evaluation hooks | `apps/dashboard/src/hooks/use-report-settings.ts`, `use-analysis-evaluation.ts` |
| Analysis state (Jotai) | `apps/dashboard/src/atoms/analysis.ts` |
| SSE streaming hook | `apps/dashboard/src/hooks/use-analysis-sse.ts` |
| Client API helpers | `apps/dashboard/src/lib/client-api.ts` |
| Server API helpers | `apps/dashboard/src/lib/api.ts` |
| Sidebar navigation | `apps/dashboard/src/components/Sidebar.tsx` |
