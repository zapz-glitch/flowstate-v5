/**
 * Listing Fetcher — Scrapfly transport
 *
 * Evidence chain:
 *   Address → Zillow autocomplete zpid (free) → Scrapfly ASP scrape
 *   → photos + description → (Clef classification downstream).
 *   The Redfin photo provider is the fallback when Zillow misses.
 *   Firecrawl transport stays in the class but is not wired from env.
 *
 * Fallback order per comp: Zillow → Redfin → Realtor.com.
 * Zillow pages are only evidence when the canonical URL proves the scrape
 * landed on this property's homedetails page — results-page photos belong
 * to other homes.
 *
 * Implements the same fetchListing contract as FirecrawlZillowFetcher so
 * the photo-provider registry swaps it in transparently.
 */

import type {
  CompZillowResult,
  ZillowFetchOptions,
  ZillowListingData,
  ZillowPropertyIdentifier,
} from './types'
import {
  generateZillowUrl,
  isValidExtraction,
  parseBathroomsFromFeatures,
  parseBedroomsFromFeatures,
  parseSqftFromFeatures,
  getLastSaleFromHistory,
  parseZillowHtml,
  type ZillowExtraction,
} from './firecrawl-fetcher'

const CACHE_PREFIX = 'zillow-fc-v1:'
const DEFAULT_CACHE_TTL = 30 * 24 * 60 * 60

interface CachedZillowData {
  extraction: ZillowExtraction
  cachedAt: string
  zillowUrl: string
}

export interface ScrapflyZillowFetcherConfig {
  /** Scrapfly API key — primary scrape transport */
  scrapflyApiKey?: string
  scrapflyUrl?: string
  /** Firecrawl API key — search + fallback scrape transport */
  firecrawlApiKey?: string
  /** Optional KV cache */
  cache?: KVNamespace
  cacheTtl?: number
}

interface SiteLane {
  query: (p: ZillowPropertyIdentifier) => string
  urlPattern: RegExp
  photoPattern?: RegExp
  normalize?: (u: string) => string
}

export class ScrapflyZillowFetcher {
  private scrapflyApiKey?: string
  private scrapflyUrl: string
  private firecrawlApiKey?: string
  private cache?: KVNamespace
  private cacheTtl: number

  /** Counter names kept identical to the Firecrawl fetcher — getCallStats()
   *  and the bundle's apiCallStats read these fields regardless of engine. */
  firecrawlCallCount = 0
  scrapflyCallCount = 0
  cacheHitCount = 0
  llmCallCount = 0

  constructor(config: ScrapflyZillowFetcherConfig) {
    this.scrapflyApiKey = config.scrapflyApiKey
    this.scrapflyUrl = config.scrapflyUrl || 'https://api.scrapfly.io/scrape'
    this.firecrawlApiKey = config.firecrawlApiKey
    this.cache = config.cache
    this.cacheTtl = config.cacheTtl ?? DEFAULT_CACHE_TTL
  }

  resetCallCounters(): void {
    this.firecrawlCallCount = 0
    this.scrapflyCallCount = 0
    this.cacheHitCount = 0
    this.llmCallCount = 0
  }

  // ─── Firecrawl transport ────────────────────────────────────────────────

