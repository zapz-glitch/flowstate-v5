# ATTOM MCP — Endpoint & Resource Reference

Surface: `https://mcp.intelligence.attomdata.com` (MCP over streamable HTTP, JSON-RPC at the root path).

## Auth

- M2M: `POST https://mcp.intelligence.attomdata.com/token` — `client_credentials` + `resource=https://mcp.intelligence.attomdata.com` + `scope=openid`. Access token ~10 min.
- Interactive: `devin mcp login attom` (Descope) — tokens in `~/.local/share/devin/mcp/oauth/`; refresh tokens rotate, re-sync via `scripts/sync-attom-token.mjs`.
- A2A agents (separate hosts, same creds): data-analyst / property-and-place-insights / report-generation — `.intelligence.attomdata.com` subdomains. **Ops currently unentitled** — discovery works, `SendMessage` ops need ATTOM grant on client `P3H90cmcTUFzHvOS01MZH1goY5Ze`.

## Tools (`tools/call`)

| Tool | Input | Use |
|---|---|---|
| `get_property_data` | `property: {lookupMode, …}` + `datasets[]` | Bulk property fetch — the main pipeline call |
| `resolve_property_identity` | `lookupMode: attomId\|fipsApn\|address\|splitAddress` | Address → attomId. **`fipsApn` resolves parcels the address matcher misses** (dashes matter: `27-31-16-20610-001-0010` works, `273116206100010010` doesn't) |
| `find_property_candidates` | `address1, city, state, postalCode` | Loose candidate list — empty when the index has no match |
| `find_comparable_sales` | attomId + radius/months | Comp pool (cap 25) |
| `resolve_area_geo` | `name`, `state`, `county`, `place` | Named geography resolution |
| `get_community_data` | geo | Community/demographic context |
| `find_nearby_poi` | coords | Nearby POI evidence |
| `search_taxonomy` | term | Taxonomy lookup |

`splitAddress` form: `address1` (street line) + `address2` (city, state ZIP).

## Datasets (for `get_property_data`)

`identity`, `overview`, `geography-context`, `valuation`, `comparables`, `permits`, `fema-context`, `sales-history`, `tax-history`, `community-context`.

Subject set used by the pipeline: `identity, overview, geography-context, valuation, sales-history, tax-history, permits`.
Comp-detail set: `identity, overview, geography-context, sales-history, valuation`.

## Resources (`resources/read`) — attomId-keyed

| URI | Content |
|---|---|
| `property://{attomId}/identity` | Public identity and address header |
| `property://{attomId}/overview` | Normalized identity + core characteristics (beds, baths, living area, lot, year built, garage, pool/deck, zoning) + caveats |
| `property://{attomId}/geo` | Parcel centerpoint / lat-lng (for `find_nearby_poi`) |
| `property://{attomId}/geography-context` | Named geography context across supported slices |
| `property://{attomId}/valuation` | **AVM + value range + confidence, rental AVM, assessed trend, last sale, sales + comp summary** |
| `property://{attomId}/rental-valuation` | Rental value signal |
| `property://{attomId}/equity` | Estimated equity with assumptions/caveats |
| `property://{attomId}/market-context` | Nearby + ZIP-level market support |
| `property://{attomId}/comparables` | Default comp set with ATTOM defaults (results array + criteria) |
| `property://{attomId}/sales-history` | Recorded sale history |
| `property://{attomId}/tax-history` | Tax and assessment history |
| `property://{attomId}/ownership` | Current owner + occupancy context |
| `property://{attomId}/ownership-periods` | Sale-anchored ownership eras |
| `property://{attomId}/mortgage-history` | Mortgage/financing events — estate vs investor sale signal |
| `property://{attomId}/foreclosure-history` | Foreclosure activity |
| `property://{attomId}/timeline` | Analyst-friendly property chronology |
| `property://{attomId}/permits` | Permit history with coverage caveats |
| `property://{attomId}/schools` | Assigned/nearby schools + district + performance context |
| `property://{attomId}/fema-context` | FEMA/FIRM panel context with caveats |
| `taxonomy://catalog` | Taxonomy catalog |
| `mcp://catalog` | MCP catalog |

## Proven edge cases (verified 2026-10-02/03)

- **Address-string resolution is weak.** `800 40th St S, St. Petersburg` fails `address`, `splitAddress`, `find_property_candidates`, and raw-digit `fipsApn` — but resolves by **dashed STRAP APN**: `fipsApn fips=12103 apn=27-31-16-20610-001-0010` → attomId `18041599`. `apnSpellings()` in `providers/attom-mcp.ts` tries recorded/digits/FL-STRAP forms.
- **APN source without CoreLogic:** Census `geographies/onelineaddress` (free) → coords + county FIPS → county parcel GIS → APN. Implemented in `services/geo/parcel-gis.ts` (county registry — Pinellas verified via `egis.pinellas.gov`).
- **`$100` sale prices are nominal deed transfers** — evaluator drops them (non-market gate).
- **Assessed values** live in `valuation.assessedValueTrend.latestAssessedValue` (not the tax-history array shape).
- **Comp AVMs are often null**; subject AVM coverage is also spotty (absent on Westella/Red Leo/Cecil).
- **N4 neighborhood** populates ~4× more comps than legal subdivision names; census BG/tract stamps come from the free Census geocoder, not ATTOM.
