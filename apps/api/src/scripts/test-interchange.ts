/**
 * Test script: CoreLogic InterChange API
 *
 * Usage: npx tsx apps/api/src/scripts/test-interchange.ts
 *
 * Tests the InterChange API for building style, foundation, and construction data
 * for address: 3216 Delray Dr, Tampa, FL 33619
 */

import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Load .dev.vars
const devVars = readFileSync(resolve(__dirname, '../../.dev.vars'), 'utf-8')
const env: Record<string, string> = {}
for (const line of devVars.split('\n')) {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith('#')) continue
  const eqIdx = trimmed.indexOf('=')
  if (eqIdx > 0) {
    env[trimmed.substring(0, eqIdx)] = trimmed.substring(eqIdx + 1)
  }
}

const TOKEN_URL = 'https://prod.corelogicapi.com/oauth/token'
const INTERCHANGE_BASE = 'https://prod.corelogicapi.com'

async function getToken(): Promise<string> {
  const clientId = env.CORELOGIC_CLIENT_ID
  const clientSecret = env.CORELOGIC_CLIENT_SECRET
  if (!clientId || !clientSecret) throw new Error('Missing CORELOGIC_CLIENT_ID or CORELOGIC_CLIENT_SECRET')

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64')
  const resp = await fetch(`${TOKEN_URL}?grant_type=client_credentials`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${credentials}`,
    },
  })
  if (!resp.ok) throw new Error(`Auth failed: ${resp.status} ${await resp.text()}`)
  const data = await resp.json() as { access_token: string }
  return data.access_token
}

async function searchProperty(token: string, address: string, city: string, state: string, zip: string) {
  const url = new URL(`${INTERCHANGE_BASE}/interchange/properties/search`)
  url.searchParams.set('streetAddress', address)
  url.searchParams.set('city', city)
  url.searchParams.set('state', state)
  url.searchParams.set('zipCode', zip)

  console.log(`\n--- Searching: ${address}, ${city}, ${state} ${zip} ---`)
  console.log(`URL: ${url.toString()}`)

  const resp = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  })

  if (!resp.ok) {
    console.error(`Search failed: ${resp.status}`)
    console.error(await resp.text())
    return null
  }

  const data = await resp.json()
  console.log('\nSearch result:')
  console.log(JSON.stringify(data, null, 2))
  return data
}

async function getInterchangeData(token: string, clip: string) {
  const url = `${INTERCHANGE_BASE}/interchange/${clip}/interchange-enriched`
  console.log(`\n--- Fetching InterChange data for CLIP: ${clip} ---`)
  console.log(`URL: ${url}`)

  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  })

  if (!resp.ok) {
    console.error(`InterChange failed: ${resp.status}`)
    console.error(await resp.text())
    return null
  }

  const data = await resp.json()
  console.log('\nInterChange result:')
  console.log(JSON.stringify(data, null, 2))
  return data
}

async function getPropertyDetail(token: string, clip: string) {
  const url = `https://property.corelogicapi.com/v2/properties/${clip}/property-detail`
  console.log(`\n--- Fetching property detail for CLIP: ${clip} ---`)

  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  })

  if (!resp.ok) {
    console.error(`Property detail failed: ${resp.status}`)
    console.error(await resp.text())
    return null
  }

  return await resp.json()
}

async function searchPropertyV2(token: string, address: string, city: string, state: string, zip: string) {
  const url = new URL('https://property.corelogicapi.com/v2/properties/search')
  url.searchParams.set('streetAddress', address)
  url.searchParams.set('city', city)
  url.searchParams.set('state', state)
  url.searchParams.set('zipCode', zip)

  console.log(`\n--- V2 Search: ${address}, ${city}, ${state} ${zip} ---`)

  const resp = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  })

  if (!resp.ok) {
    console.error(`V2 Search failed: ${resp.status}`)
    console.error(await resp.text())
    return null
  }

  return await resp.json()
}

