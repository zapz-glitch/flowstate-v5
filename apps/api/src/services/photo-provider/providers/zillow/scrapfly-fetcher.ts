/**
 * Serper + Scrapfly Zillow Fetcher
 *
 * Firecrawl-free listing fetcher (EVIDENCE-PIPELINE-SPEC):
 *   URL resolution: Serper site-search → generated Zillow URL
 *   Render:         Scrapfly ASP (datacenter → residential escalation)
 *   Fallbacks:      Redfin → Realtor.com (same Serper+Scrapfly path)
 *   Parse:          shared parseZillowHtml + adapter photo patterns
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

const CACHE_PREFIX = 'zillow-sf-v1:'
const DEFAULT_CACHE_TTL = 30 * 24 * 60 * 60

interface CachedZillowData {
  extraction: ZillowExtraction
  cachedAt: string
  zillowUrl: string
}

export interface ScrapflyZillowFetcherConfig {
  /** Scrapfly API key */
  apiKey: string
  /** Scrapfly endpoint (default https://api.scrapfly.io/scrape) */
  apiUrl?: string
  /** Serper API key for site-search URL resolution (optional) */
  serperApiKey?: string
  /** Optional KV cache */
  cache?: KVNamespace
  cacheTtl?: number
}

interface ScrapflyResponse {
  result?: { status_code?: number; content?: string }
}

interface SerperResponse {
  organic?: Array<{ link?: string }>
}

export class ScrapflyZillowFetcher {
  private apiKey: string
  private apiUrl: string
  private apiUrlOk: boolean
  private serperApiKey?: string
  private cache?: KVNamespace
  private cacheTtl: number

  /** Counter names kept identical to the Firecrawl fetcher — getCallStats()
   *  and the bundle's apiCallStats read these fields regardless of engine. */
  firecrawlCallCount = 0
  cacheHitCount = 0
  llmCallCount = 0

  constructor(config: ScrapflyZillowFetcherConfig) {
    this.apiKey = config.apiKey
    this.apiUrl = config.apiUrl ?? 'https://api.scrapfly.io/scrape'
    // The API key rides in the scrape query string — only ever send it to
    // Scrapfly's own hosts, no matter what the env says.
    this.apiUrlOk = (() => {
      try {
        return new URL(this.apiUrl).hostname.endsWith('scrapfly.io')
      } catch {
        return false
      }
    })()
    if (!this.apiUrlOk) console.warn(`[ScrapflyZillow] refusing non-Scrapfly apiUrl: ${this.apiUrl}`)
    this.serperApiKey = config.serperApiKey
    this.cache = config.cache
    this.cacheTtl = config.cacheTtl ?? DEFAULT_CACHE_TTL
  }

  resetCallCounters(): void {
    this.firecrawlCallCount = 0
    this.cacheHitCount = 0
    this.llmCallCount = 0
  }

  // ─── Transport ──────────────────────────────────────────────────────────

  /** Scrapfly scrape → HTML. Workers' ladder, cheapest first:
   *  ASP datacenter (no JS) → ASP+JS render → ASP+JS+residential. */
  private async scrape(url: string, opts?: { residential?: boolean; render?: boolean }): Promise<string | null> {
    if (!this.apiUrlOk) return null
    const run = async (render: boolean, residential: boolean): Promise<string | null> => {
      const params = new URLSearchParams({
        key: this.apiKey,
        url,
        asp: 'true',
        country: 'us',
      })
      if (render) params.set('render_js', 'true')
      if (residential) params.set('proxy_pool', 'public_residential_pool')
      try {
        const resp = await fetch(`${this.apiUrl}?${params}`, { signal: AbortSignal.timeout(60_000) })
        if (!resp.ok) return null
        const data = (await resp.json()) as ScrapflyResponse
        const status = data.result?.status_code
        const content = data.result?.content
        if (!content || (status != null && status >= 400)) return null
        return content
      } catch {
        return null
      }
    }
    this.firecrawlCallCount++
    const dc = await run(!!opts?.render, false)
    if (dc) return dc
    this.firecrawlCallCount++
    const rendered = await run(true, false)
    if (rendered) return rendered
    this.firecrawlCallCount++
    return run(true, true)
  }

