/**
 * Redfin property-details enrichment — the "See all details from MLS" block.
 *
 * Redfin keeps the MLS detail block on the page after a home sells, so this
 * works for off-market comps the same as active listings — verified live:
 * a sold comp's page carries beds/baths, HOA, utilities, construction,
 * foundation, garage/pool, public record, and sale history.
 *
 * Chain: Firecrawl /v1/search (address → redfin.com/home/{id} URL) →
 * /v2/scrape markdown → gpt-6-luna structured extraction (the details block
 * is ~30 sections of mixed label:value and bullet lists — extraction, not
 * regex, is the reliable parse).
 *
 * Shadow evidence only — stamped on comp.listingDetails /
 * subject.listingDetails for the report and comp cards; nothing reads it
 * into appraisal math until live-verified.
 */

import { createLLMProvider } from '../llm'
import { ListingPhotoScraper, redfinAdapter } from '../photo-provider/providers/listing-scraper'
import type { Env } from '../../types'

const SCRAPE_ENDPOINT = 'https://api.firecrawl.dev/v2/scrape'
const CACHE_TTL = 7 * 24 * 60 * 60
const DETAILS_TIMEOUT_MS = 45_000

export interface RedfinPropertyDetails {
  // Identity
  beds?: number | null
  bathsFull?: number | null
  bathsHalf?: number | null
  squareFeet?: number | null
  yearBuilt?: number | null
  stories?: number | null
  lotSquareFeet?: number | null
  style?: string | null
  propertyType?: string | null
  // Money / carrying
  hoaMonthly?: number | null
  listPrice?: number | null
  daysOnRedfin?: number | null
  mlsSource?: string | null
  // Structure & features
  roof?: string | null
  foundation?: string | null
  construction?: string | null
  heating?: string | null
  cooling?: string | null
  flooring?: string[]
  appliances?: string[]
  exteriorFeatures?: string[]
  parking?: string | null
  garage?: string | null
  pool?: boolean | null
  utilities?: string[]
  interiorFeatures?: string[]
  // Community / schools / risks
  communityFeatures?: string[]
  schools?: Array<{ name: string; level?: string | null; rating?: number | null; assigned?: boolean | null; distanceMi?: number | null }>
  climateRisks?: {
    floodFactor?: number | null
    fireFactor?: number | null
    heatFactor?: number | null
    windFactor?: number | null
    airFactor?: number | null
  }
  // Records
  subdivision?: string | null
  zoning?: string | null
  apn?: string | null
  county?: string | null
  saleHistory?: Array<{ date: string; event: string; price: number | null }>
  // Provenance
  sourceUrl?: string
}

export interface RedfinDetailsResult {
  details: RedfinPropertyDetails | null
  sourceUrl?: string
  skippedReason?: string
}

const EXTRACTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    beds: { type: ['number', 'null'] },
    bathsFull: { type: ['number', 'null'] },
    bathsHalf: { type: ['number', 'null'] },
    squareFeet: { type: ['number', 'null'] },
    yearBuilt: { type: ['number', 'null'] },
    stories: { type: ['number', 'null'] },
    lotSquareFeet: { type: ['number', 'null'] },
    style: { type: ['string', 'null'] },
    propertyType: { type: ['string', 'null'] },
    hoaMonthly: { type: ['number', 'null'] },
    listPrice: { type: ['number', 'null'] },
    daysOnRedfin: { type: ['number', 'null'] },
    mlsSource: { type: ['string', 'null'] },
    roof: { type: ['string', 'null'] },
    foundation: { type: ['string', 'null'] },
    construction: { type: ['string', 'null'] },
    heating: { type: ['string', 'null'] },
    cooling: { type: ['string', 'null'] },
    flooring: { type: 'array', items: { type: 'string' } },
    appliances: { type: 'array', items: { type: 'string' } },
    exteriorFeatures: { type: 'array', items: { type: 'string' } },
    parking: { type: ['string', 'null'] },
    garage: { type: ['string', 'null'] },
    pool: { type: ['boolean', 'null'] },
    utilities: { type: 'array', items: { type: 'string' } },
    interiorFeatures: { type: 'array', items: { type: 'string' } },
    communityFeatures: { type: 'array', items: { type: 'string' } },
    schools: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string' },
          level: { type: ['string', 'null'] },
          rating: { type: ['number', 'null'] },
          assigned: { type: ['boolean', 'null'] },
          distanceMi: { type: ['number', 'null'] },
        },
        required: ['name', 'level', 'rating', 'assigned', 'distanceMi'],
      },
    },
    climateRisks: {
      type: ['object', 'null'],
      additionalProperties: false,
      properties: {
        floodFactor: { type: ['number', 'null'] },
        fireFactor: { type: ['number', 'null'] },
        heatFactor: { type: ['number', 'null'] },
        windFactor: { type: ['number', 'null'] },
        airFactor: { type: ['number', 'null'] },
      },
      required: ['floodFactor', 'fireFactor', 'heatFactor', 'windFactor', 'airFactor'],
    },
    subdivision: { type: ['string', 'null'] },
    zoning: { type: ['string', 'null'] },
    apn: { type: ['string', 'null'] },
    county: { type: ['string', 'null'] },
    saleHistory: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          date: { type: 'string' },
          event: { type: 'string' },
          price: { type: ['number', 'null'] },
        },
        required: ['date', 'event', 'price'],
      },
    },
  },
  required: [
    'beds', 'bathsFull', 'bathsHalf', 'squareFeet', 'yearBuilt', 'stories',
    'lotSquareFeet', 'style', 'propertyType', 'hoaMonthly', 'listPrice',
    'daysOnRedfin', 'mlsSource', 'roof', 'foundation', 'construction',
    'heating', 'cooling', 'flooring', 'appliances', 'exteriorFeatures',
    'parking', 'garage', 'pool', 'utilities', 'interiorFeatures',
    'communityFeatures', 'schools', 'climateRisks',
    'subdivision', 'zoning', 'apn', 'county', 'saleHistory',
  ],
}