async function main() {
  console.log('=== CoreLogic Building Data Test ===\n')

  const token = await getToken()
  console.log('Auth: OK')

  // Step 1: Search via V2 to get CLIP
  const v2Result = await searchPropertyV2(token, '3216 Delray Dr', 'Tampa', 'FL', '33619') as { items?: Array<{ clip?: string }> } | null

  const clip = v2Result?.items?.[0]?.clip
  if (!clip) {
    console.error('\nNo CLIP found from V2 search')
    console.log('V2 result:', JSON.stringify(v2Result, null, 2).substring(0, 1000))
    return
  }
  console.log(`\nFound CLIP: ${clip}`)

  // Step 2: Fetch property detail (standard API — already integrated)
  const detail = await getPropertyDetail(token, clip) as Record<string, unknown> | null
  if (detail) {
    const buildingsWrapper = detail.buildings as Record<string, unknown> | undefined
    const buildingsData = buildingsWrapper?.data as Record<string, unknown> | undefined
    const buildingsList = (buildingsData?.buildings as unknown[]) ?? []
    const building = buildingsList[0] as Record<string, unknown> | undefined

    if (building) {
      const constructionDetails = building.constructionDetails as Record<string, unknown> | undefined
      const structureExterior = building.structureExterior as Record<string, unknown> | undefined
      const structureFeatures = building.structureFeatures as Record<string, unknown> | undefined

      // Import code lookup
      const { lookupCode, BUILDING_STYLE, CONSTRUCTION_TYPE, FOUNDATION_TYPE, ROOF_TYPE, EXTERIOR_WALLS, GARAGE_TYPE, HEATING_TYPE, COOLING_TYPE, BUILDING_QUALITY } = await import('../services/property-api/providers/corelogic-codes')

      const fmt = (table: Record<string, string>, code: string | null | undefined) => {
        if (!code) return 'N/A'
        const label = lookupCode(table, code)
        return label !== code ? `${label} (${code})` : code
      }

      console.log('\n=== Building Data (with labels) ===')
      console.log(`Building Style: ${fmt(BUILDING_STYLE, constructionDetails?.buildingStyleTypeCode as string)}`)
      console.log(`Foundation:     ${fmt(FOUNDATION_TYPE, constructionDetails?.foundationTypeCode as string)}`)
      console.log(`Construction:   ${fmt(CONSTRUCTION_TYPE, constructionDetails?.constructionTypeCode as string)}`)
      console.log(`Quality:        ${fmt(BUILDING_QUALITY, constructionDetails?.buildingQualityTypeCode as string)}`)
      console.log(`Year Built:     ${constructionDetails?.yearBuilt ?? 'N/A'} (effective: ${constructionDetails?.effectiveYearBuilt ?? 'N/A'})`)
      console.log(`Roof Type:      ${fmt(ROOF_TYPE, (structureExterior?.roof as Record<string, unknown>)?.typeCode as string)}`)
      console.log(`Exterior Walls: ${fmt(EXTERIOR_WALLS, (structureExterior?.walls as Record<string, unknown>)?.typeCode as string)}`)
      console.log(`Garage:         ${fmt(GARAGE_TYPE, (structureExterior?.parking as Record<string, unknown>)?.garageTypeCode as string)}`)
      console.log(`Heating:        ${fmt(HEATING_TYPE, (structureFeatures?.heating as Record<string, unknown>)?.typeCode as string)}`)
      console.log(`Cooling:        ${fmt(COOLING_TYPE, (structureFeatures?.airConditioning as Record<string, unknown>)?.typeCode as string)}`)
    } else {
      console.log('\nNo building data in response')
      console.log('Detail sample:', JSON.stringify(detail, null, 2).substring(0, 2000))
    }
  }

  // Step 3: Try InterChange (may fail with 403)
  console.log('\n--- Trying InterChange API (may require entitlement) ---')
  const interchangeData = await getInterchangeData(token, clip)

  if (interchangeData) {
    console.log('\n=== Summary ===')
    const chars = interchangeData.characteristics
    const construction = interchangeData.construction
    const components = interchangeData.components

    console.log(`Confidence Rank: ${interchangeData.confidenceRank}/5`)
    console.log(`\nCharacteristics:`)
    console.log(`  Living Area: ${chars?.livingArea?.value} sqft (confidence: ${chars?.livingArea?.confidenceRank}/5, modeled: ${chars?.livingArea?.modeled})`)
    console.log(`  Stories: ${chars?.numberOfStories?.value} (confidence: ${chars?.numberOfStories?.confidenceRank}/5)`)
    console.log(`  Year Built: ${chars?.yearBuilt?.value} (confidence: ${chars?.yearBuilt?.confidenceRank}/5)`)

    console.log(`\nBuilding Style:`)
    console.log(`  Code: ${construction?.buildingStyleCode?.value}`)
    console.log(`  Description: ${construction?.buildingStyleCode?.description}`)
    console.log(`  Confidence: ${construction?.buildingStyleCode?.confidenceRank}/5`)
    console.log(`  Modeled: ${construction?.buildingStyleCode?.modeled}`)

    console.log(`\nComponents:`)
    const logComponents = (label: string, comp: { components?: Array<{ description: string; value: string }> }) => {
      if (comp?.components?.length) {
        console.log(`  ${label}: ${comp.components.map((c: { description: string; value: string }) => `${c.description} (${c.value})`).join(', ')}`)
      } else {
        console.log(`  ${label}: N/A`)
      }
    }

    logComponents('Foundation Type', components?.foundationTypeComponents)
    logComponents('Foundation Material', components?.foundationMaterialComponents)
    logComponents('Construction Material', components?.constructionMaterialComponents)
    logComponents('Exterior Wall', components?.exteriorWallMaterialComponents)
    logComponents('Roof Material', components?.roofMaterialComponents)
    logComponents('Roof Shape', components?.roofShapeComponents)
    logComponents('Heating', components?.heatingTypeComponents)
    logComponents('A/C', components?.airConditioningComponents)
    logComponents('Garage', components?.garageTypeComponents)
    logComponents('Pool', components?.poolTypeComponents)
    logComponents('Fireplace', components?.fireplaceTypeComponents)
    logComponents('Full Bath', components?.fullBathroomComponents)
    logComponents('Half Bath', components?.halfBathroomComponents)
  }
}

main().catch(console.error)