  /** Serper site-search → first link matching `pattern`. */
  private async serperResolve(query: string, pattern: RegExp): Promise<string | null> {
    if (!this.serperApiKey) return null
    try {
      const resp = await fetch('https://google.serper.dev/search', {
        method: 'POST',
        headers: { 'X-API-KEY': this.serperApiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: query, gl: 'us', num: 5 }),
        signal: AbortSignal.timeout(15_000),
      })
      if (!resp.ok) return null
      const data = (await resp.json()) as SerperResponse
      for (const item of data.organic ?? []) {
        const m = item.link?.match(pattern)
        if (m) return m[0]
      }
    } catch { /* URL resolution is best-effort */ }
    return null
  }

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

  /** Resolve the real Zillow homedetails URL: Serper first, then a
   *  Scrapfly-rendered pass over the generated search page. */
  private async resolveZillowUrl(property: ZillowPropertyIdentifier, searchUrl: string): Promise<string | null> {
    const q = `"${property.address} ${property.city} ${property.state}" site:zillow.com/homedetails`
    const viaSerper = await this.serperResolve(q, /https?:\/\/(?:www\.)?zillow\.com\/homedetails\/[A-Za-z0-9\-_.%]+(?:\/\d+_zpid\/?)?/)
    if (viaSerper && this.urlMatchesAddress(viaSerper, property)) return viaSerper

    const html = await this.scrape(searchUrl, { render: true })
    if (!html) return null
    const links = [
      ...new Set(
        (html.match(/zillow\.com\/homedetails\/[A-Za-z0-9\-_.%]+(?:\/\d+_zpid\/?)?/g) ?? [])
          .map((l) => `https://www.${l}`.replace(/\/$/, '')),
      ),
    ]
    const tokens = property.address
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 1 && !/^(n|s|e|w|ne|nw|se|sw)$/.test(t))
    const streetName = tokens.slice(1).filter((t) => !/^(st|ave|dr|rd|ct|ln|cir|blvd|pl|ter|way|pkwy|trl|cv|run)$/.test(t)).join(' ')
    return (
      links.find((l) => {
        const slug = l.toLowerCase()
        const numOk = tokens[0] ? slug.includes(`-${tokens[0]}-`) || slug.includes(`/${tokens[0]}-`) : true
        const nameOk = streetName ? streetName.split(' ').every((t) => slug.includes(t)) : true
        return numOk && nameOk
      }) ?? null
    )
  }

  // ─── Non-Zillow lanes (Redfin, Realtor) ──────────────────────────────────

  /** Redfin stingray autocomplete — free JSON resolver, no search API.
   *  Returns the property's Redfin id + listing URL for the row that
   *  matches street number, street name tokens, and city. */
  private async stingrayResolve(
    property: ZillowPropertyIdentifier,
  ): Promise<{ propertyId: string; url: string } | null> {
    const q = `${property.address} ${property.city} ${property.state} ${property.zipCode ?? ''}`.trim()
    const target =
      'https://www.redfin.com/stingray/do/location-autocomplete?location=' +
      encodeURIComponent(q) +
      '&v=2&al=1&iss=false&ooa=true&mrs=false'
    const body = await this.scrape(target)
    if (!body) return null
    try {
      const j = JSON.parse(body.startsWith('{}&&') ? body.slice(4) : body) as {
        payload?: { sections?: Array<{ rows?: Array<{ id?: string; name?: string; subName?: string; url?: string; urlV2?: string }> }> }
      }
      const rows = j?.payload?.sections?.[0]?.rows ?? []
      const num = property.address.match(/\d+/)?.[0]
      const nameToks = property.address
        .toLowerCase()
        .replace(/[^\w\s]/g, ' ')
        .split(/\s+/)
        .filter(
          (t) =>
            t.length > 1 &&
            !/^\d+$/.test(t) &&
            !/^(st|ave|dr|rd|ct|ln|cir|blvd|pl|ter|way|pkwy|trl|cv|run|n|s|e|w|ne|nw|se|sw)$/.test(t),
        )
      const cityTok = property.city.toLowerCase()
      for (const r of rows) {
        const nm = (r.name ?? '').toLowerCase()
        const sub = (r.subName ?? '').toLowerCase()
        const url = r.url ?? r.urlV2
        if (!url || !/\/home\/\d+/.test(url)) continue
        if (num && !nm.includes(num)) continue
        if (!nameToks.every((t) => nm.includes(t))) continue
        if (cityTok && !sub.includes(cityTok)) continue
        const propertyId = String(r.id ?? '').replace(/^\d+_/, '')
        if (!propertyId) continue
        return { propertyId, url: `https://www.redfin.com${url}` }
      }
    } catch { /* stingray parse is best-effort */ }
    return null
  }

  /** Property-bound photos + description from the stingray detail JSON —
   *  the verified-source alternative to scraping a rendered page (whose
   *  CDN URLs can include similar-homes thumbnails). */
  private async stingrayMedia(
    propertyId: string,
  ): Promise<Pick<ZillowExtraction, 'photos' | 'description'>> {
    const parse = (body: string | null) => {
      if (!body) return { photos: [] as string[], description: undefined as string | undefined }
      try {
        const j = JSON.parse(body.startsWith('{}&&') ? body.slice(4) : body) as { payload?: any }
        const p = j?.payload ?? {}
        const seen = new Set<string>()
        const collect = (arr: any[]) => {
          for (const ph of arr ?? []) {
            const u = ph?.photoUrls?.fullScreenPhotoUrl ?? ph?.photoUrls?.nonFullScreenPhotoUrl
            if (typeof u === 'string' && u && !seen.has(u)) seen.add(u)
          }
        }
        collect(p?.mediaBrowserInfo?.photos)
        for (const v of Object.values(p?.propertyHistoryInfo?.mediaBrowserInfoBySourceId ?? {}) as any[]) {
          collect(v?.photos)
        }
        const description =
          p?.amenitiesInfo?.marketingRemarks ??
          p?.addressSectionInfo?.marketingRemarks ??
          p?.listingRemarks ??
          undefined
        return { photos: [...seen], description }
      } catch {
        return { photos: [] as string[], description: undefined }
      }
    }
    const [above, below] = await Promise.all([
      this.scrape(`https://www.redfin.com/stingray/api/home/details/aboveTheFold?propertyId=${propertyId}&accessLevel=1`),
      this.scrape(`https://www.redfin.com/stingray/api/home/details/belowTheFold?propertyId=${propertyId}&accessLevel=1`),
    ])
    const a = parse(above)
    const b = parse(below)
    return { photos: a.photos.length ? a.photos : b.photos, description: a.description ?? b.description }
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

  private async fetchViaSite(
    property: ZillowPropertyIdentifier,
    site: 'redfin' | 'realtor',
  ): Promise<ZillowExtraction | null> {
    const cfg =
      site === 'redfin'
        ? {
            query: `"${property.address}" ${property.city} ${property.state} site:redfin.com`,
            urlPattern: /https?:\/\/(?:www\.)?redfin\.com\/[^"'\s<&?]+\/home\/\d+/,
            photoPattern: /https:\/\/ssl\.cdn-redfin\.com\/photo\/[^"'\s\\]+\.(?:jpg|jpeg)/gi,
            normalize: (u: string) => u.replace(/\/(?:mbpaddedwide|paddedwide|bigcard|mbcard)\//, '/bigphoto/'),
          }
        : {
            query: `${property.address} ${property.city} ${property.state} ${property.zipCode} site:realtor.com/realestateandhomes-detail`,
            urlPattern: /https?:\/\/(?:www\.)?realtor\.com\/realestateandhomes-detail\/[A-Za-z0-9_-]+/,
            photoPattern: /https:\/\/[^"'\s\\]*\.rdcpix\.com\/[^"'\s\\]+\.(?:jpg|jpeg)/gi,
            normalize: (u: string) => u.replace(/-(?:s|m|od|w|t)\.jpg$/i, '-l.jpg'),
          }

    let listingUrl: string | null = null
    if (site === 'redfin') {
      // Free internal resolver first — stingray covers every parcel and its
      // media endpoints carry property-bound photos (verified, unlike CDN
      // matches on a rendered page which can be similar-homes thumbnails).
      const st = await this.stingrayResolve(property)
      if (st) {
        const media = await this.stingrayMedia(st.propertyId)
        if (media.photos.length) {
          console.log(`[ScrapflyZillow] redfin stingray lane: ${media.photos.length} photos`)
          return { photos: media.photos, description: media.description }
        }
        listingUrl = st.url // verified URL — page scrape below as last resort
      }
    }
    if (!listingUrl) listingUrl = await this.serperResolve(cfg.query, cfg.urlPattern)
    if (!listingUrl || !this.urlMatchesAddress(listingUrl, property)) return null
    const html = await this.scrape(listingUrl, { render: true })
    if (!html) return null
    const { photos, description } = this.parseGenericListing(html, cfg.photoPattern)
    const normalized = photos.map(cfg.normalize)
    if (!normalized.length) return null
    console.log(`[ScrapflyZillow] ${site} lane: ${normalized.length} photos`)
    return { photos: normalized, description }
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
        // Generated search-page URL first — cheap when the listing surfaces.
        // A miss renders a *search page* whose photos belong to other homes,
        // so the page is only evidence when its canonical URL proves it's
        // this property's listing.
        const html = await this.scrape(zillowUrl, { render: true })
        if (html) {
          const canonical = this.canonicalListingUrl(html)
          if (canonical && canonical.includes('/homedetails/') && this.urlMatchesAddress(canonical, property)) {
            const parsed = parseZillowHtml(html)
            if (isValidExtraction(parsed)) {
              extracted = parsed
              resolvedUrl = canonical
            }
          }
        }

        // Miss → resolve the real homedetails URL (Serper → rendered search page).
        if (!extracted) {
          const found = await this.resolveZillowUrl(property, zillowUrl)
          if (found && found !== zillowUrl) {
            const altHtml = await this.scrape(found, { render: true })
            if (altHtml) {
              const alt = parseZillowHtml(altHtml)
              if (isValidExtraction(alt)) {
                extracted = alt
                resolvedUrl = found
              }
            }
          }
        }

        // Site fallbacks — Redfin then Realtor (spec ladder order).
        if (!extracted) extracted = await this.fetchViaSite(property, 'redfin')
        if (!extracted) extracted = await this.fetchViaSite(property, 'realtor')

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
    _subjectId: string,
  ): Promise<CompZillowResult> {
    const startTime = Date.now()
    return {
      compId: comp.propertyId,
      comparisonToSubject: {
        comparison: 'similar',
        confidence: 50,
        qualityAdjustment: 0,
        reasoning: 'Photo comparison requires vision analysis service',
      },
      timing: { startTime, endTime: Date.now(), durationMs: Date.now() - startTime },
    }
  }
}

export function createScrapflyZillowFetcher(config: ScrapflyZillowFetcherConfig): ScrapflyZillowFetcher {
  return new ScrapflyZillowFetcher(config)
}
