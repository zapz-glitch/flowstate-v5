/**
 * Generic listing-photo scraper (Firecrawl + CDN pattern extraction)
 *
 * Sustainable photo sourcing beyond Zillow: resolves a subject property's
 * public listing page on a supported site, scrapes it with Firecrawl, and
 * extracts property photos from the site's image CDN. Falls back to LLM
 * extraction only when pattern matching yields too few photos.
 *
 * Supported sites are described by ListingSiteAdapter — each knows how to
 * resolve a listing URL (typically via the site's public autocomplete API)
 * and which CDN hosts carry real property photos.
 */

import { createOpenRouterProvider } from '../../llm'
import type { PropertyIdentifier } from '../types'

// ─── Site Adapters ─────────────────────────────────────────────────────────────

export interface ListingSiteAdapter {
  /** Provider name ('redfin', 'realtor') */
  name: string
  /** Search/autocomplete endpoint URL that yields listing-page links */
  searchUrl(property: PropertyIdentifier): string
  /** Extract the listing page URL from the search endpoint's response text */
  parseListingUrl(body: string, property: PropertyIdentifier): string | null
  /** CDN host/path patterns that carry real property photos */
  photoPatterns: RegExp[]
  /** Normalize a matched photo URL to its best variant */
  normalizePhotoUrl(url: string): string
}

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'

// Images that are never property photos
const EXCLUDE_PATTERNS = [
  'avatar', 'logo', 'icon', 'profile', 'agent', 'broker', 'map',
  'streetview', 'street-view', 'satellite', 'floorplan', 'floor-plan',
  'placeholder', 'coming-soon', 'social', 'badge', 'button', 'thumbnail',
]

function isPropertyPhoto(url: string, patterns: RegExp[]): boolean {
  const lower = url.toLowerCase()
  if (EXCLUDE_PATTERNS.some((p) => lower.includes(p))) return false
  return patterns.some((p) => p.test(url))
}

// ─── Redfin ────────────────────────────────────────────────────────────────────

/**
 * Redfin autocomplete returns JSON prefixed with "{}&&" (JSONP guard).
 * Rows of type 'address' carry a relative listing URL.
 */
