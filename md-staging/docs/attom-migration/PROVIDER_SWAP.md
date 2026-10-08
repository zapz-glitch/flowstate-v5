# ATTOM Provider Swap + MCP Integration

Status: **planning** — read-only codebase scan complete, implementation
waiting on ATTOM API docs + MCP server docs from the product engineer.

## Rules for this change

1. **Clean swaps only.** Each Cotality/CoreLogic API call is replaced by
   its ATTOM equivalent at the same call site (or inside the same adapter
   method). No provider call is removed unless explicitly told to.
2. **MCP server for tool calling.** An ATTOM MCP server is added for tool
   calling alongside the HTTP swap. Details pending user-supplied docs.
3. **No unit tests.** Verify end-to-end per repo rules (real pipeline,
   `scripts/run-regression-tests.mjs`, or the `*.test.ts` harness).

## Where provider traffic lives

All provider access goes through the unified service — this is the swap
boundary. Nothing downstream (evaluation, appraisal, valuation, report
builder) knows which provider answered.

| Layer | File | Role |
|---|---|---|
| Adapter interface | `apps/api/src/services/property-api/types.ts` | `PropertyProviderAdapter` contract + `Normalized*` types both providers must produce |
| Orchestrator | `apps/api/src/services/property-api/index.ts` | `PropertyApi` — provider selection, KV caching (provider-scoped keys), call stats, `getPropertyBundle`, comp enrichment |
| Cotality adapter | `apps/api/src/services/property-api/providers/corelogic.ts` | Full implementation — primary today |
| Cotality code tables | `apps/api/src/services/property-api/providers/corelogic-codes.ts` | RiPT code→label lookups (Cotality-specific; ATTOM returns literal strings) |
| ATTOM adapter | `apps/api/src/services/property-api/providers/attom.ts` | Partial implementation — currently only reachable via explicit `PROPERTY_PROVIDER=attom` or the `*WithFallback` paths |
| Retrieval policy | `apps/api/src/services/property-api/retrieval-policy.ts` | Provider max-comps caps + pool-breadth audit (`CORELOGIC_MAX_COMPS`/`ATTOM_MAX_COMPS` both 100) |
| Pool merge | `apps/api/src/services/property-api/comparable-pool.ts` | Conflict-aware merge of default + expansion comp pools |
| Identity check | `apps/api/src/services/property-api/property-identity.ts` | `verifyPropertyIdentity` — defined; no callers found (confirm before relying on it) |
| Bundled API spec | `apps/api/src/services/property-api/providers/docs/corelogic-api-docs.json` | Cotality OpenAPI — reference for the old calls |

## Cotality call inventory (what gets swapped)

Auth: OAuth2 `client_credentials` → `POST https://prod.corelogicapi.com/oauth/token`
(`Basic base64(clientId:clientSecret)`), Bearer token cached in KV
(`cotality-token:{keyIndex}`). Up to 9 rotating credential pairs:
`CORELOGIC_CLIENT_ID{,_0.._8}` / `CORELOGIC_CLIENT_SECRET{,_0.._8}`.
Every outbound call first acquires a slot from the `RATE_LIMIT_COORDINATOR`
DO named `cotality-global-throttle` (50 req/min shared window).

