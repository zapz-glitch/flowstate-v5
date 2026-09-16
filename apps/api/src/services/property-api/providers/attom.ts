/**
 * ATTOM Data Property Provider
 *
 * Implements PropertyProviderAdapter for ATTOM Data API.
 * Uses two API versions:
 *   - v1: Property basic profile (/propertyapi/v1.0.0/property/basicprofile) — address search
 *   - v2: Sales comparables (/property/v2/salescomparables/propid/{id}) — XML-style response
 *
 * Auth: `apikey` header on every request.
 *
 * Field notes from real API responses (2026-01-27 logs):
 *   - lot.lotSize1 = ACRES, lot.lotSize2 = SQFT (counterintuitive — confirmed from logs)
 *   - address has no latitude/longitude — coordinates only in location object
 *   - basicprofile takes address1 (street) + address2 (city, state) params
 *   - getPropertyById uses `attomid` param (lowercase)
 *   - assessment.owner has mailingAddressOneLine at owner level (not owner1)
 *   - absenteeOwnerStatus (not absenteeInd) determines owner-occupancy: 'O' = occupied
 *   - v2 comp data is inside COMPARABLE_PROPERTY_ext, not at PROPERTY[] item level
 */

import type { Env } from '../../../types'
import type {
  PropertyProviderAdapter,
  PropertySearchParams,
  PropertySearchResponse,
  ComparablesSearchParams,
  ComparablesSearchResponse,
  PermitsResponse,
  FloodZoneResponse,
  NormalizedProperty,
  NormalizedComparable,
  NormalizedPermit,
} from '../types'
import { ATTOM_MAX_COMPS, buildRetrievalMeta } from '../retrieval-policy'

// ─── Constants ─────────────────────────────────────────────────────────────────

const BASE_URL = 'https://api.gateway.attomdata.com'

// ─── ATTOM v1 Response Types ────────────────────────────────────────────────────
// Verified against real API responses from logs.

interface AttomV1Property {
  identifier?: {
    Id?: number | string
    attomId?: number | string
  }
  address?: {
    oneLine?: string
    line1?: string
    line2?: string
    locality?: string      // city
    countrySubd?: string   // state
    postal1?: string       // zip
    // NOTE: latitude/longitude are NOT present in address — use location instead
  }
  location?: {
    latitude?: string
    longitude?: string
  }
  lot?: {
    lotSize1?: number  // ACRES (confirmed from real data: 0.3854224)
    lotSize2?: number  // SQFT  (confirmed from real data: 16789)
    zoningType?: string
  }
  area?: {
    subdName?: string   // expandedprofile uses camelCase
    subdname?: string   // detail uses lowercase
    countrySecSubd?: string  // expandedprofile
    countrysecsubd?: string  // detail
  }
  building?: {
    rooms?: {
      roomsTotal?: number
      beds?: number
      bathsTotal?: number
      bathsFull?: number
    }
    size?: {
      bldgSize?: number
      livingSize?: number
      universalSize?: number
      grossSizeAdjusted?: number
    }
    construction?: {
      constructionType?: string
      frameType?: string
    }
    summary?: {
      levels?: number
      storyDesc?: string
    }
  }
  utilities?: {
    coolingType?: string
    heatingType?: string
  }
  summary?: {
    propClass?: string
    propSubType?: string
    propType?: string        // e.g. "SFR"
    propertyType?: string    // e.g. "SINGLE FAMILY RESIDENCE"
    yearBuilt?: number
    absenteeInd?: string     // full string e.g. "ABSENTEE(MAIL AND SITUS NOT =)"
    propLandUse?: string
  }
  assessment?: {
    assessed?: {
      assdTtlValue?: number
      assdLandValue?: number
      assdImprValue?: number
    }
    tax?: {
      taxAmt?: number
      taxYear?: number
    }
    market?: {
      mktttlvalue?: number
    }
    owner?: {
      owner1?: {
        fullName?: string
        lastName?: string
        firstNameAndMi?: string
      }
      owner2?: { fullName?: string }
      absenteeOwnerStatus?: string   // 'O' = owner-occupied, 'A' = absentee
      mailingAddressOneLine?: string // at owner level, not owner1
      corporateIndicator?: string
    }
  }
  sale?: {
    saleTransDate?: string
    saleSearchDate?: string
    saleAmountData?: {
      saleAmt?: number
      saleRecDate?: string
      saleTransType?: string
    }
  }
}

interface AttomV1Response {
  property?: AttomV1Property[]
  status?: { code?: number; msg?: string }
}