const EXTRACTION_PROMPT = `Extract the property's MLS details from this Redfin listing page markdown.
Return JSON matching the schema. Rules:
- Use null (not 0 or guesses) for any field absent from the page.
- beds/bathsFull/bathsHalf: the detail sections may say "5 bedrooms", "2 full baths", "1 half bath" — split full vs half baths.
- hoaMonthly: dollars per month from "HOA Dues"/"HOA & community" (e.g. "$60/mo" or "approx. $60/month" → 60).
- pool: true only when the page lists a private pool (not community pool amenities).
- parking/garage: short text (e.g. "Attached 2-car garage (approx. 20x20)", "2 car garage").
- subdivision: legal subdivision name if shown in Property details/Public facts.
- saleHistory: the "Sale history" table rows — date, event (Sold/Listed/etc), price (null when unpriced).
- interiorFeatures: interior detail bullets (bedrooms/baths breakdown is separate — capture kitchen, laundry, interior finish items).
- communityFeatures: HOA/community amenity items ("clubhouse, fitness center, pool", gated, playground, sidewalks, deed restrictions).
- schools: the "Schools" section rows — name, level (Elementary/Middle/High), GreatSchools rating number, assigned flag, distance in miles.
- climateRisks: the "Climate risks" block — "N/10 X Factor" scores for flood/fire/heat/wind/air; null for factors absent from the page.
- Ignore the neighborhood/comparable-homes sections — extract only THIS property.

MARKDOWN:
`

export async function fetchRedfinPropertyDetails(
  env: Env,
  ident: { propertyId?: string; address: string; city?: string; state?: string; zipCode?: string },
  cache?: KVNamespace | null,
): Promise<RedfinDetailsResult> {
  if (!env.FIRECRAWL_API_KEY) return { details: null, skippedReason: 'no_firecrawl_key' }
  if (!env.OPENROUTER_API_KEY) return { details: null, skippedReason: 'no_openrouter_key' }

  const fullAddress = [ident.address, ident.city, ident.state, ident.zipCode].filter(Boolean).join(', ')
  // v3 — schema bumps (schools, climate, interior/community) and resolver
  // changes get a fresh key so stale entries aren't served.
  const cacheKey = `redfin:details-v3:${fullAddress.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
  if (cache) {
    try {
      const hit = await cache.get<RedfinDetailsResult>(cacheKey, 'json')
      if (hit?.details) return hit
    } catch { /* best-effort */ }
  }

  // URL resolution reuses the listing-scraper's 3-step chain (Firecrawl
  // search → DuckDuckGo → legacy scrape) — every result street-number
  // validated, so a neighbor's page can never stamp wrong details.
  const scraper = new ListingPhotoScraper({
    apiKey: env.FIRECRAWL_API_KEY,
    openrouterApiKey: env.OPENROUTER_API_KEY,
    openrouterModel: env.VISION_MODEL || env.OPENROUTER_MODEL,
    cache: cache ?? undefined,
  })
  const url = await scraper.resolveUrl(
    {
      propertyId: ident.propertyId ?? ident.address,
      address: ident.address,
      city: ident.city ?? '',
      state: ident.state ?? '',
      zipCode: ident.zipCode ?? '',
    },
    redfinAdapter,
  )
  if (!url) return { details: null, skippedReason: 'no_redfin_page' }

  let markdown: string
  try {
    const resp = await fetch(SCRAPE_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.FIRECRAWL_API_KEY}` },
      body: JSON.stringify({ url, formats: ['markdown'], timeout: DETAILS_TIMEOUT_MS }),
      signal: AbortSignal.timeout(DETAILS_TIMEOUT_MS + 5000),
    })
    if (!resp.ok) return { details: null, skippedReason: `scrape_${resp.status}`, sourceUrl: url }
    const data = (await resp.json()) as { data?: { markdown?: string } }
    markdown = data.data?.markdown ?? ''
    if (markdown.length < 2000) return { details: null, skippedReason: 'thin_page', sourceUrl: url }
  } catch {
    return { details: null, skippedReason: 'scrape_failed', sourceUrl: url }
  }

  const provider = createLLMProvider({
    provider: 'openrouter',
    apiKey: env.OPENROUTER_API_KEY,
    model: env.VISION_MODEL || env.OPENROUTER_MODEL || 'google/gemini-2.5-flash',
  })
  const result = await provider.execute({
    prompt: EXTRACTION_PROMPT + markdown.slice(0, 60_000),
    responseFormat: 'json',
    jsonSchema: { name: 'redfin_property_details', schema: EXTRACTION_SCHEMA },
    maxTokens: 4096,
  })
  if (!result.success || !result.data?.content) return { details: null, skippedReason: 'extraction_failed', sourceUrl: url }

  try {
    const parsed = JSON.parse(result.data.content) as RedfinPropertyDetails
    parsed.sourceUrl = url
    const out: RedfinDetailsResult = { details: parsed, sourceUrl: url }
    if (cache) {
      try { await cache.put(cacheKey, JSON.stringify(out), { expirationTtl: CACHE_TTL }) } catch { /* best-effort */ }
    }
    return out
  } catch {
    return { details: null, skippedReason: 'extraction_parse_failed', sourceUrl: url }
  }
}
