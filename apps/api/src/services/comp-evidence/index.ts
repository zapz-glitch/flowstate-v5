/**
 * Comp evidence service — curb-appeal + listing-description condition
 * assessment for comparable sales.
 *
 * Replicates what a human appraiser does with a comp: pull its listing
 * (Zillow photos persist post-sale, and the agent-written description
 * usually survives — "fully renovated" vs "fixer upper" vs "as-is"), then
 * judge condition from curb appeal + description.
 *
 * Chain: photo-provider listing fetch (Zillow → Redfin → Realtor) →
 * download up to 4 photos → Clef classification → Luna fallback
 * (gpt-6-luna via OpenRouter) when Clef is absent or fails — same
 * output contract, same stamp. Comp-only; the subject's own
 * classification is a separate pipeline.
 *
 * This is INPUT-side enrichment only — it produces evidence for the comp
 * classifier; it does not touch appraisal math. Pipeline wiring stays
 * behind CLEF_COMP_CONDITION_ENABLED until verified on live data.
 */

import type { Env } from '../../types'
import { createPhotoService, type PropertyIdentifier, type PropertyPhotos } from '../photo-provider'
import { classifyCompCondition, isClefAvailable, CONDITION_SCALE, type ClefImage, type CompConditionResult } from '../clef'
import { createLLMProvider } from '../llm'

const MAX_IMAGES = 4
const MAX_IMAGE_BYTES = 4 * 1024 * 1024 // Clef per-image cap
const IMAGE_FETCH_TIMEOUT_MS = 8000

export interface CompEvidenceInput extends PropertyIdentifier {
  salePrice?: number
  saleDate?: string
  yearBuilt?: number
  squareFeet?: number
}

export interface CompConditionEvidence {
  propertyId: string
  listing: {
    source: string
    sourceUrl?: string
    description?: string
    whatsSpecial?: string[]
    features?: string[]
    photoCount: number
    /** Structured MLS/listing facts extracted from the listing page —
     *  the fields an appraiser reads when verifying a sale (HOA, parking,
     *  beds/baths, construction details). Absent fields were not on the page. */
    details?: {
      bedrooms?: number
      bathrooms?: number
      squareFeet?: number
      /** Larger sqft the listing's own copy markets (finished basement etc.)
       *  — recorded when it exceeds the structured figure by >33% */
      marketedSqft?: number
      yearBuilt?: number
      foundationType?: string
      style?: string
      stories?: number
      hoaFee?: number
      roof?: string
      construction?: string
      heating?: string
      cooling?: string
      flooring?: string[]
      appliances?: string[]
      exteriorFeatures?: string[]
      parking?: string
      pool?: boolean
      propertyType?: string
      daysOnMarket?: number
      status?: string
    }
  } | null
  condition: CompConditionResult | null
  /** Investor-marketed listing — deterministic keyword hit OR Clef agrees.
   *  Per owner rule: investor language disqualifies the 'updated'/'renovated'
   *  ARV stamp — these are median/lower-tier sales, whatever they look like. */
  investorSignal: boolean
  /** Which signals fired — 'keyword' | 'clef_noul' | 'clef_tier' */
  investorSignalSources: string[]
  /** Why classification didn't run — 'no_listing' | 'clef_unavailable' | fetch error */
  skippedReason?: string
}

/**
 * Largest sqft figure the listing's own copy claims — description +
 * highlights + features. Listings often show the tax-record sqft as the
 * structured field while marketing a larger "finished living area" (e.g.
 * a basement) — buyers price the marketed figure.
 */
function maxSqftClaim(listing: { description?: string | null; whatsSpecial?: string[] | null; features?: string[] | null }): number | null {
  const haystack = [listing.description ?? '', ...(listing.whatsSpecial ?? []), ...(listing.features ?? [])].join(' ')
  let max: number | null = null
  for (const m of haystack.matchAll(/(\d{1,3}(?:,\d{3})+)\s*(?:sq\.?\s*ft|sqft|square\s*feet|sf\b)/gi)) {
    const n = parseInt(m[1].replace(/,/g, ''), 10)
    if (Number.isFinite(n) && n >= 200 && (max == null || n > max)) max = n
  }
  return max
}

// Owner-calibrated keyword set — investor-marketed language in the listing
// description means median/lower-tier sale, never ARV evidence.
const INVESTOR_KEYWORDS_RE =
  /investment property|investor special|rental income|cash ?flow|tenant[- ]occupied|turnkey rental|add to (your )?portfolio|great rental|rental opportunity|income[- ]producing|cap rate|handyman special/i