  /** /v1/search — resolver: address → candidate listing URLs (~1-3s). */
  private async search(query: string, pattern: RegExp): Promise<string | null> {
    if (!this.firecrawlApiKey) return null
    try {
      const res = await fetch('https://api.firecrawl.dev/v1/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.firecrawlApiKey}` },
        body: JSON.stringify({ query, limit: 5 }),
        signal: AbortSignal.timeout(20_000),
      })
      if (!res.ok) return null
      const data = (await res.json()) as { success?: boolean; data?: Array<{ url?: string }> }
      this.firecrawlCallCount++
      for (const item of data.data ?? []) {
        const m = item.url?.match(pattern)
        if (m) return m[0]
      }
    } catch { /* URL resolution is best-effort */ }
    return null
  }

  /** Scrape transport chain: Scrapfly (ASP) → Firecrawl. */
  private async scrape(url: string): Promise<string | null> {
    return (await this.scrapeViaScrapfly(url)) ?? (await this.scrapeViaFirecrawl(url))
  }

  /** Scrapfly ASP scrape (~2s, no JS render — Zillow ships the gallery +
   *  canonical in the server HTML). One retry on 429: the plan caps
   *  concurrency, and a queued slot frees within seconds. */
  private async scrapeViaScrapfly(url: string, attempt = 0): Promise<string | null> {
    if (!this.scrapflyApiKey) return null
    // The key rides in the query string — only ever send it to Scrapfly.
    const host = (() => { try { return new URL(this.scrapflyUrl).hostname } catch { return '' } })()
    if (!host.endsWith('scrapfly.io')) return null
    try {
      const params = new URLSearchParams({ key: this.scrapflyApiKey, url, asp: 'true', country: 'us' })
      const res = await fetch(`${this.scrapflyUrl}?${params}`, { signal: AbortSignal.timeout(60_000) })
      if (res.status === 429 && attempt === 0) {
        await new Promise((r) => setTimeout(r, 2000))
        return this.scrapeViaScrapfly(url, 1)
      }
      if (!res.ok) return null
      const data = (await res.json()) as { result?: { status_code?: number; content?: string } }
      this.scrapflyCallCount++
      const status = data.result?.status_code
      const html = data.result?.content
      return html && html.length > 100 && !(status != null && status >= 400) ? html : null
    } catch {
      return null
    }
  }

  /** Zillow's public autocomplete — address → zpid, free and keyless.
   *  A zpid URL lands on the canonical homedetails page in one scrape, so
   *  no search engine is needed for the Zillow lane. */
  private async resolveZpidUrl(property: ZillowPropertyIdentifier): Promise<string | null> {
    const q = [property.address, property.city, property.state, property.zipCode].filter(Boolean).join(' ')
    try {
      const res = await fetch(
        `https://www.zillowstatic.com/autocomplete/v3/suggestions?q=${encodeURIComponent(q)}`,
        { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36' }, signal: AbortSignal.timeout(8000) },
      )
      if (!res.ok) return null
      const data = (await res.json()) as {
        results?: Array<{ resultType?: string; metaData?: { zpid?: number; streetNumber?: string } }>
      }
      const wanted = property.address.match(/\d+/)?.[0]
      const hit = data.results?.find(
        (r) => r.resultType === 'Address' && r.metaData?.zpid && (!wanted || r.metaData.streetNumber === wanted),
      )
      if (!hit?.metaData?.zpid) return null
      return `${generateZillowUrl(property).replace(/\/$/, '')}/${hit.metaData.zpid}_zpid/`
    } catch {
      return null
    }
  }

  /** Firecrawl /v1/scrape — rawHtml because the sanitized `html` format
   *  strips the script/meta blocks that carry canonical URLs, JSON-LD, and
   *  gallery photo srcsets. */
  private async scrapeViaFirecrawl(url: string): Promise<string | null> {
    if (!this.firecrawlApiKey) return null
    try {
      const res = await fetch('https://api.firecrawl.dev/v1/scrape', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.firecrawlApiKey}` },
        body: JSON.stringify({ url, formats: ['rawHtml', 'html'], onlyMainContent: false }),
        signal: AbortSignal.timeout(45_000),
      })
      if (!res.ok) return null
      const data = (await res.json()) as { success?: boolean; data?: { rawHtml?: string; html?: string } }
      this.firecrawlCallCount++
      const html = data?.data?.rawHtml || data?.data?.html
      return html && html.length > 100 ? html : null
    } catch {
      return null
    }
  }

  // ─── Helpers ────────────────────────────────────────────────────────────

  /** canonical/og:url of a rendered page — proves the scrape landed on a
   *  real listing (with its zpid) rather than a results page full of other
   *  homes' photos. */
  private canonicalListingUrl(html: string): string | null {
    return (
      html.match(/<link[^>]+rel="canonical"[^>]+href="([^"]+)"/i)?.[1] ??
      html.match(/<meta[^>]+property="og:url"[^>]+content="([^"]+)"/i)?.[1] ??
      null
    )
  }

  /** Street-number guard — search engines happily return the neighbor's
   *  listing; wrong-house photos are worse than none. */
  private urlMatchesAddress(url: string, property: ZillowPropertyIdentifier): boolean {
    const streetNumber = property.address.match(/\d+/)?.[0]
    if (!streetNumber) return true
    return new RegExp(`\\b${streetNumber}\\b`).test(url)
  }

  /** Meta description + CDN-pattern photo pull for a rendered listing page. */
  private parseGenericListing(html: string, photoPattern: RegExp): Pick<ZillowExtraction, 'photos' | 'description'> {
    const desc =
      html.match(/<meta[^>]+property="og:description"[^>]+content="([^"]{40,})"/i)?.[1] ??
      html.match(/<meta[^>]+name="description"[^>]+content="([^"]{40,})"/i)?.[1]
    const seen = new Set<string>()
    const photos: string[] = []
    for (const m of html.matchAll(photoPattern)) {
      const url = m[0].replace(/\\u002F/g, '/').replace(/\?.*$/, '')
      if (!seen.has(url)) {
        seen.add(url)
        photos.push(url)
      }
    }
    return { photos, description: desc }
  }

  private siteLane(site: 'zillow' | 'redfin' | 'realtor'): SiteLane {
    switch (site) {
      case 'zillow':
        return {
          query: (p) => `"${p.address}" ${p.city} ${p.state} site:zillow.com/homedetails`,
          urlPattern: /https?:\/\/(?:www\.)?zillow\.com\/homedetails\/[A-Za-z0-9\-_.%]+(?:\/\d+_zpid\/?)?/,
        }
      case 'redfin':
        return {
          query: (p) => `"${p.address}" ${p.city} ${p.state} site:redfin.com`,
          urlPattern: /https?:\/\/(?:www\.)?redfin\.com\/[^"'\s<&?]+\/home\/\d+/,
          photoPattern: /https:\/\/ssl\.cdn-redfin\.com\/photo\/[^"'\s\\]+\.(?:jpg|jpeg)/gi,
          normalize: (u: string) => u.replace(/\/(?:mbpaddedwide|paddedwide|bigcard|mbcard)\//, '/bigphoto/'),
        }
      case 'realtor':
        return {
          query: (p) => `${p.address} ${p.city} ${p.state} ${p.zipCode ?? ''} site:realtor.com/realestateandhomes-detail`,
          urlPattern: /https?:\/\/(?:www\.)?realtor\.com\/realestateandhomes-detail\/[A-Za-z0-9_-]+/,
          photoPattern: /https:\/\/[^"'\s\\]*\.rdcpix\.com\/[^"'\s\\]+\.(?:jpg|jpeg)/gi,
          normalize: (u: string) => u.replace(/-(?:s|m|od|w|t)\.jpg$/i, '-l.jpg'),
        }
    }
  }

  /** One lane of the decision tree: search → scrape → parse. Zillow gets the
   *  canonical gate; the portal lanes pull CDN photos + og:description. */
  private async fetchViaSite(
    property: ZillowPropertyIdentifier,
    site: 'zillow' | 'redfin' | 'realtor',
  ): Promise<{ extraction: ZillowExtraction; url: string } | null> {
    const cfg = this.siteLane(site)

    const parseZillow = (html: string) => {
      const canonical = this.canonicalListingUrl(html)
      if (!(canonical && canonical.includes('/homedetails/') && this.urlMatchesAddress(canonical, property))) {
        return null
      }
      const parsed = parseZillowHtml(html)
      // Full-page extraction can sweep up similar-homes thumbnails — only the
      // gallery's leading photos are trustworthy evidence for Clef.
      if (parsed.photos.length > 12) parsed.photos = parsed.photos.slice(0, 12)
      return isValidExtraction(parsed) ? { extraction: parsed, url: canonical } : null
    }

    if (site === 'zillow') {
      // zpid URL first — autocomplete resolves the exact parcel for free.
      const zpidUrl = await this.resolveZpidUrl(property)
      if (zpidUrl) {
        const html = await this.scrape(zpidUrl)
        const hit = html ? parseZillow(html) : null
        if (hit) return hit
      }
      // Constructed URL next — address → canonical zillow slug is a code
      // transform, so one scrape often replaces the search+scrape pair.
      const generated = await this.scrape(generateZillowUrl(property))
      if (generated) {
        const hit = parseZillow(generated)
        if (hit) return hit
      }
      const listingUrl = await this.search(cfg.query(property), cfg.urlPattern)
      if (!listingUrl || !this.urlMatchesAddress(listingUrl, property)) return null
      const html = await this.scrape(listingUrl)
      return html ? parseZillow(html) : null
    }

    const listingUrl = await this.search(cfg.query(property), cfg.urlPattern)
    if (!listingUrl || !this.urlMatchesAddress(listingUrl, property)) return null
    const html = await this.scrape(listingUrl)
    if (!html) return null

    const { photos, description } = this.parseGenericListing(html, cfg.photoPattern!)
    const normalized = photos.map(cfg.normalize!).slice(0, 12)
    if (!normalized.length) return null
    return { extraction: { photos: normalized, description }, url: listingUrl }
  }

  // ─── Cache ──────────────────────────────────────────────────────────────

  private getCacheKey(zillowUrl: string): string {
    const urlHash = zillowUrl
      .replace('https://www.zillow.com/', '')
      .replace(/[^a-zA-Z0-9-]/g, '-')
    return `${CACHE_PREFIX}${urlHash}`
  }

  private async getFromCache(zillowUrl: string): Promise<ZillowExtraction | null> {
    if (!this.cache) return null
    try {
      const cached = await this.cache.get<CachedZillowData>(this.getCacheKey(zillowUrl), 'json')
      if (cached && isValidExtraction(cached.extraction)) {
        this.cacheHitCount++
        return cached.extraction
      }
    } catch { /* cache read is best-effort */ }
    return null
  }

  private async saveToCache(zillowUrl: string, extraction: ZillowExtraction): Promise<void> {
    if (!this.cache) return
    try {
      await this.cache.put(
        this.getCacheKey(zillowUrl),
        JSON.stringify({ extraction, cachedAt: new Date().toISOString(), zillowUrl } satisfies CachedZillowData),
        { expirationTtl: this.cacheTtl },
      )
    } catch { /* cache write is best-effort */ }
  }

  // ─── Public contract ────────────────────────────────────────────────────

  async fetchListing(
    property: ZillowPropertyIdentifier,
    options?: ZillowFetchOptions,
  ): Promise<CompZillowResult> {
    const startTime = Date.now()
    const zillowUrl = generateZillowUrl(property)

    try {
      let extracted: ZillowExtraction | null = null
      let resolvedUrl = zillowUrl
      let fromCache = false

      if (!options?.skipCache) {
        extracted = await this.getFromCache(zillowUrl)
        fromCache = !!extracted
      }

      if (!extracted) {
        // The decision tree: search → scrape → parse, Zillow → Redfin →
        // Realtor. First lane with verified evidence wins.
        for (const site of ['zillow', 'redfin', 'realtor'] as const) {
          const hit = await this.fetchViaSite(property, site)
          if (hit) {
            extracted = hit.extraction
            resolvedUrl = hit.url
            break
          }
        }

        if (extracted && extracted.photos.length) await this.saveToCache(resolvedUrl, extracted)
      }

      if (!extracted) {
        return {
          compId: property.propertyId,
          error: 'no listing found on Zillow/Redfin/Realtor',
          timing: { startTime, endTime: Date.now(), durationMs: Date.now() - startTime },
        }
      }

      const features = extracted.features ?? []
      const { lastSaleDate, lastSalePrice } = getLastSaleFromHistory(extracted.priceHistory)
      const listing: ZillowListingData = {
        zillowUrl: resolvedUrl,
        photos: extracted.photos,
        description: extracted.description,
        price: extracted.price,
        status: extracted.status,
        daysOnMarket: extracted.daysOnMarket,
        features: extracted.features,
        priceHistory: extracted.priceHistory,
        bedrooms: extracted.bedrooms ?? parseBedroomsFromFeatures(features),
        bathrooms: extracted.bathrooms ?? parseBathroomsFromFeatures(features),
        squareFeet: extracted.squareFeet ?? parseSqftFromFeatures(features),
        yearBuilt: extracted.yearBuilt,
        foundationType: extracted.foundationType,
        hoaFee: extracted.hoaFee,
        lastSaleDate,
        lastSalePrice,
        pricePerSqft: extracted.pricePerSqft,
        listDate: extracted.listDate,
        lotSize: extracted.lotSize,
        lotSizeAcres: extracted.lotSizeAcres,
        propertyType: extracted.propertyType,
        style: extracted.style,
        stories: extracted.stories,
        roof: extracted.roof,
        construction: extracted.construction,
        heating: extracted.heating,
        cooling: extracted.cooling,
        parking: extracted.parking,
        garageSpaces: extracted.garageSpaces,
        taxAmount: extracted.taxAmount,
        estimatedMonthlyPayment: extracted.estimatedMonthlyPayment,
        appliances: extracted.appliances,
        flooring: extracted.flooring,
        exteriorFeatures: extracted.exteriorFeatures,
        pool: extracted.pool,
        waterfront: extracted.waterfront,
        view: extracted.view,
        neighborhood: extracted.neighborhood,
        walkScore: extracted.walkScore,
        transitScore: extracted.transitScore,
        agent: extracted.agent,
        whatsSpecial: extracted.whatsSpecial,
      }

      return {
        compId: property.propertyId,
        listing,
        fromCache,
        timing: { startTime, endTime: Date.now(), durationMs: Date.now() - startTime },
      }
    } catch (error) {
      return {
        compId: property.propertyId,
        error: error instanceof Error ? error.message : 'Unknown error',
        timing: { startTime, endTime: Date.now(), durationMs: Date.now() - startTime },
      }
    }
  }

  /** Photo comparison needs the vision service — same stub as Firecrawl. */
  async compareToSubject(
    comp: ZillowPropertyIdentifier,
    _compPhotos: string[],
    _subjectPhotos: string[],
  ): Promise<CompZillowResult> {
    return {
      compId: comp.propertyId,
      error: 'compareToSubject not implemented for this fetcher',
      timing: { startTime: Date.now(), endTime: Date.now(), durationMs: 0 },
    }
  }

  /** Compatibility shim — the stats reader polls this name. */
  getCallStats(): { firecrawlCalls: number; scrapflyCalls: number; cacheHits: number; llmCalls: number } {
    return {
      firecrawlCalls: this.firecrawlCallCount,
      scrapflyCalls: this.scrapflyCallCount,
      cacheHits: this.cacheHitCount,
      llmCalls: this.llmCallCount,
    }
  }
}

export function createScrapflyZillowFetcher(config: ScrapflyZillowFetcherConfig): ScrapflyZillowFetcher {
  return new ScrapflyZillowFetcher(config)
}