// ─── ATTOM v2 Comparables Response Types ───────────────────────────────────────
// Verified against real API responses from logs.
// The v2 API returns XML-converted JSON — attributes are @-prefixed.
//
// Structure:
//   RESPONSE_GROUP.RESPONSE.RESPONSE_DATA.PROPERTY_INFORMATION_RESPONSE_ext
//     .SUBJECT_PROPERTY_ext.PROPERTY[]
//       [0] = subject (has SALES_HISTORY, STRUCTURE, SITE directly)
//       [1..n] = comparables (data is inside COMPARABLE_PROPERTY_ext)

interface AttomV2CompData {
  '@_Sequence'?: string
  '@DistanceFromSubjectPropertyMilesCount'?: string
  '@_StreetAddress'?: string
  '@_City'?: string
  '@_State'?: string
  '@_PostalCode'?: string
  '@LatitudeNumber'?: string
  '@LongitudeNumber'?: string
  '@StandardUseCode_ext'?: string
  '@StandardUseDescription_ext'?: string
  '@PropertyParcelID'?: string
  '_IDENTIFICATION'?: {
    '@RTPropertyID_ext'?: string
    '@DQPropertyID_ext'?: string
  }
  'SALES_HISTORY'?: {
    '@TransferDate_ext'?: string
    '@PropertySalesDate'?: string
    '@PropertySalesAmount'?: string
    '@PricePerSquareFootAmount'?: string
    '@BuyerUnparsedName_ext'?: string
    '@SellerUnparsedName'?: string
  }
  'STRUCTURE'?: {
    '@TotalBedroomCount'?: string
    '@TotalBathroomCount'?: string
    '@TotalBathroomFullCount_ext'?: string
    '@GrossLivingAreaSquareFeetCount'?: string
    '@StoriesCount'?: string
    'STRUCTURE_ANALYSIS'?: {
      '@PropertyStructureBuiltYear'?: string
    }
    'HEATING'?: { '@_UnitDescription'?: string }
    'COOLING'?: { '@_UnitDescription'?: string }
  }
  'SITE'?: {
    '@LotSquareFeetCount'?: string
    '@PropertyZoningCategoryType'?: string
  }
}

interface AttomV2PropertyItem {
  'PRODUCT_INFO_ext'?: { '@Product_ext'?: string }
  'COMPARABLE_PROPERTY_ext'?: AttomV2CompData
  // Subject property fields (when COMPARABLE_PROPERTY_ext is absent)
  '@_StreetAddress'?: string
  '@PropertyParcelID'?: string
}

interface AttomV2Response {
  RESPONSE_GROUP?: {
    PRODUCT?: {
      STATUS?: {
        _Code?: number
        _Description?: string
      }
    }
    RESPONSE?: {
      RESPONSE_DATA?: {
        PROPERTY_INFORMATION_RESPONSE_ext?: {
          SUBJECT_PROPERTY_ext?: {
            PROPERTY?: AttomV2PropertyItem[]
          }
        }
      }
    }
  }
}

// ─── ATTOM Building Permits Response Types ───────────────────────────────────

interface AttomRawPermit {
  permitNumber?: string
  status?: string
  effectiveDate?: string
  issuedDate?: string
  type?: string
  classification?: string
  description?: string
  jobValue?: string | number
  contractor?: string
}

interface AttomPermitsResponse {
  property?: Array<{
    building?: {
      permits?: AttomRawPermit[]
    }
    [key: string]: unknown
  }>
  status?: { code?: number; msg?: string }
}

// ─── ATTOM AVM Response Types ────────────────────────────────────────────────

interface AttomAvmProperty {
  identifier?: { attomId?: number | string }
  assessment?: {
    market?: { mktttlvalue?: number }
  }
  avm?: {
    amount?: {
      value?: number
      high?: number
      low?: number
      scr?: number  // confidence score
    }
    eventDate?: string
  }
}

interface AttomAvmResponse {
  property?: AttomAvmProperty[]
  status?: { code?: number; msg?: string }
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function parseFloat_(val: string | number | undefined | null): number | null {
  if (val == null) return null
  const n = typeof val === 'string' ? parseFloat(val) : val
  return isNaN(n) ? null : n
}

function parseInt_(val: string | number | undefined | null): number | null {
  if (val == null) return null
  const n = typeof val === 'string' ? parseInt(val, 10) : Math.round(val)
  return isNaN(n) ? null : n
}

function parseAttomDate(val: string | undefined | null): string | null {
  if (!val) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(val)) return val
  if (val.includes('T')) return val.split('T')[0]
  const d = new Date(val)
  if (!isNaN(d.getTime())) return d.toISOString().split('T')[0]
  return null
}