function detectInvestorLanguage(listing: { description?: string; whatsSpecial?: string[]; features?: string[] }): boolean {
  const haystack = [listing.description ?? '', ...(listing.whatsSpecial ?? []), ...(listing.features ?? [])].join(' ')
  return INVESTOR_KEYWORDS_RE.test(haystack)
}

/**
 * Zillow CDN serves size variants by filename suffix. Full-res (-p_f,
 * cc_ft_1536) images blow Clef's 65k context (~60k tokens each) — the 384px
 * variant is ~38KB and still shows curb appeal clearly.
 */
function smallImageVariant(url: string): string {
  if (!/photos\.zillowstatic\.com\/fp\//.test(url)) return url
  return url
    .replace(/-(?:p_[a-z]|cc_ft_\d+|uncropped_scaled_within_\d+_\d+)(\.(?:jpe?g|webp))/i, '-cc_ft_384$1')
    .replace(/\?.*$/, '')
}

async function fetchImageAsBase64(originalUrl: string): Promise<ClefImage | null> {
  const candidates = originalUrl.includes('zillowstatic.com')
    ? [smallImageVariant(originalUrl), originalUrl]
    : [originalUrl]
  for (const url of candidates) {
    const image = await tryFetchImage(url)
    if (image) return image
  }
  return null
}

async function tryFetchImage(url: string): Promise<ClefImage | null> {
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; flowstate/1.0)' },
      signal: AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MS),
    })
    if (!resp.ok) return null
    const contentType = resp.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
    if (contentType !== 'image/png' && contentType !== 'image/jpeg' && contentType !== 'image/webp') {
      return null
    }
    const bytes = new Uint8Array(await resp.arrayBuffer())
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) return null
    let binary = ''
    for (const b of bytes) binary += String.fromCharCode(b)
    return { content_type: contentType, base64: btoa(binary) }
  } catch {
    return null
  }
}

/** Download up to MAX_IMAGES photos, skipping over-size/non-image entries. */
async function embedPhotos(photoUrls: string[]): Promise<ClefImage[]> {
  const results = await Promise.all(photoUrls.slice(0, MAX_IMAGES * 2).map(fetchImageAsBase64))
  return results.filter((x): x is ClefImage => x !== null).slice(0, MAX_IMAGES)
}

/**
 * Gather a comp's listing evidence and classify its condition.
 * Never throws — a failed fetch or Clef call returns a partial result.
 */
/** Evidence pin — comp stamps are cached by identity+sale so a re-run of
 *  the same report replays the SAME classification instead of re-rolling
 *  Clef + the listing scrape. A new sale produces a new key → re-stamp. */
const EVIDENCE_TTL = 30 * 86400
const evidenceKey = (c: CompEvidenceInput) =>
  `clef-evidence:${c.propertyId}:${c.saleDate ?? 'nosale'}:${c.salePrice ?? 0}`

/**
 * Luna fallback — the second reader in the comp-classification chain.
 * Clef (Workers AI) carries the vision read when bound; when it is absent
 * or fails, the same photos + listing text go to gpt-6-luna over
 * OpenRouter. The output contract is CompConditionResult — identical
 * fields, so the stamp path never knows which reader wrote it.
 *
 * Comp-only: the subject's own classification lives in a different
 * pipeline and never shares this call.
 */
const LUNA_COMP_MODEL = 'openai/gpt-6-luna'

const LUNA_COMP_PROMPT = `You are assessing a COMPARABLE property's condition at the time of its sale, as a real-estate appraiser would. Judge from the listing photos (if any) and the listing description text — never from the sale price.

Answer as strict JSON:
{
  "condition_label": one of ["Poor","Dated","Maintained","Updated","Renovated"],
  "renovated": number 0-1 — probability the property was renovated/updated for sale,
  "as_is": number 0-1 — probability it was sold as-is / fixer / deferred maintenance,
  "investor_language": number 0-1 — probability the listing markets to investors,
  "tier": one of ["investor","median","arv"] — investor-marketed or as-is sales are never ARV evidence however updated they look,
  "confidence": number 0-1 — your confidence in the condition_label
}`

export interface LunaCompAnswer {
  condition_label?: unknown
  renovated?: unknown
  as_is?: unknown
  investor_language?: unknown
  tier?: unknown
  confidence?: unknown
}