export const redfinAdapter: ListingSiteAdapter = {
  name: 'redfin',

  // The stingray autocomplete endpoint is CloudFront-blocked for datacenter
  // IPs. Resolve via a Google site-search rendered through Firecrawl instead —
  // listing links carry /home/<id> which parseListingUrl extracts.
  searchUrl(property) {
    const query = `"${property.address}" ${property.city} ${property.state} site:redfin.com/home`
    return `https://www.google.com/search?q=${encodeURIComponent(query)}`
  },

  // Response is JSON prefixed with "{}&&" (JSONP guard); address rows carry
  // relative listing URLs like /FL/Riverview/12600-...-33579/home/12345
  parseListingUrl(body) {
    try {
      const json = JSON.parse(body.replace(/^\s*{}\s*&&\s*/, '')) as {
        payload?: { sections?: Array<{ rows?: Array<{ url?: string }> }> }
      }
      for (const section of json.payload?.sections ?? []) {
        for (const row of section.rows ?? []) {
          if (row.url && /\/home\/\d+/.test(row.url)) {
            return `https://www.redfin.com${row.url}`
          }
        }
      }
    } catch { /* fall through */ }
    // Regex fallback: scrape any /home/<id> link out of raw text
    const m = body.match(/"url":"(\/[^"]*\/home\/\d+)"/) ?? body.match(/(https:\/\/www\.redfin\.com\/[^"'\s]*\/home\/\d+)/)
    return m ? (m[1].startsWith('http') ? m[1] : `https://www.redfin.com${m[1]}`) : null
  },

  photoPatterns: [/https:\/\/ssl\.cdn-redfin\.com\/photo\/[^"'\s\\]+\.(?:jpg|jpeg)/gi],

  normalizePhotoUrl(url) {
    // Prefer the bigphoto variant; strip query params
    return url.replace(/\?.*$/, '').replace(/\/(?:mbpaddedwide|paddedwide|bigcard|mbcard)\//, '/bigphoto/')
  },
}

// ─── Realtor.com ───────────────────────────────────────────────────────────────

/**
 * Realtor.com's public suggest API returns slug_ids for address matches;
 * the listing page is /realestateandhomes-detail/<slug_id>.
 */
export const realtorAdapter: ListingSiteAdapter = {
  name: 'realtor',

  // Google-indexed search — Firecrawl renders it; listing links carry the slug
  searchUrl(property) {
    const query = `${property.address} ${property.city} ${property.state} ${property.zipCode} site:realtor.com/realestateandhomes-detail`
    return `https://www.google.com/search?q=${encodeURIComponent(query)}`
  },

  parseListingUrl(body) {
    const m = body.match(/https:\/\/www\.realtor\.com\/realestateandhomes-detail\/[A-Za-z0-9_-]+/)
    return m ? m[0] : null
  },

  photoPatterns: [/https:\/\/[^"'\s\\]*\.rdcpix\.com\/[^"'\s\\]+\.(?:jpg|jpeg)/gi],

  normalizePhotoUrl(url) {
    // -s.jpg (small) / -m.jpg (medium) / -od.jpg → -l.jpg (large)
    return url.replace(/\?.*$/, '').replace(/-(?:s|m|od|w|t)\.jpg$/i, '-l.jpg')
  },
}

// ─── Scraper ───────────────────────────────────────────────────────────────────

export interface ListingScraperConfig {
  /** Firecrawl API key */
  apiKey: string
  /** OpenRouter API key for LLM fallback extraction */
  openrouterApiKey?: string
  openrouterModel?: string
  /** Optional KV cache */
  cache?: KVNamespace
  cacheTtl?: number
}

interface FirecrawlResponse {
  success: boolean
  data?: { html?: string; markdown?: string }
  error?: string
}

const EXTRACTION_PROMPT = `You are a real estate data extraction assistant. Analyze the listing page content and extract ONLY actual property photos.

Return a JSON object:
{
  "photos": ["array of PROPERTY photo URLs only"]
}

RULES:
1. ONLY photos of the actual listed property (interior, exterior, yard, amenities belonging to the property)
2. EXCLUDE: agent headshots, logos, icons, maps, floor plans, neighborhood/community images, stock marketing images, QR codes
3. Prefer full-resolution CDN URLs
4. Return ONLY valid JSON, no markdown fences or explanation`

export class ListingPhotoScraper {
  private apiKey: string
  private openrouterApiKey?: string
  private openrouterModel: string
  private cache?: KVNamespace
  private cacheTtl: number

  constructor(config: ListingScraperConfig) {
    this.apiKey = config.apiKey
    this.openrouterApiKey = config.openrouterApiKey
    this.openrouterModel = config.openrouterModel ?? 'google/gemini-2.5-flash'
    this.cache = config.cache
    this.cacheTtl = config.cacheTtl ?? 24 * 60 * 60
  }

  private cacheKey(adapter: ListingSiteAdapter, property: PropertyIdentifier): string {
    const slug = `${property.address}-${property.city}-${property.state}-${property.zipCode}`
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
    return `listing-photos:${adapter.name}:${slug}`
  }

  /** Scrape a listing page through Firecrawl */
  private async scrape(url: string): Promise<{ html: string; markdown: string }> {
    const response = await fetch('https://api.firecrawl.dev/v1/scrape', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        url,
        formats: ['html', 'markdown'],
        onlyMainContent: false,
        waitFor: 3000,
      }),
      signal: AbortSignal.timeout(60000),
    })

    if (!response.ok) {
      throw new Error(`Firecrawl API failed: ${response.status} ${(await response.text()).slice(0, 200)}`)
    }
    const data = (await response.json()) as FirecrawlResponse
    if (!data.success || (!data.data?.html && !data.data?.markdown)) {
      throw new Error(`Firecrawl error: ${data.error || 'no content'}`)
    }
    return { html: data.data.html || '', markdown: data.data.markdown || '' }
  }

  /** LLM extraction fallback when CDN patterns yield too few photos */
  private async extractWithLLM(content: { html: string; markdown: string }, adapter: ListingSiteAdapter): Promise<string[]> {
    if (!this.openrouterApiKey) return []
    try {
      const llm = createOpenRouterProvider({
        apiKey: this.openrouterApiKey,
        model: this.openrouterModel,
        maxTokens: 4096,
      })
      const result = await llm.execute({
        prompt: `${EXTRACTION_PROMPT}\n\nContent to analyze:\n## Markdown:\n${content.markdown.slice(0, 30000)}\n\n## HTML:\n${content.html.slice(0, 50000)}`,
        maxTokens: 4096,
        temperature: 0.1,
      })
      if (!result.success || !result.data) return []
      let jsonStr = result.data.content.trim()
      const fence = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/)
      if (fence) jsonStr = fence[1].trim()
      const parsed = JSON.parse(jsonStr) as { photos?: string[] }
      return (parsed.photos ?? []).filter((u) => isPropertyPhoto(u, adapter.photoPatterns) || u.startsWith('http'))
    } catch {
      return []
    }
  }

  /**
   * Extract a flood-risk signal from listing content.
   * Redfin/Realtor listing pages embed First Street "Flood Factor" data —
   * returns a level + the source phrase, or null when absent.
   */
  private extractFloodSignal(content: { html: string; markdown: string }): { level: string; source: string } | null {
    const text = `${content.markdown}\n${content.html}`

    // "Flood Factor: 4/10" or "Flood Factor 4" (First Street on Redfin/Realtor)
    const factor = text.match(/flood\s*factor[:\s]*(\d{1,2})\s*(?:\/\s*10)?/i)
    if (factor) {
      const n = parseInt(factor[1], 10)
      const level = n <= 2 ? 'minimal' : n <= 4 ? 'minor' : n <= 6 ? 'moderate' : n <= 8 ? 'major' : 'severe'
      return { level: `${level} (Flood Factor ${n}/10)`, source: 'listing:flood-factor' }
    }

    // Free-text levels: "minimal/moderate/major/severe/extreme flood risk"
    const levelMatch = text.match(/(minimal|minor|moderate|major|severe|extreme)\s+(?:flood|risk of flood|flood risk)/i)
      ?? text.match(/flood risk[^.]{0,40}?(minimal|minor|moderate|major|severe|extreme)/i)
    if (levelMatch) {
      return { level: levelMatch[1].toLowerCase(), source: 'listing:flood-text' }
    }

    // FEMA zone mentions: "Flood Zone X" / "AE" / "not in a flood zone"
    if (/not in (?:a )?flood zone|flood insurance not required/i.test(text)) {
      return { level: 'minimal', source: 'listing:flood-zone-text' }
    }
    const zone = text.match(/flood zone[:\s]*([A-Z]{1,3}\d?)\b/i)
    if (zone && !['X'].includes(zone[1].toUpperCase())) {
      return { level: `zone ${zone[1].toUpperCase()}`, source: 'listing:flood-zone-text' }
    }
    return null
  }

  /**
   * Resolve a listing page URL: try the site's autocomplete/search endpoint
   * directly, then scrape it through Firecrawl when bot-protection blocks us.
   */
  private async resolveListingUrl(property: PropertyIdentifier, adapter: ListingSiteAdapter): Promise<string | null> {
    const searchUrl = adapter.searchUrl(property)

    try {
      const res = await fetch(searchUrl, {
        headers: { 'User-Agent': UA, Accept: 'application/json,text/html' },
        signal: AbortSignal.timeout(15000),
      })
      if (res.ok) {
        const url = adapter.parseListingUrl(await res.text(), property)
        if (url) return url
      }
    } catch { /* direct fetch blocked — try Firecrawl */ }

    try {
      const content = await this.scrape(searchUrl)
      return adapter.parseListingUrl(content.html + '\n' + content.markdown, property)
    } catch {
      return null
    }
  }

  /**
   * Fetch subject listing photos for a property from a site.
   * Returns photo URLs + the resolved listing URL, or null on failure.
   */
  async fetchPhotos(
    property: PropertyIdentifier,
    adapter: ListingSiteAdapter,
  ): Promise<{ photos: string[]; sourceUrl: string; floodRisk: { level: string; source: string } | null } | null> {
    const tag = `[${adapter.name}]`
    try {
      // Cache check
      if (this.cache) {
        try {
          const cached = await this.cache.get<{ photos: string[]; sourceUrl: string; floodRisk: { level: string; source: string } | null }>(
            this.cacheKey(adapter, property), 'json')
          if (cached && cached.photos.length > 0) {
            console.log(`${tag} cache hit: ${cached.photos.length} photos`)
            return cached
          }
        } catch { /* cache is best-effort */ }
      }

      const listingUrl = await this.resolveListingUrl(property, adapter)
      if (!listingUrl) {
        console.log(`${tag} no listing found for ${property.address}`)
        return null
      }
      console.log(`${tag} resolved listing: ${listingUrl}`)

      const content = await this.scrape(listingUrl)

      // Pattern extraction first
      const matched = new Set<string>()
      for (const pattern of adapter.photoPatterns) {
        pattern.lastIndex = 0
        for (const m of content.html.matchAll(pattern)) {
          if (isPropertyPhoto(m[0], adapter.photoPatterns)) matched.add(m[0])
        }
      }
      let photos = [...matched].map((u) => adapter.normalizePhotoUrl(u))
      photos = [...new Set(photos)]

      // LLM fallback when patterns yield too few
      if (photos.length < 2 && this.openrouterApiKey) {
        console.log(`${tag} pattern extraction found ${photos.length}, trying LLM...`)
        const llmPhotos = await this.extractWithLLM(content, adapter)
        for (const u of llmPhotos) {
          const n = adapter.normalizePhotoUrl(u)
          if (!photos.includes(n)) photos.push(n)
        }
      }

      if (photos.length === 0) {
        console.warn(`${tag} scrape produced no photos: ${listingUrl}`)
        return null
      }

      const floodRisk = this.extractFloodSignal(content)
      if (floodRisk) console.log(`${tag} flood signal: ${floodRisk.level} (${floodRisk.source})`)

      const result = { photos, sourceUrl: listingUrl, floodRisk }
      if (this.cache) {
        try {
          await this.cache.put(this.cacheKey(adapter, property), JSON.stringify(result), {
            expirationTtl: this.cacheTtl,
          })
        } catch { /* cache is best-effort */ }
      }
      console.log(`${tag} extracted ${photos.length} photos from ${listingUrl}`)
      return result
    } catch (error) {
      console.warn(`${tag} fetch failed:`, error instanceof Error ? error.message : error)
      return null
    }
  }
}

export const LISTING_ADAPTERS = {
  redfin: redfinAdapter,
  realtor: realtorAdapter,
} as const

export type ListingSiteName = keyof typeof LISTING_ADAPTERS
