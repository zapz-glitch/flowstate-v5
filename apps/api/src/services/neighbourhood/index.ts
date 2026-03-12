/**
 * Neighbourhood Analysis Service
 *
 * Fetches community, school, and POI data from ATTOM v4 APIs.
 *
 * Flow:
 *   1. Hierarchy lookup: lat/lng → geoIdV4 (needed for community endpoint)
 *   2. Parallel: community (crime, demographics, climate) + schools + POI
 *
 * All sub-fetches are non-fatal — returns null on failure.
 */

const BASE_URL = 'https://api.gateway.attomdata.com'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface NeighbourhoodData {
  geoIdV4: string | null
  community: CommunityData | null
  schools: SchoolData | null
  poi: POIData | null
}

export interface CommunityData {
  crime: CrimeData | null
  demographics: DemographicsData | null
  climate: ClimateData | null
}

export interface CrimeData {
  crimeIndex: number | null
  crimeRisk: string | null
  // Violent crime breakdown (all indices: 100 = national avg, higher = worse)
  murderIndex: number | null
  assaultIndex: number | null
  robberyIndex: number | null
  // Property crime breakdown
  burglaryIndex: number | null
  larcenyIndex: number | null
  motorVehicleTheftIndex: number | null
  // Aggregated (kept for backward compat)
  violentCrimeIndex: number | null
  propertyCrimeIndex: number | null
}

export interface DemographicsData {
  population: number | null
  populationDensity: number | null
  medianIncome: number | null
  medianAge: number | null
  householdCount: number | null
  medianHomeValue: number | null
}

export interface ClimateData {
  avgHighTemp: number | null
  avgLowTemp: number | null
  annualRainfall: number | null
  annualSnowfall: number | null
  comfortIndex: number | null
}

export interface SchoolData {
  nearby: SchoolItem[]
  count: number
}

export interface SchoolItem {
  name: string
  type: string | null
  gradeRange: string | null
  rating: number | null
  distance: number | null
  address: string | null
  latitude: number | null
  longitude: number | null
  geoIdV4: string | null
}

export interface POIData {
  items: POIItem[]
  summary: Record<string, number>
}

export interface POIItem {
  name: string
  category: string | null
  address: string | null
  distance: number | null
  latitude: number | null
  longitude: number | null
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AttomRawResponse = Record<string, any>

// ─── HTTP Helper ─────────────────────────────────────────────────────────────

async function attomV4Fetch<T = AttomRawResponse>(apiKey: string, url: string): Promise<T> {
  const logUrl = url.replace(/apikey=[^&]+/, 'apikey=***')
  console.log(`ATTOM v4 fetch: ${logUrl}`)

  const res = await fetch(url, {
    headers: {
      Accept: 'application/json',
      apikey: apiKey,
    },
  })

  console.log(`ATTOM v4 response: ${res.status} ${res.statusText} for ${logUrl}`)

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    console.log(`ATTOM v4 error body:`, text.slice(0, 500))
    throw new Error(`ATTOM v4 API ${res.status}: ${text.slice(0, 200)}`)
  }

  const data = await res.json() as T
  return data
}

// ─── Parsers ─────────────────────────────────────────────────────────────────

function parseNum(val: unknown): number | null {
  if (val == null) return null
  const n = typeof val === 'string' ? parseFloat(val) : Number(val)
  return isNaN(n) ? null : n
}

/** Average of non-null values, or null if all are null */
function avgNonNull(values: (number | null)[]): number | null {
  const valid = values.filter((v): v is number => v != null)
  if (valid.length === 0) return null
  return Math.round(valid.reduce((a, b) => a + b, 0) / valid.length)
}

function parseHierarchyResponse(data: AttomRawResponse): string | null {
  // ATTOM v4 hierarchy response structure:
  // { response: { result: { package: { item: [ { type, geoIdV4, name, ... }, ... ] } } } }
  const items = data?.response?.result?.package?.item ?? []
  if (!Array.isArray(items) || items.length === 0) {
    console.log('ATTOM v4: No items in hierarchy response')
    return null
  }

  // Prefer ZI (zip) or N2/N3 (neighbourhood) level for community data
  for (const type of ['ZI', 'N2', 'N3', 'N1', 'CO']) {
    const match = items.find((item: AttomRawResponse) => item?.type === type)
    if (match?.geoIdV4) return String(match.geoIdV4)
  }

  // Fallback: first item with geoIdV4
  const first = items.find((item: AttomRawResponse) => item?.geoIdV4)
  return first?.geoIdV4 ? String(first.geoIdV4) : null
}