| Adapter method | Cotality endpoint | Notes |
|---|---|---|
| `searchProperty` | `GET {BASE}/v2/properties/search` → `GET /v2/properties/{clip}/property-detail` | Two calls per lookup; `bestMatch=true`; `v1PropertyId` captured here = `parcelId` (`fipsCode:universalParcelId`) used by flood/AVM/building |
| `getPropertyById` | `GET /v2/properties/{clip}/property-detail` | Also drives `enrichComparables` — one paid call **per comp** |
| `getComparables` | `GET /v2/properties/{clip}/comparables` | Params: `maxComps` (max 100, no pagination), `searchDistance`, `monthsBack`, `minBeds/maxBeds`, `minBaths/maxBaths`, `minBldgSqFt/maxBldgSqFt`, `sortBy=Distance`. Provider always restricts to subject land-use |
| `getBuildingPermits` | `GET /v2/properties/{clip}/building-permits` | strictNotFound; permit-age feeds major-item derivation |
| `getFloodZone` | `GET {SPATIAL}/spatial-api/flood-zone-determination` (`api-prod.corelogic.com`) | Coordinate fallback |
| `getFloodZoneByParcel` | `GET /property/{parcelId}/flood-zone` | Preferred; keyed on `fipsCode:universalParcelId` |
| `getAvm` | `GET /property/{parcelId}/avm/thv/{model}` | model=`thvMarketingStandard`; KV circuit breaker after 3 entitlement failures (`avm:disabled:*`, 7d) |
| `getBuildingDetail` | `GET /property/{parcelId}/building` | Literal-text condition/style/foundation/HVAC/parking; supplements coded detail block for subject AND enriched comps |
| `corelogicTypeahead` | `GET /v2/properties/typeahead` | Called directly by `routes/typeahead.ts` (bypasses adapter) |

Base URL: `https://property.corelogicapi.com` unless noted.

## ATTOM adapter — current state

Auth: `apikey` header on every request; env `ATTOM_API_KEY`
(**not yet present in `apps/api/.dev.vars`** — needs to be added).

| Adapter method | ATTOM endpoint | Status |
|---|---|---|
| `searchProperty` | `GET /propertyapi/v1.0.0/property/expandedprofile?address1&address2` + `GET /propertyapi/v1.0.0/attomavm/detail` (parallel) | Implemented |
| `getPropertyById` | `GET /propertyapi/v1.0.0/property/detail?attomid={id}` | Implemented |
| `getComparables` | `GET /property/v2/salescomparables/propid/{id}` | Implemented — `searchType=Radius`, `miles`, `minComps`, `maxComps`, `saleDateRange`, `bedroomsRange`, `bathroomRange`, `sqFeetRange`, `includeFullSalesOnly=false`, `distressed=IncludeDistressed`. XML-style `@`-prefixed response; comp payload nested in `COMPARABLE_PROPERTY_ext` |
| `getBuildingPermits` | `GET /propertyapi/v1.0.0/property/buildingpermits?address1&address2` | Implemented (address-keyed, not ID-keyed) |
| `getFloodZone` | — | Stub → `NOT_SUPPORTED` |
| `getFloodZoneByParcel` | — | **Not implemented** |
| `getAvm` | — | **Not implemented** (AVM only fetched inline during search) |
| `getBuildingDetail` | — | **Not implemented** |
| typeahead | — | **Not implemented** |

Known ATTOM quirks already encoded (see header comment in `attom.ts`):
`lotSize1`=acres / `lotSize2`=sqft; coordinates live in `location`, not
`address`; `absenteeOwnerStatus`='O' means owner-occupied; 400 +
`SuccessWithoutResult` = not-found.

## Call sites that will exercise the swap

| Caller | File | What it calls |
|---|---|---|
| Streaming analysis | `apps/api/src/durable-objects/analysis-job.ts` (`runStreamingAnalysis`) | `searchProperty` → `getComparables` (+expansion refetch) → `getBuildingPermits` → `getFloodZoneForProperty` → `getAvm`/`getBuildingDetail` (gated on `parcelId`) → `enrichComparables` (per-comp `getPropertyById` + `getBuildingDetail`) |
| GHL webhook | `apps/api/src/routes/webhooks/ghl.ts` | `getPropertyBundle` (full pipeline equivalent) |
| Typeahead | `apps/api/src/routes/typeahead.ts` | `corelogicTypeahead` — **direct Cotality import, needs its own swap** |
| Permits action | `apps/api/src/routes/user-reports.ts` | `getBuildingPermits` on demand from a saved report |
| Health | `apps/api/src/routes/health.ts` | `getKeyStatus` — reports `provider: 'corelogic'` literal |

