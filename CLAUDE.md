# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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

## Architecture

This is a Turborepo monorepo for a **real estate underwriting/valuation API platform** deployed on Cloudflare.

### Workspaces

- **apps/api** - Hono REST API on Cloudflare Workers
- **apps/dashboard** - Next.js 15 dashboard (deployed via OpenNext on Cloudflare)
- **packages/shared** - Shared valuation calculation logic (used by both API and dashboard)

### API Structure (apps/api)

```
src/
├── index.ts              # Hono app entry, route mounting, global middleware
├── types.ts              # All TypeScript types (Env, API responses)
├── db/
│   └── schema.ts         # Drizzle ORM schema (all tables)
├── lib/
│   └── auth.ts           # Better Auth session auth helper
├── middleware/
│   └── auth.ts           # API key authentication, quota checking, usage logging
├── routes/
│   ├── health.ts         # Health check endpoints (no auth)
│   ├── auth.ts           # Better Auth handler (sign-in, sign-up, sign-out)
│   ├── user.ts           # User profile, API keys, usage (session auth)
│   ├── analyze.ts        # Main analysis endpoint (API key auth, async via Workflows)
│   ├── appraisal-rules.ts  # Appraisal rule presets CRUD (session auth)
│   ├── rehab-config.ts   # Rehab pricing config CRUD (session auth)
│   ├── deal-params.ts    # Deal parameters CRUD (session auth)
│   ├── location-settings.ts  # Per-location setting overrides CRUD (session auth)
│   ├── major-item-costs.ts   # Major item cost overrides CRUD (session auth)
│   ├── ghl-settings.ts   # GoHighLevel CRM integration settings (session auth)
│   ├── user-reports.ts   # Saved analysis reports & sharing (session auth)
│   ├── reports.ts        # Public shared report access (no auth / password-protected)
│   ├── sse-stream.ts     # SSE real-time analysis progress (signed token auth)
│   └── webhooks/
│       └── ghl.ts        # GHL webhook receiver (self-authenticating via URL secret)
├── durable-objects/
│   ├── analysis-job.ts   # Durable Object for job state & SSE streaming
│   ├── rate-limit-coordinator.ts  # Coordinates rate limits across API keys
│   └── firecrawl-rate-limiter.ts  # Rate limiter for Firecrawl API
├── workflows/
│   ├── analysis-workflow.ts  # Cloudflare Workflow for multi-step analysis
│   └── types.ts           # Workflow parameter types
└── services/
    ├── property-api/     # Property data provider (ATTOM/CoreLogic, switchable via PROPERTY_PROVIDER env)
    ├── appraisal/        # Appraisal rules engine (3-pass filters & adjustments)
    ├── classification/   # Property classification (As-Is vs After-Renovation via MLS keywords)
    ├── analysis/         # Shared analysis logic & response building
    ├── valuation/        # ARV/valuation calculations, rehab cost estimates
    ├── user-settings/    # Loads all user settings with location override resolution
    ├── ghl/              # GoHighLevel CRM integration service
    └── photo-provider/   # Photo fetching from Zillow via Firecrawl
```

## Core Domain Concepts

### Property Classification System

Properties are classified into two categories based on condition:

| Classification | Description | Use Case |
|---------------|-------------|----------|
| **as_is** | Distressed, needs work | Current market value / wholesale |
| **after_renovation** | Recently renovated, turnkey | Target ARV for flips |

Classification is determined by MLS remarks keyword analysis (58 as-is keywords, 57 after-renovation keywords) with strong/supporting tiers for confidence scoring.

### Appraisal Rules Engine

Located in `services/appraisal/`. Evaluates comps using a **3-pass fallback system**:

**Filters** (pass/fail criteria):
- `subdivision_match` - Same subdivision as subject
- `sale_age` - Days since sale (default: 30 days)
- `sqft_diff` - Square footage difference (default: 250 sqft)
- `year_built_diff` - Year built difference (default: 10 years)
- `distance` - Miles from subject (default: 0.5 miles)

**Three-Pass Evaluation:**
1. **Pass 1** — Full filters (subdivision + all rules) → best 3 comps
2. **Pass 2** — Relax subdivision (disabled), all other filters active
3. **Pass 3** — Triple all numeric thresholds, subdivision disabled

**Adjustments** (price modifications):
- Old comp discount (scales up to 15% for sales >90 days old)
- Bedroom adjustment ($15,000/bed difference)
- Bathroom adjustment ($10,000/bath difference)
- Pool adjustment ($10,000, disabled by default)
- Garage adjustment ($10,000, disabled by default)

### ARV Calculation

```
Per-comp ARV = (adjustedPrice / compSqft) × subjectSqft
ARV          = avg(per-comp ARV) across up to 3 selected comps
```

Best comp selection priority: subdivision match → filter pass rate → closest distance.

### Valuation Formulas

```
Total Rehab    = (subjectSqft × perSqft rate) + Σ(major items) + additionPlay
Closing Costs  = ARV × closingCostsPercent (default 8%)
Carrying Costs = ARV × carryingCostsPercent (default 2%)
Buy Price      = ARV − Total Rehab − Closing Costs − Carrying Costs − Flip Profit
Wholesale Price= Buy Price − Wholesale Fee
Total Investment = Buy Price + Total Rehab
Projected Profit = ARV − Total Investment − Closing Costs − Carrying Costs
ROI            = (Projected Profit / Total Investment) × 100
```

### Recommendation Thresholds

| Recommendation | ROI | Buy Price % of ARV |
|---------------|-----|-------------------|
| Strong Buy | > 25% | < 65% |
| Buy | > 15% | < 75% |
| Hold | > 8% or | < 80% |
| Pass | ≤ 8% | ≥ 80% |

