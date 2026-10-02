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
 * download up to 4 photos → Clef schema-bound classification.
 *
 * This is INPUT-side enrichment only — it produces evidence for the comp
 * classifier; it does not touch appraisal math. Pipeline wiring stays
 * behind CLEF_COMP_CONDITION_ENABLED until verified on live data.
 */

import type { Env } from '../../types'
import { createPhotoService, type PropertyIdentifier, type PropertyPhotos } from '../photo-provider'
import { classifyCompCondition, isClefAvailable, type ClefImage, type CompConditionResult } from '../clef'

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
  } | null
  condition: CompConditionResult | null
  /** Why classification didn't run — 'no_listing' | 'no_photos_ok' | 'clef_unavailable' | fetch error */
  skippedReason?: string
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
export async function gatherCompConditionEvidence(
  env: Env,
  comp: CompEvidenceInput,
): Promise<CompConditionEvidence> {
  const evidence: CompConditionEvidence = { propertyId: comp.propertyId, listing: null, condition: null }

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
  }

  if (!isClefAvailable(env)) {
    evidence.skippedReason = 'clef_unavailable'
    return evidence
  }

  // Curb appeal comes through the images; when the listing has none the
  // description alone still carries renovation/fixture language.
  const images = photos.photos.length > 0 ? await embedPhotos(photos.photos) : []

  try {
    evidence.condition = await classifyCompCondition(env, {
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
  } catch (error) {
    evidence.skippedReason = error instanceof Error ? error.message : 'clef failed'
  }
  return evidence
}