function parseCommunityResponse(data: AttomRawResponse): CommunityData | null {
  // ATTOM v4 community response structure:
  // { status: {...}, community: { geography: {...}, demographics: {...}, crime: {...}, climate: {...}, ... } }
  const community = data?.community ?? data
  const crimeSection = community?.crime ?? null
  const demoSection = community?.demographics ?? null
  const climateSection = community?.climate ?? null

  // Crime: ATTOM uses snake_Case — crime_Index, murder_Index, burglary_Index, etc.
  // All indices: 100 = national average, higher = more crime
  const murderIdx = parseNum(crimeSection?.murder_Index)
  const assaultIdx = parseNum(crimeSection?.aggravated_Assault_Index)
  const robberyIdx = parseNum(crimeSection?.forcible_Robbery_Index)
  const burglaryIdx = parseNum(crimeSection?.burglary_Index)
  const larcenyIdx = parseNum(crimeSection?.larceny_Index)
  const motorTheftIdx = parseNum(crimeSection?.motor_Vehicle_Theft_Index)

  const crime: CrimeData | null = crimeSection ? {
    crimeIndex: parseNum(crimeSection.crime_Index),
    crimeRisk: deriveCrimeRisk(parseNum(crimeSection.crime_Index)),
    murderIndex: murderIdx,
    assaultIndex: assaultIdx,
    robberyIndex: robberyIdx,
    burglaryIndex: burglaryIdx,
    larcenyIndex: larcenyIdx,
    motorVehicleTheftIndex: motorTheftIdx,
    // Aggregated: average of available sub-indices per category
    violentCrimeIndex: avgNonNull([murderIdx, assaultIdx, robberyIdx]),
    propertyCrimeIndex: avgNonNull([burglaryIdx, larcenyIdx, motorTheftIdx]),
  } : null

  // Demographics: ATTOM uses snake_Case —
  // population, population_Density_Sq_Mi, median_Household_Income, median_Age,
  // households, housing_Owner_Households_Median_Value
  const demographics: DemographicsData | null = demoSection ? {
    population: parseNum(demoSection.population),
    populationDensity: parseNum(demoSection.population_Density_Sq_Mi),
    medianIncome: parseNum(demoSection.median_Household_Income),
    medianAge: parseNum(demoSection.median_Age),
    householdCount: parseNum(demoSection.households),
    medianHomeValue: parseNum(demoSection.housing_Owner_Households_Median_Value),
  } : null

  // Climate: ATTOM uses snake_Case —
  // annual_Avg_Temp_Max, annual_Avg_Temp_Min, annual_Precip_In, annual_Snowfall_In
  const climate: ClimateData | null = climateSection ? {
    avgHighTemp: parseNum(climateSection.annual_Avg_Temp_Max),
    avgLowTemp: parseNum(climateSection.annual_Avg_Temp_Min),
    annualRainfall: parseNum(climateSection.annual_Precip_In),
    annualSnowfall: parseNum(climateSection.annual_Snowfall_In),
    comfortIndex: null, // ATTOM doesn't provide a comfort index directly
  } : null

  if (!crime && !demographics && !climate) return null
  return { crime, demographics, climate }
}

/** Derive a human-readable crime risk label from ATTOM crime_Index (100 = national avg) */
function deriveCrimeRisk(crimeIndex: number | null): string | null {
  if (crimeIndex == null) return null
  if (crimeIndex <= 50) return 'Low'
  if (crimeIndex <= 100) return 'Moderate'
  if (crimeIndex <= 200) return 'High'
  return 'Very High'
}

function parseSchoolsResponse(data: AttomRawResponse): SchoolData | null {
  // ATTOM v4 school/search response structure:
  // { status: {...}, schools: [ { location: {...}, detail: {...}, district: {...} }, ... ] }
  const schools = data?.schools ?? []

  if (!Array.isArray(schools) || schools.length === 0) {
    console.log('Schools: no school array found in response')
    return null
  }

  const nearby: SchoolItem[] = schools.slice(0, 20).map((s: AttomRawResponse) => {
    const detail = s?.detail ?? {}
    const location = s?.location ?? {}
    return {
      name: detail.schoolName ?? 'Unknown',
      type: detail.schoolType ?? detail.institutionType ?? null,
      gradeRange: detail.gradeSpanLow != null && detail.gradeSpanHigh != null
        ? `${detail.gradeSpanLow}-${detail.gradeSpanHigh}`
        : null,
      rating: parseSchoolRating(detail.schoolRating),
      distance: parseNum(detail.distance),
      address: location.addressLine1 ?? null,
      latitude: parseNum(location.latitude),
      longitude: parseNum(location.longitude),
      geoIdV4: location.geoIdV4 ?? null,
    }
  })

  return { nearby, count: data?.status?.total ?? nearby.length }
}

/** Parse ATTOM school rating which can be letter grade (A+, B-, etc.) or numeric */
function parseSchoolRating(rating: unknown): number | null {
  if (rating == null) return null
  // Try numeric first
  const num = parseNum(rating)
  if (num != null) return num
  // Convert letter grades to 1-10 scale
  const letterMap: Record<string, number> = {
    'A+': 10, 'A': 9, 'A-': 8,
    'B+': 7, 'B': 6, 'B-': 5,
    'C+': 4, 'C': 3, 'C-': 2,
    'D+': 2, 'D': 1, 'D-': 1,
    'F': 0,
  }
  const str = String(rating).trim()
  return letterMap[str] ?? null
}