// ─── Normalizers ──────────────────────────────────────────────────────────────

function normalizeProperty(p: AttomV1Property): NormalizedProperty {
  // Coordinates are ONLY in location, not in address
  const lat = parseFloat_(p.location?.latitude)
  const lng = parseFloat_(p.location?.longitude)

  const sqft = p.building?.size?.livingSize ?? p.building?.size?.universalSize ?? p.building?.size?.bldgSize ?? null
  const lastSalePrice = p.sale?.saleAmountData?.saleAmt ?? null
  const lastSaleDate = parseAttomDate(p.sale?.saleTransDate ?? p.sale?.saleSearchDate ?? null)

  const owner = p.assessment?.owner
  const ownerName = owner?.owner1?.fullName ?? undefined

  return {
    id: String(p.identifier?.attomId ?? p.identifier?.Id ?? ''),
    provider: 'attom',

    address: p.address?.line1 ?? p.address?.oneLine ?? '',
    city: p.address?.locality ?? '',
    state: p.address?.countrySubd ?? '',
    zipCode: p.address?.postal1 ?? '',
    county: p.area?.countrySecSubd ?? p.area?.countrysecsubd,

    latitude: lat,
    longitude: lng,

    bedrooms: p.building?.rooms?.beds ?? null,
    bathrooms: p.building?.rooms?.bathsTotal ?? null,
    fullBathrooms: p.building?.rooms?.bathsFull ?? null,
    squareFeet: sqft,
    // lotSize1 = acres, lotSize2 = sqft (confirmed from real data)
    lotSizeAcres: p.lot?.lotSize1 ?? null,
    lotSizeSquareFeet: p.lot?.lotSize2 ?? null,
    yearBuilt: p.summary?.yearBuilt ?? null,
    propertyType: p.summary?.propType ?? p.summary?.propertyType ?? null,
    stories: p.building?.summary?.levels ?? null,

    lastSalePrice,
    lastSaleDate,
    pricePerSqft: lastSalePrice && sqft ? Math.round(lastSalePrice / sqft) : null,

    assessedValue: p.assessment?.assessed?.assdTtlValue ?? null,
    landAssessedValue: p.assessment?.assessed?.assdLandValue ?? null,
    improvementAssessedValue: p.assessment?.assessed?.assdImprValue ?? null,
    marketValue: p.assessment?.market?.mktttlvalue ?? null,
    taxAmount: p.assessment?.tax?.taxAmt ?? null,
    taxYear: p.assessment?.tax?.taxYear ?? undefined,

    subdivision: p.area?.subdName ?? p.area?.subdname,

    construction: {
      type: p.building?.construction?.constructionType,
    },
    features: {
      heating: p.utilities?.heatingType,
      cooling: p.utilities?.coolingType,
    },
    ownership: {
      ownerName,
      // absenteeOwnerStatus 'O' = owner-occupied
      ownerOccupied: owner?.absenteeOwnerStatus === 'O',
      mailingAddress: owner?.mailingAddressOneLine,
    },

    raw: p,
  }
}

