# Flowstate API

Property valuation and underwriting API built on Cloudflare Workers.

## Endpoints

### Health (No Auth)

- `GET /health` - Health check
- `GET /health/db` - Database health check

### Property (Auth Required)

- `POST /v1/property/search` - Search property by address
- `GET /v1/property/:clipId` - Get property details

### Comparables (Auth Required)

- `GET /v1/comparables/:clipId` - Get comparable sales

### Valuation (Auth Required)

- `POST /v1/valuation/analyze` - Full property analysis with ARV, MAO, and investment metrics
- `POST /v1/valuation/calculate` - Calculate valuation from provided ARV

## Authentication

All `/v1/*` endpoints require an API key in the Authorization header:

```
Authorization: Bearer your_api_key_here
```

## Development

```bash
# Install dependencies
npm install

# Run locally
npm run dev

# Type check
npm run typecheck

# Deploy
npm run deploy
```

## Environment Variables

Create `.dev.vars` from `.dev.vars.example`:

```
CORELOGIC_CLIENT_ID=your_client_id
CORELOGIC_CLIENT_SECRET=your_client_secret
```

## API Examples

### Search Property

```bash
curl -X POST https://api.flowstate.homes/v1/property/search \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"streetAddress": "123 Main St", "city": "Austin", "state": "TX"}'
```

### Full Analysis

```bash
curl -X POST https://api.flowstate.homes/v1/valuation/analyze \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "streetAddress": "123 Main St",
    "city": "Austin",
    "state": "TX",
    "rehabLevel": 2,
    "searchDistance": 1,
    "maxComps": 10
  }'
```

### Calculate Valuation

```bash
curl -X POST https://api.flowstate.homes/v1/valuation/calculate \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "arv": 450000,
    "subjectSqft": 1800,
    "rehabLevel": 2
  }'
```

## Response Format

All responses follow this format:

```json
{
  "success": true,
  "data": { ... }
}
```

Error responses:

```json
{
  "success": false,
  "error": "Error message"
}
```