function parsePOIResponse(data: AttomRawResponse): POIData | null {
  // ATTOM v4 POI response structure:
  // { status: {...}, poi: [ { businessLocation: {...}, category: {...}, details: {...} }, ... ] }
  const pois = data?.poi ?? []

  if (!Array.isArray(pois) || pois.length === 0) {
    console.log('POI: no POI array found in response')
    return null
  }

  const items: POIItem[] = pois.slice(0, 50).map((p: AttomRawResponse) => {
    const biz = p?.businessLocation ?? {}
    const cat = p?.category ?? {}
    const det = p?.details ?? {}
    return {
      name: biz.businessStandardName ?? det.businessShortName ?? 'Unknown',
      // Use condensedHeading for a cleaner category name, fallback to category
      category: cat.condensedHeading ?? cat.category ?? null,
      address: biz.address ?? null,
      distance: parseNum(det.distance),
      latitude: parseNum(det.latitude),
      longitude: parseNum(det.longitude),
    }
  })

  // Build category summary using the broader "category" field for grouping
  const summary: Record<string, number> = {}
  for (const p of pois) {
    const cat = p?.category ?? {}
    const key = cat.condensedHeading ?? cat.category ?? null
    if (key) {
      summary[key] = (summary[key] ?? 0) + 1
    }
  }

  return { items, summary }
}

// ─── Service ─────────────────────────────────────────────────────────────────

export class NeighbourhoodService {
  private apiKey: string

  constructor(apiKey: string) {
    this.apiKey = apiKey
  }

  async getNeighbourhoodData(
    latitude: number,
    longitude: number,
    address?: string
  ): Promise<NeighbourhoodData> {
    if (!this.apiKey) {
      console.log('NeighbourhoodService: No ATTOM API key configured')
      return { geoIdV4: null, community: null, schools: null, poi: null }
    }

    console.log(`NeighbourhoodService: Fetching data for lat=${latitude}, lng=${longitude}, address=${address}`)

    // Step 1: Get geoIdV4 from coordinates via hierarchy lookup
    let geoIdV4: string | null = null
    try {
      const wkt = `POINT(${longitude} ${latitude})`
      const url = `${BASE_URL}/v4/area/hierarchy/lookup?WKTString=${encodeURIComponent(wkt)}`
      const data = await attomV4Fetch(this.apiKey, url)
      geoIdV4 = parseHierarchyResponse(data)
      console.log(`NeighbourhoodService: geoIdV4 resolved to: ${geoIdV4}`)
    } catch (error) {
      console.log('NeighbourhoodService: Hierarchy lookup failed:', error instanceof Error ? error.message : error)
    }

    // Step 2: Parallel fetch — community (needs geoIdV4), schools, and POI
    const [community, schools, poi] = await Promise.all([
      this.fetchCommunity(geoIdV4),
      this.fetchSchools(latitude, longitude),
      this.fetchPOI(latitude, longitude, address),
    ])

    console.log('NeighbourhoodService: Results - community:', !!community, 'schools:', !!schools, 'poi:', !!poi)

    return { geoIdV4, community, schools, poi }
  }

  private async fetchCommunity(geoIdV4: string | null): Promise<CommunityData | null> {
    if (!geoIdV4) {
      console.log('NeighbourhoodService: Skipping community fetch — no geoIdV4')
      return null
    }
    try {
      const url = `${BASE_URL}/v4/neighborhood/community?geoIdv4=${encodeURIComponent(geoIdV4)}`
      const data = await attomV4Fetch(this.apiKey, url)
      return parseCommunityResponse(data)
    } catch (error) {
      console.log('NeighbourhoodService: Community fetch failed:', error instanceof Error ? error.message : error)
      return null
    }
  }

  private async fetchSchools(latitude: number, longitude: number): Promise<SchoolData | null> {
    try {
      const url = `${BASE_URL}/v4/school/search?latitude=${latitude}&longitude=${longitude}&radius=3&pageSize=20`
      const data = await attomV4Fetch(this.apiKey, url)
      return parseSchoolsResponse(data)
    } catch (error) {
      console.log('NeighbourhoodService: Schools fetch failed:', error instanceof Error ? error.message : error)
      return null
    }
  }

  private async fetchPOI(latitude: number, longitude: number, address?: string): Promise<POIData | null> {
    try {
      // Use lat/lng point param (more reliable than address which may not match ATTOM's parser)
      const point = `POINT(${longitude},${latitude})`
      const url = `${BASE_URL}/v4/neighborhood/poi?point=${encodeURIComponent(point)}&radius=3&pageSize=50`
      const data = await attomV4Fetch(this.apiKey, url)
      return parsePOIResponse(data)
    } catch (error) {
      console.log('NeighbourhoodService: POI fetch failed:', error instanceof Error ? error.message : error)
      return null
    }
  }
}

export function createNeighbourhoodService(apiKey: string): NeighbourhoodService {
  return new NeighbourhoodService(apiKey)
}