/** Map a Luna JSON answer onto the Clef output contract — pure, testable. */
export function parseLunaCompCondition(content: string): Omit<CompConditionResult, 'model' | 'modelVersion' | 'durationMs'> | null {
  let o: LunaCompAnswer
  try {
    o = JSON.parse(content.replace(/^```(?:json)?\s*|\s*```$/g, '').trim())
  } catch { return null }
  const label = typeof o.condition_label === 'string' ? o.condition_label : ''
  const idx = CONDITION_SCALE.findIndex((s) => s.startsWith(label))
  if (idx < 0) return null
  const prob = (v: unknown) => typeof v === 'number' ? Math.max(0, Math.min(1, v)) : 0
  const tier = o.tier === 'investor' || o.tier === 'arv' ? o.tier : 'median'
  return {
    raw: o as Record<string, unknown>,
    renovated: prob(o.renovated) >= 0.5,
    renovatedProbability: prob(o.renovated),
    asIs: prob(o.as_is) >= 0.5,
    asIsProbability: prob(o.as_is),
    investorLanguageProbability: prob(o.investor_language),
    tier,
    tierProbabilities: { investor: 0, median: 0, arv: 0, [tier]: 1 },
    conditionScore: idx,
    conditionLabel: CONDITION_SCALE[idx].split(' — ')[0],
    confidence: prob(o.confidence) || undefined,
  }
}

async function classifyCompConditionLuna(
  env: Env,
  input: Parameters<typeof classifyCompCondition>[1],
): Promise<CompConditionResult | null> {
  if (!env.OPENROUTER_API_KEY) return null
  const model = env.VISION_MODEL || env.OPENROUTER_MODEL || LUNA_COMP_MODEL
  const provider = createLLMProvider({
    provider: 'openrouter',
    apiKey: env.OPENROUTER_API_KEY,
    model,
  })
  const context =
    `Property: ${input.address ?? 'unknown'}${input.salePrice ? ` — sold $${input.salePrice.toLocaleString()}` : ''}` +
    `${input.yearBuilt ? `, built ${input.yearBuilt}` : ''}${input.squareFeet ? `, ${input.squareFeet}sf` : ''}\n` +
    (input.description ? `Listing description:\n${input.description}\n` : '') +
    (input.whatsSpecial?.length ? `Listing highlights: ${input.whatsSpecial.join('; ')}\n` : '') +
    (input.features?.length ? `Listed features: ${input.features.join('; ')}` : '')
  const started = Date.now()
  const res = await provider.execute({
    prompt: `${LUNA_COMP_PROMPT}\n\n${context}`,
    images: (input.images ?? []).slice(0, MAX_IMAGES).map((i) => ({ base64: i.base64, mimeType: i.content_type })),
    responseFormat: 'json',
    maxTokens: 1024,
  })
  if (!res.success || !res.data?.content) return null
  const parsed = parseLunaCompCondition(res.data.content)
  if (!parsed) return null
  return { ...parsed, model: LUNA_COMP_MODEL, modelVersion: model, durationMs: Date.now() - started }
}

