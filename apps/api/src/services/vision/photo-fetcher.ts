/**
 * Zillow Photo Fetcher
 *
 * Fetches property photos from Zillow pages for vision analysis.
 * Uses web scraping to extract photo URLs from Zillow property pages.
 *
 * Note: This is a basic implementation. For production, the codebase
 * uses Gemini URL Context (via GEMINI_API_KEY) for more reliable
 * Zillow data extraction. See services/photo-provider/providers/zillow/
 */

import { generateZillowUrl, generateStreetViewUrl } from './zillow'
import type { FetchedPhotos } from './types'

export type { FetchedPhotos } from './types'

/**
 * Extract photo URLs from Zillow page HTML
 */
function extractZillowPhotos(html: string): string[] {
  const photos: Set<string> = new Set()

  // Pattern 1: Zillow static photos (most common)
  const staticPattern = /https:\/\/photos\.zillowstatic\.com\/fp\/[a-f0-9]+-[a-z0-9_]+\.jpg/gi
  const staticMatches = html.match(staticPattern) || []
  staticMatches.forEach((url) => photos.add(url))

  // Pattern 2: Full resolution photos
  const fullResPattern = /https:\/\/[^"'\s]*zillowstatic[^"'\s]*-cc_ft_\d+\.webp/gi
  const fullResMatches = html.match(fullResPattern) || []
  fullResMatches.forEach((url) => photos.add(url))

  // Pattern 3: Mixed media URLs
  const mediaPattern = /https:\/\/[^"'\s]*\.zillowstatic\.com\/[^"'\s]+(?:\.jpg|\.jpeg|\.png|\.webp)/gi
  const mediaMatches = html.match(mediaPattern) || []
  mediaMatches.forEach((url) => {
    // Filter out thumbnails and small images
    if (!url.includes('thumb') && !url.includes('_t.') && !url.includes('50x50')) {
      photos.add(url)
    }
  })

  // Pattern 4: CDN photos
  const cdnPattern = /https:\/\/[^"'\s]*cloudfront\.net\/[^"'\s]+(?:\.jpg|\.jpeg|\.png)/gi
  const cdnMatches = html.match(cdnPattern) || []
  cdnMatches.forEach((url) => photos.add(url))

  // Return unique photos, prioritizing larger images
  return Array.from(photos)
    .filter((url) => {
      // Filter out very small images
      const hasSmallIndicator =
        url.includes('32x') ||
        url.includes('48x') ||
        url.includes('64x') ||
        url.includes('96x') ||
        url.includes('_s.') ||
        url.includes('_xs.')
      return !hasSmallIndicator
    })
    .slice(0, 20) // Limit to 20 photos
}

/**
 * Fetch photos from a Zillow property page
 */
async function fetchZillowPage(url: string): Promise<{ html: string | null; error?: string }> {
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1',
      },
    })

    if (!response.ok) {
      return {
        html: null,
        error: `HTTP ${response.status}: ${response.statusText}`,
      }
    }

    const html = await response.text()
    return { html }
  } catch (error) {
    return {
      html: null,
      error: error instanceof Error ? error.message : 'Failed to fetch page',
    }
  }
}

/**
 * Fetch photos for a single property
 */
export async function fetchPropertyPhotos(params: {
  propertyId: string
  address: string
  city: string
  state: string
  zipCode: string
  latitude?: number | null
  longitude?: number | null
}): Promise<FetchedPhotos> {
  const { propertyId, address, city, state, zipCode, latitude, longitude } = params

  // Generate URLs
  const zillowUrl = generateZillowUrl({ address, city, state, zipCode })
  const streetViewUrl =
    latitude && longitude ? generateStreetViewUrl(latitude, longitude) : null

  // Try to fetch from Zillow search URL first
  const searchResult = await fetchZillowPage(zillowUrl.searchUrl)

  if (searchResult.html) {
    const photos = extractZillowPhotos(searchResult.html)
    if (photos.length > 0) {
      return {
        propertyId,
        zillowUrl,
        photos,
        streetViewUrl,
        source: 'zillow',
      }
    }
  }

  // Try estimated property URL if available
  if (zillowUrl.estimatedPropertyUrl) {
    const propertyResult = await fetchZillowPage(zillowUrl.estimatedPropertyUrl)

    if (propertyResult.html) {
      const photos = extractZillowPhotos(propertyResult.html)
      if (photos.length > 0) {
        return {
          propertyId,
          zillowUrl,
          photos,
          streetViewUrl,
          source: 'zillow',
        }
      }
    }
  }

  // No photos found
  return {
    propertyId,
    zillowUrl,
    photos: [],
    streetViewUrl,
    source: streetViewUrl ? 'streetview' : 'none',
    error: searchResult.error || 'No photos found',
  }
}

/**
 * Fetch photos for multiple properties in parallel
 */
export async function fetchMultiplePropertyPhotos(
  properties: Array<{
    propertyId: string
    address: string
    city: string
    state: string
    zipCode: string
    latitude?: number | null
    longitude?: number | null
  }>,
  options?: {
    /** Max concurrent requests */
    concurrency?: number
    /** Delay between batches (ms) */
    batchDelay?: number
  }
): Promise<Map<string, FetchedPhotos>> {
  const { concurrency = 3, batchDelay = 500 } = options || {}
  const results = new Map<string, FetchedPhotos>()

  // Process in batches to avoid rate limiting
  for (let i = 0; i < properties.length; i += concurrency) {
    const batch = properties.slice(i, i + concurrency)

    const batchResults = await Promise.all(
      batch.map((property) => fetchPropertyPhotos(property))
    )

    for (const result of batchResults) {
      results.set(result.propertyId, result)
    }

    // Add delay between batches (except for last batch)
    if (i + concurrency < properties.length && batchDelay > 0) {
      await new Promise((resolve) => setTimeout(resolve, batchDelay))
    }
  }

  return results
}

/**
 * Create a photo fetcher service
 */
export function createPhotoFetcher() {
  return {
    fetchPropertyPhotos,
    fetchMultiplePropertyPhotos,
  }
}

export type PhotoFetcher = ReturnType<typeof createPhotoFetcher>