## Hardcoded Cotality references to swap/update

- `apps/api/src/routes/health.ts` — `/health/keys` reports `provider:
  'corelogic'` and a CoreLogic-specific message.
- `apps/api/src/routes/analyze.ts` — `/analyze/defaults` calls
  `resolveCandidateLimit(c.env, 'corelogic')` (harmless today: both maxes
  are 100; update for correctness).
- `apps/api/src/routes/comp-selection.ts` — `provider: 'corelogic'` ×3
  when reconstructing `Normalized*` objects from request bodies.
- `apiCallStats.corelogic` field name in `analysis-job.ts` / `ghl.ts` —
  consumed by report/audit surfaces; renaming is a contract change, flag
  before touching.
- `wrangler.toml` `PROPERTY_PROVIDER = "corelogic"` + `.dev.vars`
  `PROPERTY_PROVIDER="corelogic"` — the actual cutover lever.
- `types.ts` — `ATTOM_API_KEY` declared; CoreLogic key-pair block stays
  until removal is approved.

## ATTOM endpoint map (from api.developer.attomdata.com/docs)

Base: `https://api.gateway.attomdata.com`. Auth: `apikey` header on every
request; `Accept: application/json`. No-match returns `400` +
`status.msg = "SuccessWithoutResult"` (uncharged). Legacy param `id` is
an accepted alias for `attomid`. Base paths in use:
`/propertyapi/v1.0.0`, `/property/v2` (salescomparables),
`/propertyapi/v4`, `/v4` (community/location), `/areaapi/v2.0.0`,
`/poisearch/v2.0.0`.

Source: 57-page PDF export of the developer docs
(`ATTOM API Documentation.pdf`, verified 2026-09-29) + context7 mirror.
Flood boundary types confirmed absent from the Area API geoType list
(ST/CO/CS/PL/ZI/N1–N4/DB/SB/PZ/CI); flood data only exists inside
`/v4/neighborhood/community` natural-disaster attributes. No
autocomplete/typeahead endpoint exists anywhere in the catalog.

### Proposed call-for-call mapping

| Adapter method | Cotality call (today) | ATTOM replacement |
|---|---|---|
| `searchProperty` | `/v2/properties/search` + `/{clip}/property-detail` | `/propertyapi/v1.0.0/property/expandedprofile?address1&address2` + `/propertyapi/v1.0.0/attomavm/detail` (already implemented) |
| `getPropertyById` | `/v2/properties/{clip}/property-detail` | `/propertyapi/v1.0.0/property/detail?attomid={id}` (implemented) |
| `getComparables` | `/v2/properties/{clip}/comparables` | `/property/v2/salescomparables/propid/{id}` (implemented; also `/salescomparables/apn/{apn}/{county}/{state}` variant) |
| `getBuildingPermits` | `/v2/properties/{clip}/building-permits` | `/propertyapi/v1.0.0/property/buildingpermits?address1&address2` (implemented; also accepts `attomid`) |
| `getAvm` | `/property/{parcelId}/avm/thv/{model}` | `/propertyapi/v1.0.0/attomavm/detail?attomid={id}` or `/propertyapi/v1.0.0/avm/detail` — attomid/address keyed, replaces parcel key. `attomavm` = cascaded multi-model; `avm` = single model with high/low/scr |
| `getBuildingDetail` | `/property/{parcelId}/building` | `/propertyapi/v1.0.0/property/detail?attomid={id}` — construction/utilities/levels live on the same payload as `getPropertyById`; verify condition/style coverage on real responses, else `/allevents/detail` or `expandedprofile` |
| `getFloodZone` / `getFloodZoneByParcel` | `/spatial-api/flood-zone-determination` + `/property/{parcelId}/flood-zone` | **No dedicated ATTOM flood endpoint found.** Options: (a) keep `NOT_SUPPORTED` (listing-scrape First Street signal is the effective path today); (b) `geoIdV4` flood-zone area type + `areaapi`/`v4` lookups; (c) `/v4/neighborhood/community` natural-disaster section. **Needs product decision** |
| `corelogicTypeahead` | `/v2/properties/typeahead` | **No ATTOM autocomplete/typeahead endpoint.** Closest: `/property/snapshot`, `/property/address` radius, or `poisearch/v2.0.0/poi/Street+Address`. **Needs product decision** (e.g. Google Places, which the dashboard already keys) |