export async function gatherCompConditionEvidence(
  env: Env,
  comp: CompEvidenceInput,
): Promise<CompConditionEvidence> {
  const key = evidenceKey(comp)
  const cached = await env.API_CACHE.get(key, 'json').catch(() => null) as CompConditionEvidence | null
  if (cached?.condition || cached?.listing) {
    // Backfill marketedSqft on evidence pinned before the scan existed —
    // the listing copy is already in the cache.
    if (cached.listing?.details && cached.listing.details.marketedSqft == null) {
      const m = maxSqftClaim(cached.listing)
      if (m != null) {
        const primary = cached.listing.details.squareFeet
        if (primary == null || m > primary * 1.33) {
          if (primary != null) cached.listing.details.marketedSqft = m
          else cached.listing.details.squareFeet = m
        }
      }
    }
    return cached
  }

  const evidence: CompConditionEvidence = {
    propertyId: comp.propertyId,
    listing: null,
    condition: null,
    investorSignal: false,
    investorSignalSources: [],
  }

  let photos: PropertyPhotos | null = null
  try {
    const photoService = createPhotoService(env, { provider: 'zillow' })
    if (photoService.isAvailable()) {
      const result = await photoService.fetchPhotos(comp, {
        maxPhotos: 8,
        includeDescription: true,
        includePriceHistory: false,
      })
      if (result.success) photos = result.data
    }
  } catch (error) {
    evidence.skippedReason = error instanceof Error ? error.message : 'listing fetch failed'
    return evidence
  }

  if (!photos) {
    evidence.skippedReason = 'no_listing'
    return evidence
  }

  evidence.listing = {
    source: photos.source,
    sourceUrl: photos.sourceUrl,
    description: photos.description,
    whatsSpecial: photos.whatsSpecial,
    features: photos.features,
    photoCount: photos.photos.length,
    details: {
      bedrooms: photos.bedrooms,
      bathrooms: photos.bathrooms,
      squareFeet: photos.squareFeet,
      yearBuilt: photos.yearBuilt,
      foundationType: photos.foundationType,
      style: photos.style,
      stories: photos.stories,
      hoaFee: photos.hoaFee,
      roof: photos.roof,
      construction: photos.construction,
      heating: photos.heating,
      cooling: photos.cooling,
      flooring: photos.flooring,
      appliances: photos.appliances,
      exteriorFeatures: photos.exteriorFeatures,
      parking: photos.parking,
      pool: photos.pool,
      propertyType: photos.propertyType,
      daysOnMarket: photos.daysOnMarket,
      status: photos.status,
    },
  }

  // Marketed-size scan — Zillow shows tax sqft AND the marketed living
  // area (finished basements/floors tax rolls miss). When the listing's
  // own copy claims a larger sqft than the structured figure, the
  // marketed size is the product buyers priced — record it so the comp's
  // size math can flag the conflict instead of anchoring on tax data.
  const marketedSqft = maxSqftClaim(evidence.listing)
  if (marketedSqft != null && evidence.listing.details) {
    const primary = evidence.listing.details.squareFeet
    if (primary == null || marketedSqft > primary * 1.33) {
      if (primary != null) evidence.listing.details.marketedSqft = marketedSqft
      else evidence.listing.details.squareFeet = marketedSqft
    }
  }

  // The keyword check never misses a literal "investment property" and runs
  // even when Clef is unavailable.
  if (detectInvestorLanguage(evidence.listing)) {
    evidence.investorSignalSources.push('keyword')
    evidence.investorSignal = true
  }

  // Curb appeal comes through the images; when the listing has none the
  // description alone still carries renovation/fixture language.
  const images = photos.photos.length > 0 ? await embedPhotos(photos.photos) : []

  // Clef is the primary reader; Luna is the fallback — absent binding or a
  // failed call both route here. The stamp contract is identical.
  const clefReady = isClefAvailable(env)
  try {
    if (clefReady) evidence.condition = await classifyCompCondition(env, {
      address: comp.address,
      salePrice: comp.salePrice,
      saleDate: comp.saleDate,
      description: photos.description,
      whatsSpecial: photos.whatsSpecial,
      features: photos.features,
      yearBuilt: comp.yearBuilt ?? photos.yearBuilt,
      squareFeet: comp.squareFeet ?? photos.squareFeet,
      images,
    })
  } catch { /* Clef failed — Luna tries next */ }

  if (!evidence.condition) {
    evidence.condition = await classifyCompConditionLuna(env, {
      address: comp.address,
      salePrice: comp.salePrice,
      saleDate: comp.saleDate,
      description: photos.description,
      whatsSpecial: photos.whatsSpecial,
      features: photos.features,
      yearBuilt: comp.yearBuilt ?? photos.yearBuilt,
      squareFeet: comp.squareFeet ?? photos.squareFeet,
      images,
    }).catch(() => null)
  }
  if (evidence.condition) {
    if (evidence.condition.investorLanguageProbability >= 0.5) {
      evidence.investorSignalSources.push(evidence.condition.model === 'openai/gpt-6-luna' ? 'luna_noul' : 'clef_noul')
    }
    if (evidence.condition.tier === 'investor') {
      evidence.investorSignalSources.push(evidence.condition.model === 'openai/gpt-6-luna' ? 'luna_tier' : 'clef_tier')
    }
    evidence.investorSignal ||= evidence.investorSignalSources.length > 0
  } else {
    evidence.skippedReason = clefReady ? 'clef+luna failed' : 'no condition reader'
  }

  // Pin the stamp — only persist meaningful evidence (a listing or a
  // classification); 'no_listing'/'clef_unavailable' partials stay
  // uncached so a retry can still find them.
  if (evidence.condition || evidence.listing) {
    void env.API_CACHE.put(key, JSON.stringify(evidence), { expirationTtl: EVIDENCE_TTL }).catch(() => {})
  }

  return evidence
}