function normalizeComparable(item: AttomV2PropertyItem): NormalizedComparable {
  // Comp data is inside COMPARABLE_PROPERTY_ext
  const comp = item.COMPARABLE_PROPERTY_ext
  if (!comp) {
    // Fallback: subject property or malformed item
    return {
      id: String(item['@PropertyParcelID'] ?? ''),
      provider: 'attom',
      address: item['@_StreetAddress'] ?? '',
      city: '', state: '', zipCode: '',
      latitude: null, longitude: null, distanceMiles: null,
      bedrooms: null, bathrooms: null, squareFeet: null,
      lotSizeAcres: null, yearBuilt: null, propertyType: null,
      salePrice: null, saleDate: null, pricePerSqft: null,
    }
  }

  const struct = comp.STRUCTURE
  const sales = comp.SALES_HISTORY
  const site = comp.SITE
  const id_ = comp._IDENTIFICATION

  const sqft = parseInt_(struct?.['@GrossLivingAreaSquareFeetCount'])
  const salePrice = parseFloat_(sales?.['@PropertySalesAmount'])
  // Use API-provided price/sqft when available (more accurate than dividing)
  const pricePerSqft = parseFloat_(sales?.['@PricePerSquareFootAmount']) ??
    (salePrice && sqft ? Math.round(salePrice / sqft) : null)

  const lotSqft = parseFloat_(site?.['@LotSquareFeetCount'])

  return {
    id: String(id_?.['@RTPropertyID_ext'] || id_?.['@DQPropertyID_ext'] || comp['@PropertyParcelID'] || ''),
    provider: 'attom',

    address: comp['@_StreetAddress'] ?? '',
    city: comp['@_City'] ?? '',
    state: comp['@_State'] ?? '',
    zipCode: comp['@_PostalCode'] ?? '',

    latitude: parseFloat_(comp['@LatitudeNumber']),
    longitude: parseFloat_(comp['@LongitudeNumber']),
    distanceMiles: parseFloat_(comp['@DistanceFromSubjectPropertyMilesCount']),

    bedrooms: parseInt_(struct?.['@TotalBedroomCount']),
    bathrooms: parseFloat_(struct?.['@TotalBathroomCount']),
    squareFeet: sqft,
    lotSizeAcres: lotSqft ? lotSqft / 43560 : null,
    yearBuilt: parseInt_(struct?.STRUCTURE_ANALYSIS?.['@PropertyStructureBuiltYear']),
    propertyType: comp['@StandardUseDescription_ext'] ?? null,

    salePrice,
    saleDate: parseAttomDate(sales?.['@TransferDate_ext'] ?? sales?.['@PropertySalesDate'] ?? null),
    pricePerSqft,

    construction: {
      type: undefined,  // not available in v2 comps
    },

    transaction: sales?.['@BuyerUnparsedName_ext'] ? {
      buyerNames: [sales['@BuyerUnparsedName_ext']],
    } : undefined,

    raw: item,
  }
}

// ─── HTTP helper ────────────────────────────────────────────────────────────────

async function attomFetch<T>(apiKey: string, url: string): Promise<T> {
  // Strip API key from URL for logging
  const logUrl = url.replace(/apikey=[^&]+/, 'apikey=***')
  console.log(`ATTOM fetch: ${logUrl}`)

  const res = await fetch(url, {
    headers: {
      Accept: 'application/json',
      apikey: apiKey,
    },
  })

  console.log(`ATTOM response: ${res.status} ${res.statusText} for ${logUrl}`)

  if (res.status === 404) {
    throw new AttomNotFoundError(url)
  }

  // ATTOM returns 400 with SuccessWithoutResult when no matching record exists.
  // Parse the body and treat it as "not found" instead of a hard error.
  if (res.status === 400) {
    const body = await res.json().catch(() => null) as Record<string, unknown> | null
    console.log(`ATTOM 400 body:`, JSON.stringify(body).slice(0, 500))
    const status = body?.status as Record<string, unknown> | undefined
    if (status?.msg === 'SuccessWithoutResult' || status?.total === 0) {
      throw new AttomNotFoundError(url)
    }
    throw new Error(`ATTOM API 400: ${JSON.stringify(body).slice(0, 200)}`)
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    console.log(`ATTOM error body:`, text.slice(0, 500))
    throw new Error(`ATTOM API ${res.status}: ${text.slice(0, 200)}`)
  }

  const data = await res.json() as T
  console.log(`ATTOM response data:`, JSON.stringify(data).slice(0, 1000))
  return data
}

class AttomNotFoundError extends Error {
  constructor(url: string) {
    super(`ATTOM resource not found: ${url}`)
    this.name = 'AttomNotFoundError'
  }
}

// ─── Provider ──────────────────────────────────────────────────────────────────

class AttomProvider implements PropertyProviderAdapter {
  readonly name = 'attom' as const
  private apiKey: string

  constructor(env: Env) {
    this.apiKey = env.ATTOM_API_KEY ?? ''
  }

  // ── Search property by address ──────────────────────────────────────────────
  // ATTOM basicprofile uses address1 (street line) + address2 (city, state, zip)