### Other ATTOM resources available (not currently called — for reference)

- `/assessment/detail|snapshot`, `/assessmenthistory/detail` — tax/assessment
- `/sale/detail|snapshot`, `/saleshistory/detail|expandedhistory|basichistory|snapshot` — transaction flags (foreclosure, cash, interfamily) for comp enrichment
- `/avm/snapshot`, `/avmhistory/detail`, `/valuation/rentalavm`, `/valuation/homeequity`
- `/allevents/detail|snapshot` — consolidated property event history (single property per request)
- `/school/*`, `/v4/neighborhood/community` (crime/demographics/climate/natural disasters), `/v4/neighborhood/poi*`, `/transaction/salestrend`
- `/geoid/lookup`, `/geoid/legacyLookup`, `/areaapi/v2.0.0/*`, `/enumerations/detail`

## Semantic gaps a clean swap must resolve

1. **Property ID model.** Cotality `id` = CLIP; ATTOM `id` = attomId.
   Cache keys are provider-scoped so this is safe, but saved reports /
   eval-result cache entries keyed on old IDs will simply miss — expected.
2. **`parcelId` doesn't exist in ATTOM.** Flood-zone-by-parcel, THV AVM,
   and building-detail are all keyed on `fipsCode:universalParcelId`.
   ATTOM calls must be re-pointed at ATTOM-keyed equivalents (attomId or
   address) — pending docs. `analysis-job.ts` gates these calls on
   `property.parcelId`, so under ATTOM they silently skip unless we
   re-key.
3. **Comp enrichment cost shape.** Today each comp costs one
   `property-detail` call (+ conditional `/building`). ATTOM v2 comps
   return fewer fields; per-comp `property/detail` calls are the clean
   swap but the field coverage (subdivision, census tract, transaction
   flags, construction) needs verification against docs.
4. **Throttle.** `acquireCotalitySlot` guards the 50/min Cotality window.
   ATTOM rate limit TBD — same DO (`RATE_LIMIT_COORDINATOR`) can host a
   second named window, or calls go unthrottled; needs a decision.
5. **Token auth → apikey auth.** ATTOM has no token mint/rotate/KV-share
   path; the CoreLogic credential-rotation machinery (9 key pairs,
   cooldowns, entitlement rotation) has no ATTOM analog unless multiple
   ATTOM keys are provided.
6. **Flood zone.** ATTOM `getFloodZone` stub returns `NOT_SUPPORTED`;
   today's effective path is the First Street signal scraped from the
   listing, so this may be acceptable — confirm.

## MCP integration (pending user docs)

- New ATTOM MCP server for tool calling — transport, hosting (Worker
  route vs external), auth, and tool surface TBD from supplied docs.
- Open question: which existing flows (if any) move from REST adapter
  calls to MCP tool calls vs. MCP being additive tooling.

## Verification plan (once swapped)

- `npm run dev` + `npm run dev:check`, then a real address through
  `/v1/analyze` on ATTOM and a diff of the normalized bundle vs the
  Cotality baseline (fields, comp count, enrichment presence).
- `node scripts/run-regression-tests.mjs api` harness.
- `npx tsc --noEmit` in `apps/api`.
- Prod: one known-good address + one known-insufficient-comps address
  (12717 Dunn Creek Rd / 1802 Hunters Gln NE, Marietta GA).

## Errors to route back to the product engineer

Any ATTOM endpoint that 4xx/5xx's or returns an unexpected shape during
the swap — the user will supply corrected endpoints/docs per call.
