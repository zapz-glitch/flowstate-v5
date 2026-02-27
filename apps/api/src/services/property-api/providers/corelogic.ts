/**
 * CoreLogic Property Provider
 *
 * Implements PropertyProviderAdapter for CoreLogic Property API.
 * Supports multiple API keys with automatic rotation on rate limits.
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
  NormalizedFloodZone,
} from '../types'

// ─── Constants ─────────────────────────────────────────────────────────────────

const BASE_URL = 'https://property.corelogicapi.com'
const SPATIAL_URL = 'https://api-prod.corelogic.com'
const TOKEN_URL = 'https://prod.corelogicapi.com/oauth/token'

// ─── Date Parser ────────────────────────────────────────────────────────────────

/**
 * Parse CoreLogic date formats
 * Handles:
 * - YYYYMMDD format (e.g., "20250115")
 * - ISO format (e.g., "2025-01-15")
 * - Returns ISO date string (YYYY-MM-DD) or null
 */
function parseCoreLogicDate(dateStr: string | undefined | null): string | null {
  if (!dateStr) return null

  // If already in ISO format (has hyphens), validate and return
  if (dateStr.includes('-')) {
    const parsed = new Date(dateStr)
    if (!isNaN(parsed.getTime())) {
      return dateStr.split('T')[0] // Return just the date part
    }
    return null
  }

  // Parse YYYYMMDD format
  if (/^\d{8}$/.test(dateStr)) {
    const year = dateStr.substring(0, 4)
    const month = dateStr.substring(4, 6)
    const day = dateStr.substring(6, 8)
    const isoDate = `${year}-${month}-${day}`
    // Validate the constructed date
    const parsed = new Date(isoDate)
    if (!isNaN(parsed.getTime())) {
      return isoDate
    }
  }

  // Try standard Date parsing as fallback
  const parsed = new Date(dateStr)
  if (!isNaN(parsed.getTime())) {
    return parsed.toISOString().split('T')[0]
  }

  return null
}

// ─── Address Parser ─────────────────────────────────────────────────────────────

interface ParsedAddress {
  streetAddress: string
  city?: string
  state?: string
  zipCode?: string
}

/**
 * Parse an address string into components for CoreLogic API
 * CoreLogic requires: streetAddress + (zipCode OR (city AND state))
 */
function parseAddress(fullAddress: string): ParsedAddress {
  const cleaned = fullAddress.trim().replace(/\s+/g, ' ')

  // Extract zip code (5 digits, optionally with -4 extension)
  const zipMatch = cleaned.match(/\b(\d{5})(?:-\d{4})?(?:\s*$|(?=,))/)
  const zipCode = zipMatch?.[1]
  const withoutZip = zipCode
    ? cleaned.replace(/,?\s*\d{5}(?:-\d{4})?\s*$/, '').trim()
    : cleaned

  // Extract state (2 letter code) - exclude common street suffixes
  const streetSuffixes = ['ST', 'AVE', 'BLVD', 'DR', 'RD', 'LN', 'WAY', 'CT', 'PL', 'CIR', 'TER', 'PKY', 'HWY']
  const stateMatch = withoutZip.match(/[,\s]+([A-Z]{2})$/i)
  const potentialState = stateMatch?.[1]?.toUpperCase()
  const state = potentialState && !streetSuffixes.includes(potentialState) ? potentialState : undefined
  const withoutState = state
    ? withoutZip.replace(/[,\s]+[A-Z]{2}$/i, '').trim()
    : withoutZip

  // Split remaining by comma to get street and city
  const parts = withoutState.split(',').map((p) => p.trim()).filter(Boolean)

  if (parts.length >= 2) {
    return {
      streetAddress: parts[0],
      city: parts[parts.length - 1],
      state,
      zipCode,
    }
  }

  // Try to extract city from space-separated words after street suffix
  if ((state || zipCode) && parts.length === 1) {
    const words = parts[0].split(' ')
    const allSuffixes = [...streetSuffixes, 'STREET', 'AVENUE', 'BOULEVARD', 'DRIVE', 'ROAD', 'LANE', 'COURT', 'PLACE', 'CIRCLE', 'TERRACE', 'PARKWAY', 'HIGHWAY']

    let splitIndex = -1
    for (let i = 0; i < words.length; i++) {
      if (allSuffixes.includes(words[i].toUpperCase())) {
        splitIndex = i
        break
      }
    }

    if (splitIndex > 0 && splitIndex < words.length - 1) {
      return {
        streetAddress: words.slice(0, splitIndex + 1).join(' '),
        city: words.slice(splitIndex + 1).join(' ') || undefined,
        state,
        zipCode,
      }
    }
  }

  return {
    streetAddress: parts[0] || withoutState,
    state,
    zipCode,
  }
}