  async searchProperty(params: PropertySearchParams): Promise<PropertySearchResponse> {
    if (!this.apiKey) {
      return { success: false, error: 'ATTOM API key not configured', code: 'NO_API_KEY' }
    }

    try {
      const { address1, address2 } = this.parseAddress(params)
      if (!address1) {
        return { success: false, error: 'Address is required', code: 'INVALID_PARAMS' }
      }

      const addrQuery = `address1=${encodeURIComponent(address1)}&address2=${encodeURIComponent(address2)}`

      // Fetch expanded profile and AVM in parallel
      const [profileData, avmData] = await Promise.all([
        attomFetch<AttomV1Response>(this.apiKey, `${BASE_URL}/propertyapi/v1.0.0/property/expandedprofile?${addrQuery}`),
        attomFetch<AttomAvmResponse>(this.apiKey, `${BASE_URL}/propertyapi/v1.0.0/attomavm/detail?${addrQuery}`).catch(() => null),
      ])

      if (!profileData.property || profileData.property.length === 0) {
        return { success: false, error: 'Property not found', code: 'NOT_FOUND' }
      }

      const property = normalizeProperty(profileData.property[0])

      // Merge AVM data if available
      if (avmData?.property?.[0]?.avm?.amount) {
        const avm = avmData.property[0].avm.amount
        property.avmValue = avm.value ?? null
        property.avmConfidence = avm.scr ?? null
      }

      return { success: true, data: property }
    } catch (error) {
      if (error instanceof AttomNotFoundError) {
        return { success: false, error: 'Property not found', code: 'NOT_FOUND' }
      }
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Property search failed',
        code: 'API_ERROR',
      }
    }
  }

  /** Parse address params into ATTOM's address1/address2 format */
  private parseAddress(params: PropertySearchParams): { address1: string; address2: string } {
    if (params.streetAddress) {
      return {
        address1: params.streetAddress,
        address2: [params.city, params.state, params.zipCode].filter(Boolean).join(', '),
      }
    }
    if (params.address) {
      const parts = params.address.split(',')
      return {
        address1: parts[0].trim(),
        address2: parts.slice(1).join(',').trim(),
      }
    }
    return { address1: '', address2: '' }
  }

  // ── Get property by ATTOM ID ────────────────────────────────────────────────
  // Uses /property/detail endpoint with attomid param (lowercase)

  async getPropertyById(propertyId: string): Promise<PropertySearchResponse> {
    if (!this.apiKey) {
      return { success: false, error: 'ATTOM API key not configured', code: 'NO_API_KEY' }
    }

    try {
      const url = `${BASE_URL}/propertyapi/v1.0.0/property/detail?attomid=${encodeURIComponent(propertyId)}`
      const data = await attomFetch<AttomV1Response>(this.apiKey, url)

      if (!data.property || data.property.length === 0) {
        return { success: false, error: 'Property not found', code: 'NOT_FOUND' }
      }

      return { success: true, data: normalizeProperty(data.property[0]) }
    } catch (error) {
      if (error instanceof AttomNotFoundError) {
        return { success: false, error: 'Property not found', code: 'NOT_FOUND' }
      }
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Property lookup failed',
        code: 'API_ERROR',
      }
    }
  }

  // ── Get comparables via ATTOM v2 sales comparables endpoint ────────────────

  async getComparables(params: ComparablesSearchParams): Promise<ComparablesSearchResponse> {
    if (!this.apiKey) {
      return { success: false, error: 'ATTOM API key not configured', code: 'NO_API_KEY' }
    }

    try {
      const queryStr = this.buildCompQueryParams(params)
      const url = `${BASE_URL}/property/v2/salescomparables/propid/${params.propertyId}?${queryStr}`
      const data = await attomFetch<AttomV2Response>(this.apiKey, url)

      return this.parseV2CompsResponse(data, params.propertyId, params)
    } catch (error) {
      if (error instanceof AttomNotFoundError) {
        return { success: false, error: 'No comparable properties found', code: 'NOT_FOUND' }
      }
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Comparables search failed',
        code: 'API_ERROR',
      }
    }
  }

  /** Build query params shared by all v2 comps endpoints */
  private buildCompQueryParams(params: ComparablesSearchParams): string {
    const q = new URLSearchParams()
    q.append('searchType', 'Radius')
    q.append('miles', String(params.radiusMiles ?? 1))
    q.append('minComps', '1')
    q.append('maxComps', String(Math.max(1, Math.min(params.maxComps ?? 50, ATTOM_MAX_COMPS))))

    if (params.monthsBack) {
      q.append('saleDateRange', String(params.monthsBack))
    }

    if (params.minBeds !== undefined || params.maxBeds !== undefined) {
      const bedsRange =
        params.maxBeds != null && params.minBeds != null
          ? Math.abs(params.maxBeds - params.minBeds)
          : 2
      q.append('bedroomsRange', String(bedsRange))
    }
    if (params.minBaths !== undefined || params.maxBaths !== undefined) {
      const bathsRange =
        params.maxBaths != null && params.minBaths != null
          ? Math.abs(params.maxBaths - params.minBaths)
          : 1
      q.append('bathroomRange', String(bathsRange))
    }
    if (params.sqftDiff != null) {
      // Absolute sqft tolerance from the sqft_diff rule — never relaxed.
      q.append('sqFeetRange', String(params.sqftDiff))
    } else if (params.sqftVariance && params.subjectSqft) {
      const absoluteVariance = Math.round(params.subjectSqft * (params.sqftVariance / 100))
      q.append('sqFeetRange', String(absoluteVariance))
    } else if (params.sqftVariance) {
      q.append('sqFeetRange', String(params.sqftVariance))
    }

    q.append('includeFullSalesOnly', 'false')
    q.append('distressed', 'IncludeDistressed')

    return q.toString()
  }

  /** Parse the v2 comps response envelope */
  private parseV2CompsResponse(data: AttomV2Response, propertyId: string, params?: ComparablesSearchParams): ComparablesSearchResponse {
    const status = data.RESPONSE_GROUP?.PRODUCT?.STATUS
    if (status && status._Code !== 0 && status._Code !== undefined) {
      return { success: false, error: status._Description ?? 'Comparables request failed' }
    }

    const properties =
      data.RESPONSE_GROUP?.RESPONSE?.RESPONSE_DATA
        ?.PROPERTY_INFORMATION_RESPONSE_ext?.SUBJECT_PROPERTY_ext?.PROPERTY ?? []

    const subjectRaw = properties.length > 0 ? properties[0] : null
    const comparablesRaw = properties.slice(1)

    const comparables = comparablesRaw
      .filter((item) => item.COMPARABLE_PROPERTY_ext != null)
      .map((item) => normalizeComparable(item))

    const requested = params?.maxComps ?? 50
    const effectiveLimit = Math.max(1, Math.min(requested, ATTOM_MAX_COMPS))
    return {
      success: true,
      data: {
        subject: {
          id: propertyId,
          address: subjectRaw?.['@_StreetAddress'] ?? undefined,
        },
        comparables,
        count: comparables.length,
        retrieval: buildRetrievalMeta({
          requested,
          effectiveLimit,
          received: comparables.length,
          ordering: 'distance',
          radiusMiles: params?.radiusMiles ?? 1,
          monthsBack: params?.monthsBack ?? 0,
        }),
      },
    }
  }

  // ── Building permits via /property/buildingpermits (address-based) ──────────

  async getBuildingPermits(propertyId: string, address?: { address1: string; address2: string }): Promise<PermitsResponse> {
    if (!this.apiKey || !address?.address1 || !address?.address2) {
      return { success: true, data: { propertyId, permits: [], count: 0 } }
    }

    try {
      const url = `${BASE_URL}/propertyapi/v1.0.0/property/buildingpermits?address1=${encodeURIComponent(address.address1)}&address2=${encodeURIComponent(address.address2)}`
      const data = await attomFetch<AttomPermitsResponse>(this.apiKey, url)

      const prop = data.property?.[0]
      const rawPermits = prop?.building?.permits ?? []

      const permits: NormalizedPermit[] = rawPermits.map((p, i) => ({
        permitId: `attom-${propertyId}-${i}`,
        permitNumber: p.permitNumber ?? null,
        status: p.status ?? null,
        effectiveDate: parseAttomDate(p.effectiveDate) ?? parseAttomDate(p.issuedDate) ?? null,
        expirationDate: null,
        projectType: p.type ?? p.classification ?? null,
        projectCategory: p.classification ?? null,
        classificationTypes: p.classification ? [p.classification] : [],
        description: p.description ?? null,
        jobValue: parseFloat_(p.jobValue) ?? null,
        contractorName: p.contractor ?? null,
        areaSquareFeet: null,
      }))

      return {
        success: true,
        data: { propertyId, permits, count: permits.length },
      }
    } catch (error) {
      if (error instanceof AttomNotFoundError) {
        return { success: true, data: { propertyId, permits: [], count: 0 } }
      }
      console.log(`ATTOM: Building permits fetch failed for ${propertyId}:`, error)
      return { success: true, data: { propertyId, permits: [], count: 0 } }
    }
  }

  // ── Flood zone — not available in base ATTOM tier ──────────────────────────

  async getFloodZone(_latitude: number, _longitude: number): Promise<FloodZoneResponse> {
    return {
      success: false,
      error: 'Flood zone not available for ATTOM provider',
      code: 'NOT_SUPPORTED',
    }
  }
}

export function createAttomProvider(env: Env): AttomProvider {
  return new AttomProvider(env)
}
