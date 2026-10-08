# Flowstate API

A standalone property valuation and underwriting API platform built on Cloudflare Workers.

## Architecture

This is a Turborepo monorepo with:

- **apps/api** - Hono-based REST API on Cloudflare Workers
- **apps/dashboard** - Next.js dashboard for API key management
- **packages/db** - Shared Drizzle schema and D1 database utilities

## Getting Started

### Prerequisites

- Node.js 20+
- pnpm (recommended) or npm
- Wrangler CLI (`npm install -g wrangler`)

### Installation

```bash
# Install dependencies
npm install

# Create D1 database
wrangler d1 create flowstate-api-db

# Copy the database ID and update wrangler.toml files in apps/api and apps/dashboard

# Run migrations
wrangler d1 execute flowstate-api-db --local --file=packages/db/migrations/0001_initial.sql
```

### Environment Setup

Create `.dev.vars` in `apps/api/`:
```
CORELOGIC_CLIENT_ID=your_client_id
CORELOGIC_CLIENT_SECRET=your_client_secret
```

Create `.dev.vars` in `apps/dashboard/`:
```
BETTER_AUTH_SECRET=your_secret_here
```

### Development

```bash
# Run all apps in development
npm run dev

# Or run individually
cd apps/api && npm run dev
cd apps/dashboard && npm run dev
```

### Deployment

```bash
# Deploy API
cd apps/api && npm run deploy

# Deploy Dashboard (after building with OpenNext)
cd apps/dashboard && npm run build && npm run deploy
```

## API Endpoints

### Authentication

All `/v1/*` endpoints require an API key:
```
Authorization: Bearer fs_your_api_key_here
```

### Endpoints

- `GET /health` - Health check
- `POST /v1/property/search` - Search property by address
- `GET /v1/property/:clipId` - Get property details
- `GET /v1/comparables/:clipId` - Get comparable sales
- `POST /v1/valuation/analyze` - Full property analysis
- `POST /v1/valuation/calculate` - Calculate valuation from ARV

## Plans

| Plan | Requests/Month | API Keys |
|------|---------------|----------|
| Free | 100 | 1 |
| Pro | 5,000 | 5 |
| Enterprise | Unlimited | Unlimited |

## Tech Stack

- **Runtime**: Cloudflare Workers
- **API Framework**: Hono
- **Dashboard**: Next.js 16 + OpenNext
- **Database**: Cloudflare D1 (SQLite)
- **ORM**: Drizzle
- **Auth**: Better Auth (email/password)
- **Property Data**: CoreLogic API