// ─── Internal Types ────────────────────────────────────────────────────────────

interface TokenCache {
  accessToken: string
  expiresAt: number
}

// ─── State (per isolate) ───────────────────────────────────────────────────────

let tokenCache: TokenCache | null = null

// ─── Authentication ────────────────────────────────────────────────────────────

async function getAccessToken(env: Env): Promise<string> {
  // Return cached token if still valid (with 60 second buffer)
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60000) {
    return tokenCache.accessToken
  }

  const clientId = env.CORELOGIC_CLIENT_ID
  const clientSecret = env.CORELOGIC_CLIENT_SECRET

  if (!clientId || !clientSecret) {
    throw new Error('CoreLogic API credentials not configured (CORELOGIC_CLIENT_ID and CORELOGIC_CLIENT_SECRET)')
  }

  const credentials = btoa(`${clientId}:${clientSecret}`)

  const response = await fetch(`${TOKEN_URL}?grant_type=client_credentials`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${credentials}`,
    },
  })

  if (!response.ok) {
    const errorBody = await response.text()
    console.error('CoreLogic token request failed:', {
      status: response.status,
      body: errorBody.substring(0, 500),
    })
    throw new Error(`CoreLogic auth failed: ${response.status} - ${errorBody.substring(0, 200)}`)
  }

  const data: { access_token: string; expires_in: number } = await response.json()

  tokenCache = {
    accessToken: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  }

  return data.access_token
}

// ─── API Request ───────────────────────────────────────────────────────────────

async function request<T>(
  env: Env,
  endpoint: string,
  options?: {
    params?: Record<string, string | number | boolean | undefined>
    baseUrl?: string
  }
): Promise<T> {
  const token = await getAccessToken(env)
  const baseUrl = options?.baseUrl || BASE_URL

  const url = new URL(`${baseUrl}${endpoint}`)
  if (options?.params) {
    for (const [key, value] of Object.entries(options.params)) {
      if (value !== undefined) {
        url.searchParams.append(key, String(value))
      }
    }
  }

  console.log(`CoreLogic API request: ${url.toString()}`)

  const response = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
  })

  if (response.status === 429) {
    // Clear token cache on rate limit in case token needs refresh
    tokenCache = null
    throw new Error('CoreLogic API rate limited (429)')
  }

  if (response.status === 401 || response.status === 403) {
    const errorBody = await response.text()

    // Check if this is an entitlements error (account doesn't have access to this endpoint)
    if (errorBody.includes('entitlements') || errorBody.includes('not have proper entitlements')) {
      console.warn(`CoreLogic endpoint ${endpoint} not available (entitlements issue)`, {
        status: response.status,
      })
      throw new Error(`ENTITLEMENTS_ERROR: Account does not have access to ${endpoint}`)
    }

    // Clear token cache on auth failure
    tokenCache = null
    throw new Error(`CoreLogic auth failed: ${response.status} - ${errorBody.substring(0, 200)}`)
  }

  if (!response.ok) {
    if (response.status === 404) {
      return { items: [], property: null } as T
    }
    const body = await response.text()
    throw new Error(`CoreLogic API error: ${response.status} - ${body}`)
  }

  return await response.json()
}

// ─── Raw API Types ─────────────────────────────────────────────────────────────

interface RawPropertySearchResponse {
  items?: RawPropertySearchItem[]
  messages?: { message?: string }[]
}

interface RawPropertySearchItem {
  clip: string
  clipId?: string
  propertyAddress?: {
    streetAddress?: string
    city?: string
    state?: string
    zipCode?: string
    county?: string
  }
  address?: {
    streetAddress?: string
    city?: string
    state?: string
    zipCode?: string
    county?: string
  }
  location?: {
    latitude?: number
    longitude?: number
  }
}

interface RawPropertyDetailResponse {
  property?: {
    clip?: string
    address?: {
      streetAddress?: string
      city?: string
      state?: string
      zipCode?: string
      county?: string
    }
    building?: {
      bedrooms?: number
      bathrooms?: number
      buildingSquareFeet?: number
      yearBuilt?: number
      stories?: number
      constructionType?: string
      roofType?: string
      foundation?: string
      heating?: string
      cooling?: string
      parkingSpaces?: number
      garageSquareFeet?: number
      garageType?: string
      poolType?: string
      fireplaces?: number
    }
    lot?: {
      lotSquareFeet?: number
      lotAcres?: number
      zoning?: string
    }
    location?: {
      latitude?: number
      longitude?: number
      subdivision?: string
    }
    owner?: {
      ownerName?: string
      ownerOccupied?: boolean
      mailingAddress?: string
    }
    tax?: {
      assessedValue?: number
      marketValue?: number
      taxAmount?: number
      taxYear?: number
    }
    summary?: {
      propertyType?: string
    }
    zoning?: string
    lastSale?: {
      saleDate?: string
      salePrice?: number
      pricePerSqft?: number
    }
  }
  buildings?: {
    data?: {
      allBuildingsSummary?: {
        bedroomsCount?: number
        bathroomsCount?: number
        fullBathroomsCount?: number
        halfBathroomsCount?: number
        livingAreaSquareFeet?: number
        fireplacesCount?: number
      }
      buildings?: Array<{
        yearBuilt?: number
        effectiveYearBuilt?: number
        constructionType?: string
        roofType?: string
        roofCover?: string
        exteriorWalls?: string
        foundation?: string
        heating?: string
        cooling?: string
        parkingSpacesCount?: number
        garageSquareFeet?: number
        poolType?: string
        storiesCount?: number
      }>
    }
  }
  ownership?: {
    data?: {
      owners?: Array<{ fullName?: string }>
      ownerOccupied?: boolean
      mailingAddress?: {
        streetAddress?: string
        city?: string
        state?: string
        zip?: string
      }
    }
  }
  siteLocation?: {
    data?: {
      coordinatesParcel?: { lat?: number; lng?: number }
      locationLegal?: { subdivision?: string }
      lot?: { areaAcres?: number; areaSquareFeet?: number }
      landUseAndZoningCodes?: { landUseDescription?: string; zoningCode?: string }
    }
  }
  taxAssessment?: {
    data?: {
      totalMarketValue?: number
      totalAssessedValue?: number
      landAssessedValue?: number
      improvementAssessedValue?: number
      taxAmount?: number
      taxYear?: number
    }
  }
  lastMarketSale?: {
    data?: {
      saleDate?: string
      salePrice?: number
      pricePerSquareFoot?: number
      buyerNames?: string[]
      sellerNames?: string[]
      buyerIsCorporate?: boolean
      titleCompany?: string
      isCashPurchase?: boolean
      documentType?: string
    }
  }
  mostRecentOwnerTransfer?: {
    data?: {
      saleDate?: string
      salePrice?: number
      buyerName?: string
      sellerName?: string
    }
  }
}

interface RawComparablesResponse {
  clip?: string
  comparables?: RawComparableProperty[]
}

interface RawComparableProperty {
  clip: string
  clipId?: string
  streetAddress?: string
  city?: string
  state?: string
  zip?: string
  latitude?: number
  longitude?: number
  bedrooms?: number
  baths?: number
  buildingSquareFeet?: number
  lotSquareFeet?: number
  yearBuilt?: string | number
  salePrice?: number
  lastSalePrice?: number // Alternative field name
  saleAmount?: number // Alternative field name
  saleDate?: string
  lastSaleDate?: string // Alternative field name used by some API responses
  recordingDate?: string // Fallback if saleDate is not available
  distance?: number
  pricePerSquareFoot?: number
  propertyType?: string
}

interface RawPermit {
  permitId?: string
  permitNumber?: string
  status?: string
  effectiveDate?: string
  expirationDate?: string
  projectType?: string
  projectCategory?: string
  classificationTypes?: string[]
  description?: string
  jobValue?: number
  contractorName?: string
  areaSquareFeet?: number
}

interface RawPermitsResponse {
  permits?: RawPermit[]
}

interface RawFloodZoneResponse {
  floodHazardZone?: string
  sfha?: string
  within250FtOfFloodZone?: string
  communityName?: string
  communityNumber?: string
  mapPanel?: string
  floodZone?: string
  panelNumber?: string
  mapDate?: string
  participationStatus?: string
}

// ─── Normalizers ───────────────────────────────────────────────────────────────

interface AddressFallback {
  streetAddress?: string
  city?: string
  state?: string
  zipCode?: string
  county?: string
  latitude?: number
  longitude?: number
}

function normalizeProperty(
  raw: RawPropertyDetailResponse,
  clip: string,
  addressFallback?: AddressFallback
): NormalizedProperty {
  // Cast to access actual API structure (types may not match reality)
  // CoreLogic API actual response differs from typed definitions
  const rawData = raw as Record<string, unknown>

  // Legacy property object (may be missing in some responses)
  const property = raw.property
  const address = property?.address
  const building = property?.building
  const location = property?.location
  const owner = property?.owner
  const tax = property?.tax
  const lastSale = property?.lastSale
  const lotLegacy = property?.lot

  // Buildings data - v1 structure: buildings.data.allBuildingsSummary, buildings.data.Buildings[0]
  // Note: API schema shows "Buildings" with capital B, but may also return lowercase
  const buildingsResponse = rawData.buildings as Record<string, unknown> | undefined
  const buildingsData = buildingsResponse?.data as Record<string, unknown> | undefined
  const buildingSummary = buildingsData?.allBuildingsSummary as Record<string, unknown> | undefined
  // Try both "Buildings" (per API schema) and "buildings" (common convention)
  const buildingsArray = (buildingsData?.Buildings || buildingsData?.buildings) as Array<Record<string, unknown>> | undefined
  const firstBuilding = buildingsArray?.[0]
  const constructionDetails = firstBuilding?.constructionDetails as Record<string, unknown> | undefined
  const structureFeatures = firstBuilding?.structureFeatures as Record<string, unknown> | undefined
  const structureExterior = firstBuilding?.structureExterior as Record<string, unknown> | undefined

  // Site location data - v1 structure: siteLocation.data.locationLegal, landUseAndZoningCodes
  const siteLocationResponse = rawData.siteLocation as Record<string, unknown> | undefined
  const siteLocationData = siteLocationResponse?.data as Record<string, unknown> | undefined
  const coordinatesParcel = siteLocationData?.coordinatesParcel as Record<string, unknown> | undefined
  const lot = siteLocationData?.lot as Record<string, unknown> | undefined
  const locationLegal = siteLocationData?.locationLegal as Record<string, unknown> | undefined
  const landUse = siteLocationData?.landUseAndZoningCodes as Record<string, unknown> | undefined

  // Ownership data - v1 structure: ownership.data.currentOwners
  const ownershipResponse = rawData.ownership as Record<string, unknown> | undefined
  const ownershipData = ownershipResponse?.data as Record<string, unknown> | undefined
  const currentOwners = ownershipData?.currentOwners as Record<string, unknown> | undefined
  const ownerNamesArray = currentOwners?.ownerNames as Array<Record<string, unknown>> | undefined
  const mailingInfo = ownershipData?.currentOwnerMailingInfo as Record<string, unknown> | undefined
  const mailingAddressData = mailingInfo?.mailingAddress as Record<string, unknown> | undefined

  // Tax data - v1 uses items array: taxAssessment.items[0]
  const taxAssessmentResponse = rawData.taxAssessment as Record<string, unknown> | undefined
  const taxItems = taxAssessmentResponse?.items as Array<Record<string, unknown>> | undefined
  const taxItem = taxItems?.[0]
  const taxAmountObj = taxItem?.taxAmount as Record<string, unknown> | undefined
  const assessedValueObj = taxItem?.assessedValue as Record<string, unknown> | undefined

  // Last market sale - v1 uses items array: lastMarketSale.items[0].transactionDetails
  const lastMarketSaleResponse = rawData.lastMarketSale as Record<string, unknown> | undefined
  const saleItems = lastMarketSaleResponse?.items as Array<Record<string, unknown>> | undefined
  const saleItem = saleItems?.[0]
  const transactionDetails = saleItem?.transactionDetails as Record<string, unknown> | undefined
  const buyerDetails = saleItem?.buyerDetails as Record<string, unknown> | undefined
  const sellerDetails = saleItem?.sellerDetails as Record<string, unknown> | undefined
  const titleCompanyData = saleItem?.titleCompany as Record<string, unknown> | undefined

  // Extract buyer/seller names
  const buyerNamesArray = buyerDetails?.buyerNames as Array<Record<string, unknown>> | undefined
  const sellerNamesArray = sellerDetails?.sellerNames as Array<Record<string, unknown>> | undefined

  // Get property type from land use (v1 approach)
  const propertyType = (landUse?.stateLandUseDescription as string) ||
    (landUse?.countyLandUseDescription as string) ||
    (landUse?.landUseDescription as string) ||
    property?.summary?.propertyType ||
    null

  // Get year built from constructionDetails (v1 approach)
  const yearBuilt = (constructionDetails?.yearBuilt as number) ||
    (firstBuilding?.yearBuilt as number) ||
    building?.yearBuilt ||
    null

  const sqft = (buildingSummary?.livingAreaSquareFeet as number) ||
    (buildingSummary?.totalAreaSquareFeet as number) ||
    building?.buildingSquareFeet ||
    null

  const salePrice = (transactionDetails?.saleAmount as number) ||
    (transactionDetails?.salePrice as number) ||
    lastSale?.salePrice ||
    null

  const saleDate = (transactionDetails?.saleDateDerived as string) ||
    (transactionDetails?.saleRecordingDateDerived as string) ||
    lastSale?.saleDate ||
    null

  return {
    id: clip,
    provider: 'corelogic',

    // Address - use fallback if main address is missing
    address: address?.streetAddress || addressFallback?.streetAddress || '',
    city: address?.city || addressFallback?.city || '',
    state: address?.state || addressFallback?.state || '',
    zipCode: address?.zipCode || addressFallback?.zipCode || '',
    county: address?.county || addressFallback?.county,

    // Coordinates - use fallback if main location is missing
    latitude: location?.latitude || (coordinatesParcel?.lat as number) || addressFallback?.latitude || null,
    longitude: location?.longitude || (coordinatesParcel?.lng as number) || addressFallback?.longitude || null,

    // Property characteristics
    bedrooms: (buildingSummary?.bedroomsCount as number) || building?.bedrooms || null,
    bathrooms: (buildingSummary?.bathroomsCount as number) || building?.bathrooms || null,
    fullBathrooms: (buildingSummary?.fullBathroomsCount as number) || undefined,
    halfBathrooms: (buildingSummary?.halfBathroomsCount as number) || undefined,
    squareFeet: sqft,
    lotSizeAcres: (lot?.areaAcres as number) || lotLegacy?.lotAcres || null,
    lotSizeSquareFeet: (lot?.areaSquareFeet as number) || lotLegacy?.lotSquareFeet,
    yearBuilt,
    effectiveYearBuilt: (constructionDetails?.effectiveYearBuilt as number) || undefined,
    propertyType,
    stories: (firstBuilding?.storiesCount as number) || building?.stories || null,

    // Sale information
    lastSalePrice: salePrice,
    lastSaleDate: saleDate,
    pricePerSqft: sqft && salePrice ? Math.round(salePrice / sqft) : lastSale?.pricePerSqft,

    // Tax & Assessment (from taxAssessment.items[0])
    assessedValue: (assessedValueObj?.calculatedTotalValue as number) || tax?.assessedValue || null,
    landAssessedValue: (assessedValueObj?.calculatedLandValue as number) || undefined,
    improvementAssessedValue: (assessedValueObj?.calculatedImprovementValue as number) || undefined,
    marketValue: tax?.marketValue || null,
    taxAmount: (taxAmountObj?.totalTaxAmount as number) || tax?.taxAmount || null,
    taxYear: (taxAmountObj?.billedYear as number) || (assessedValueObj?.taxAssessedYear as number) || tax?.taxYear,

    // Building details
    construction: {
      type: (constructionDetails?.constructionTypeCode as string) || building?.constructionType,
      roofType: ((structureExterior?.roof as Record<string, unknown>)?.typeCode as string) || building?.roofType,
      roofCover: ((structureExterior?.roof as Record<string, unknown>)?.coverTypeCode as string) || undefined,
      foundationType: (constructionDetails?.foundationTypeCode as string) || building?.foundation,
      exteriorWalls: ((structureExterior?.walls as Record<string, unknown>)?.typeCode as string) || undefined,
    },
    features: {
      heating: ((structureFeatures?.heating as Record<string, unknown>)?.typeCode as string) || building?.heating,
      cooling: ((structureFeatures?.airConditioning as Record<string, unknown>)?.typeCode as string) || building?.cooling,
      fireplacesCount: ((structureFeatures?.firePlaces as Record<string, unknown>)?.count as number) || (buildingSummary?.fireplacesCount as number) || building?.fireplaces,
      poolType: ((structureExterior?.pool as Record<string, unknown>)?.typeCode as string) || building?.poolType,
      garageType: ((structureExterior?.parking as Record<string, unknown>)?.garageTypeCode as string) || building?.garageType,
      garageSquareFeet: ((structureExterior?.parking as Record<string, unknown>)?.garageAreaSquareFeet as number) || building?.garageSquareFeet,
      parkingSpaces: ((structureExterior?.parking as Record<string, unknown>)?.parkingSpacesCount as number) || building?.parkingSpaces,
    },

    // Ownership
    ownership: {
      ownerName: (ownerNamesArray?.[0]?.fullName as string) || owner?.ownerName,
      ownerOccupied: currentOwners?.occupancyCode
        ? ['M', 'O', 'S'].includes(currentOwners.occupancyCode as string)
        : owner?.ownerOccupied,
      mailingAddress: mailingAddressData
        ? [
            mailingAddressData.streetAddress as string,
            mailingAddressData.city as string,
            mailingAddressData.state as string,
            mailingAddressData.zipCode as string,
          ].filter(Boolean).join(', ') || undefined
        : owner?.mailingAddress,
    },

    // Transaction details from last sale
    transaction: transactionDetails
      ? {
          buyerNames: buyerNamesArray?.map(b => b.fullName as string).filter(Boolean),
          sellerNames: sellerNamesArray?.map(s => s.fullName as string).filter(Boolean),
          buyerIsCorporate: buyerNamesArray?.some(b => b.isCorporate === true),
          titleCompany: (titleCompanyData?.name as string) || undefined,
          isCashPurchase: transactionDetails.isCashPurchase as boolean | undefined,
          saleDocumentType: (transactionDetails.saleDocumentTypeCode as string) || undefined,
        }
      : undefined,

    // Location details - use v1 structure: siteLocation.data.locationLegal.subdivisionName
    subdivision: (locationLegal?.subdivisionName as string) || location?.subdivision || undefined,
    zoning: (landUse?.zoningCode as string) || property?.zoning || undefined,
    zoningDescription: (landUse?.zoningCodeDescription as string) || (landUse?.landUseDescription as string) || undefined,

    raw,
  }
}

function normalizeComparable(raw: RawComparableProperty): NormalizedComparable {
  const sqft = raw.buildingSquareFeet || null

  // Try multiple field names for sale price (CoreLogic API returns different fields)
  let price = raw.salePrice || raw.lastSalePrice || raw.saleAmount || null

  // If salePrice is missing but we have pricePerSquareFoot and sqft, calculate it
  // This happens with some CoreLogic API responses
  if (!price && raw.pricePerSquareFoot && sqft) {
    price = Math.round(raw.pricePerSquareFoot * sqft)
    console.log(`[CoreLogic] Calculated salePrice from pricePerSquareFoot:`, {
      clip: raw.clip,
      pricePerSquareFoot: raw.pricePerSquareFoot,
      sqft,
      calculatedPrice: price,
    })
  }

  // Parse sale date using CoreLogic date parser
  // Falls back to lastSaleDate or recordingDate if saleDate is not available
  const saleDate = parseCoreLogicDate(raw.saleDate) ||
    parseCoreLogicDate(raw.lastSaleDate) ||
    parseCoreLogicDate(raw.recordingDate)

  return {
    id: raw.clipId || raw.clip,
    provider: 'corelogic',

    address: raw.streetAddress || '',
    city: raw.city || '',
    state: raw.state || '',
    zipCode: raw.zip || '',

    latitude: raw.latitude || null,
    longitude: raw.longitude || null,

    distanceMiles: raw.distance || null,

    bedrooms: raw.bedrooms || null,
    bathrooms: raw.baths || null,
    squareFeet: sqft,
    lotSizeAcres: raw.lotSquareFeet ? raw.lotSquareFeet / 43560 : null,
    yearBuilt: typeof raw.yearBuilt === 'string' ? parseInt(raw.yearBuilt, 10) || null : raw.yearBuilt || null,
    propertyType: raw.propertyType || null,

    salePrice: price,
    saleDate,
    pricePerSqft: raw.pricePerSquareFoot || (sqft && price ? Math.round(price / sqft) : null),

    raw,
  }
}

function normalizePermit(raw: RawPermit): NormalizedPermit {
  return {
    permitId: raw.permitId || '',
    permitNumber: raw.permitNumber || null,
    status: raw.status || null,
    effectiveDate: raw.effectiveDate || null,
    expirationDate: raw.expirationDate || null,
    projectType: raw.projectType || null,
    projectCategory: raw.projectCategory || null,
    classificationTypes: raw.classificationTypes || [],
    description: raw.description || null,
    jobValue: raw.jobValue || null,
    contractorName: raw.contractorName || null,
    areaSquareFeet: raw.areaSquareFeet || null,
  }
}

function normalizeFloodZone(raw: RawFloodZoneResponse): NormalizedFloodZone {
  const zone = raw.floodZone || raw.floodHazardZone || null
  const isHighRisk = zone ? ['A', 'AE', 'AH', 'AO', 'AR', 'V', 'VE'].some((z) => zone.startsWith(z)) : false
  const isNear = raw.within250FtOfFloodZone === 'Yes' || raw.within250FtOfFloodZone === 'true'

  return {
    floodZone: zone,
    floodZoneDescription: getFloodZoneDescription(zone),
    isInFloodZone: isHighRisk,
    isNearFloodZone: isNear,
    communityName: raw.communityName || null,
    communityNumber: raw.communityNumber || null,
    firmMapNumber: raw.mapPanel || null,
    mapPanel: raw.panelNumber || null,
    mapDate: raw.mapDate || null,
    participationStatus: raw.participationStatus || null,
  }
}

function getFloodZoneDescription(zone: string | null): string | null {
  if (!zone) return null

  const descriptions: Record<string, string> = {
    A: 'High Risk - 100-year flood, no base flood elevations',
    AE: 'High Risk - 100-year flood with base flood elevations',
    AH: 'High Risk - Shallow flooding, 1-3 feet',
    AO: 'High Risk - Sheet flow, 1-3 feet',
    AR: 'High Risk - Restoration zone',
    V: 'High Risk - Coastal flooding with wave action',
    VE: 'High Risk - Coastal with base flood elevations',
    B: 'Moderate Risk - 500-year flood zone',
    X: 'Minimal Risk - Outside 500-year flood zone',
    C: 'Minimal Risk - Outside 500-year flood zone',
    D: 'Undetermined Risk - No analysis performed',
  }

  return descriptions[zone] || descriptions[zone.charAt(0)] || 'Unknown flood zone'
}

// ─── Provider Implementation ───────────────────────────────────────────────────

class CoreLogicProvider implements PropertyProviderAdapter {
  readonly name = 'corelogic' as const
  private env: Env

  constructor(env: Env) {
    this.env = env
  }

  async searchProperty(params: PropertySearchParams): Promise<PropertySearchResponse> {
    try {
      // Build address from components or parse full address
      let searchParams: Record<string, string | undefined> = {}

      if (params.streetAddress) {
        // Use provided components
        searchParams.streetAddress = params.streetAddress
        if (params.city) searchParams.city = params.city
        if (params.state) searchParams.state = params.state
        if (params.zipCode) searchParams.zipCode = params.zipCode
      } else if (params.address) {
        // Parse full address string into components
        const parsed = parseAddress(params.address)
        searchParams = {
          streetAddress: parsed.streetAddress,
          city: parsed.city,
          state: parsed.state,
          zipCode: parsed.zipCode,
        }

        console.log('CoreLogic: Parsed address', {
          original: params.address,
          parsed,
        })

        // Validate required fields
        if (!parsed.zipCode && !(parsed.city && parsed.state)) {
          return {
            success: false,
            error: 'Please provide a complete address including city/state or zip code.',
            code: 'INVALID_ADDRESS',
          }
        }
      }

      const response = await request<RawPropertySearchResponse>(this.env, '/v2/properties/search', {
        params: {
          ...searchParams,
          bestMatch: true,
        },
      })

      if (!response.items?.length) {
        return {
          success: false,
          error: 'Property not found',
          code: 'NOT_FOUND',
        }
      }

      const item = response.items[0]
      const clip = item.clipId || item.clip

      // Extract address from search result as fallback
      const searchAddress = item.propertyAddress || item.address
      const addressFallback: AddressFallback = {
        streetAddress: searchAddress?.streetAddress,
        city: searchAddress?.city,
        state: searchAddress?.state,
        zipCode: searchAddress?.zipCode,
        county: searchAddress?.county,
        latitude: item.location?.latitude,
        longitude: item.location?.longitude,
      }

      // Fetch full property details
      const detailResponse = await request<RawPropertyDetailResponse>(this.env, `/v2/properties/${clip}/property-detail`)

      return {
        success: true,
        data: normalizeProperty(detailResponse, clip, addressFallback),
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Property search failed',
        code: 'API_ERROR',
      }
    }
  }

  async getPropertyById(propertyId: string): Promise<PropertySearchResponse> {
    try {
      const detailResponse = await request<RawPropertyDetailResponse>(this.env, `/v2/properties/${propertyId}/property-detail`)
      // Check if we have any useful data - property object OR buildings.data OR siteLocation.data
      const hasData = detailResponse.property || detailResponse.buildings?.data || detailResponse.siteLocation?.data

      if (!hasData) {
        return {
          success: false,
          error: 'Property not found',
          code: 'NOT_FOUND',
        }
      }

      return {
        success: true,
        data: normalizeProperty(detailResponse, propertyId),
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Property lookup failed',
        code: 'API_ERROR',
      }
    }
  }

  async getComparables(params: ComparablesSearchParams): Promise<ComparablesSearchResponse> {
    try {
      // Calculate min/max sqft if sqftVariance and subjectSqft are provided
      // Using minBldgSqFt/maxBldgSqFt instead of bldgSqFtVariance because
      // the variance param doesn't work correctly in CoreLogic API
      let minBldgSqFt: number | undefined
      let maxBldgSqFt: number | undefined
      if (params.sqftVariance && params.subjectSqft) {
        minBldgSqFt = Math.max(0, params.subjectSqft - params.sqftVariance)
        maxBldgSqFt = params.subjectSqft + params.sqftVariance
        console.log(`CoreLogic: Using sqft range ${minBldgSqFt}-${maxBldgSqFt} (subject: ${params.subjectSqft}, variance: ${params.sqftVariance})`)
      }

      const response = await request<RawComparablesResponse>(this.env, `/v2/properties/${params.propertyId}/comparables`, {
        params: {
          searchDistance: params.radiusMiles ?? 1,
          maxComps: params.maxComps ?? 10,
          monthsBack: params.monthsBack ?? 12,
          minBedrooms: params.minBeds,
          maxBedrooms: params.maxBeds,
          minBathrooms: params.minBaths,
          maxBathrooms: params.maxBaths,
          minBldgSqFt,
          maxBldgSqFt,
          sortBy: 'Distance',
        },
      })

      const comparables = (response.comparables || []).map(normalizeComparable)

      return {
        success: true,
        data: {
          subject: {
            id: params.propertyId,
          },
          comparables,
          count: comparables.length,
        },
      }
    } catch (error) {
      // Handle entitlements error gracefully - return empty comparables
      if (error instanceof Error && error.message.includes('ENTITLEMENTS_ERROR')) {
        console.log('Comparables not available for this account, returning empty list')
        return {
          success: true,
          data: {
            subject: { id: params.propertyId },
            comparables: [],
            count: 0,
          },
        }
      }

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Comparables search failed',
        code: 'API_ERROR',
      }
    }
  }

  async getBuildingPermits(propertyId: string): Promise<PermitsResponse> {
    try {
      const response = await request<RawPermitsResponse>(this.env, `/v2/properties/${propertyId}/permits`)

      const permits = (response.permits || []).map(normalizePermit)

      return {
        success: true,
        data: {
          propertyId,
          permits,
          count: permits.length,
        },
      }
    } catch (error) {
      // Handle entitlements error gracefully - permits are optional
      if (error instanceof Error && error.message.includes('ENTITLEMENTS_ERROR')) {
        console.log('Permits not available for this account, returning empty permits')
        return {
          success: true,
          data: {
            propertyId,
            permits: [],
            count: 0,
          },
        }
      }

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Permits lookup failed',
        code: 'API_ERROR',
      }
    }
  }

  async getFloodZone(latitude: number, longitude: number): Promise<FloodZoneResponse> {
    try {
      const response = await request<RawFloodZoneResponse>(this.env, '/spatial-api/flood-zone-determination', {
        baseUrl: SPATIAL_URL,
        params: {
          latitude,
          longitude,
          mapTile: 'none',
        },
      })

      return {
        success: true,
        data: normalizeFloodZone(response),
      }
    } catch (error) {
      // Flood zone is optional, return empty response on failure
      return {
        success: true,
        data: {
          floodZone: null,
          floodZoneDescription: null,
          isInFloodZone: false,
          isNearFloodZone: false,
          communityName: null,
          communityNumber: null,
          firmMapNumber: null,
          mapPanel: null,
          mapDate: null,
          participationStatus: null,
        },
      }
    }
  }

  getKeyStatus(): {
    configured: boolean
    hasToken: boolean
  } {
    const clientId = this.env.CORELOGIC_CLIENT_ID
    const clientSecret = this.env.CORELOGIC_CLIENT_SECRET
    const configured = !!(clientId && clientSecret)

    return {
      configured,
      hasToken: tokenCache !== null && tokenCache.expiresAt > Date.now(),
    }
  }
}

// ─── Factory Function ──────────────────────────────────────────────────────────

export function createCoreLogicProvider(env: Env): CoreLogicProvider {
  return new CoreLogicProvider(env)
}