## Async Analysis Flow

The analysis endpoint uses Cloudflare Workflows for durable async processing:

1. **POST /v1/analyze** - Starts workflow, returns `jobId` + `streamUrl` + `pollUrl`
2. **GET /v1/analyze/jobs/:jobId** - Poll for status
3. **GET /sse/analyze/:jobId** - SSE real-time progress streaming via Durable Object (requires signed token from POST /v1/analyze/stream-token)

```
Client -> POST /v1/analyze -> Workflow -> Durable Object -> SSE Stream
                                |
                                v
                    Property API (ATTOM/CoreLogic)
                                |
                                v
                    Appraisal + Classification
                                |
                                v
                    ARV + Valuation Calculation
```

## Authentication

- **Dashboard auth**: Better Auth (email/password) with sessions in D1. All dashboard routes use session cookies.
- **API auth**: Bearer token with SHA-256 hashed API keys stored in `api_keys` table. Used for `/v1/*` routes.
- **SSE auth**: Short-lived HMAC-SHA256 signed tokens (5-minute expiry) for EventSource connections.
- **Webhook auth**: Self-authenticating via URL-embedded secret + X-API-Key header.
- Rate limit headers: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`

## Database Schema (apps/api/src/db/schema.ts)

Key tables:
- **Auth**: `user`, `session`, `account`, `verification` (Better Auth)
- **API**: `apiKeys`, `apiUsageLogs`, `subscriptions`
- **Reports**: `savedReports` (analysis results, sharing/password support)
- **Settings**: `appraisalRulePreset` + `appraisalRuleFilter` + `appraisalRuleAdjustment`, `rehabConfig`, `dealParams`, `majorItemCosts`, `locationSettings`
- **Integrations**: `ghlSettings` (GoHighLevel CRM)

Plan limits defined in `PLAN_LIMITS` constant: free (100 req/mo, 1 key), pro (5000 req/mo, 5 keys), enterprise (unlimited)

## External Services

- **ATTOM Data API**: Primary property data provider (search, details, comparables). Configured via `PROPERTY_PROVIDER=attom` env var. Client in `services/property-api/providers/attom.ts`.
- **CoreLogic API**: Alternate property data provider. Supports key rotation across multiple API keys. Client in `services/property-api/providers/corelogic.ts`.
- **Firecrawl API**: Zillow scraping for photos and supplemental property data (beds, baths, sqft, etc.). Rate-limited via Durable Object.
- **OpenRouter API**: Unified LLM access for AI-powered comp selection (optional).
- **GoHighLevel API**: CRM integration for pushing analysis results to GHL opportunities.
- **Cloudflare D1**: SQLite database, accessed via Drizzle ORM
- **Cloudflare Workflows**: Durable async analysis orchestration with automatic retries
- **Cloudflare Durable Objects**: Job state management, SSE streaming, rate limiting

## Environment Variables

**apps/api/.dev.vars:**
```
# Property data provider: 'attom' or 'corelogic'
PROPERTY_PROVIDER=attom

# ATTOM Data API
ATTOM_API_KEY=

# CoreLogic API Keys (with rotation support)
CORELOGIC_CLIENT_ID=
CORELOGIC_CLIENT_SECRET=

# OpenRouter API (unified LLM access)
OPENROUTER_API_KEY=

# Firecrawl API (Zillow scraping)
FIRECRAWL_API_KEY=

# Dashboard Integration (shared secret for session-based auth)
DASHBOARD_INTERNAL_SECRET=

# Better Auth
BETTER_AUTH_SECRET=

# GoHighLevel Integration
GOHIGHLEVEL_API_KEY_INTEGRATION=
```

**apps/dashboard/.dev.vars:**
```
BETTER_AUTH_SECRET=
```

Database bindings are configured in `wrangler.toml` files (D1 database named `flowstate-api-db`).

## Evaluation Settings System

All analysis parameters are per-user configurable with location-based overrides:

| Setting | Route | Description |
|---------|-------|-------------|
| Appraisal Presets | `/appraisal-presets` | Named filter/adjustment configs; one marked as default |
| Rehab Config | `/rehab-config` | Per-tier rehab pricing table (5 levels × N ARV tiers) with custom tier ranges |
| Deal Parameters | `/deal-params` | Closing %, carrying %, wholesale fee, flip profit override |
| Major Item Costs | `/major-item-costs` | Per-item repair costs (17 items: roof, HVAC, foundation, etc.) |
| Location Overrides | `/location-settings` | Per-market overrides (zip > city+state > state) for any of the above |

**Settings Resolution Order** (most specific wins):
```
request body params → zip override → city+state override → state override → user defaults → system defaults
```

## Key Implementation Files

| Feature | Primary File(s) |
|---------|----------------|
| Analysis endpoint | `routes/analyze.ts` |
| Analysis workflow | `workflows/analysis-workflow.ts` |
| Appraisal rules (3-pass) | `services/appraisal/index.ts`, `services/appraisal/evaluator.ts` |
| Property classification | `services/classification/index.ts` |
| Response building | `services/analysis/index.ts` - `buildAnalysisResponse()` |
| Valuation calculator | `packages/shared/src/valuation/calculate.ts` (shared), `services/valuation/index.ts` (API) |
| Property API (ATTOM) | `services/property-api/providers/attom.ts` |
| Property API (CoreLogic) | `services/property-api/providers/corelogic.ts` |
| User settings loader | `services/user-settings/index.ts` - `loadUserAnalysisSettings()` |
| GHL integration | `services/ghl/index.ts` |
| Job state (DO) | `durable-objects/analysis-job.ts` |
| Client-side recalculation | `apps/dashboard/src/lib/recalc/index.ts` |
