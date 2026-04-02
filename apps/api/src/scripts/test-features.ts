/**
 * Test script: Check pool, garage, carport data from CoreLogic
 *
 * Usage: npx tsx apps/api/src/scripts/test-features.ts
 *
 * Tests property features (pool, garage, carport) for:
 *   4502 E 12TH AVE, TAMPA, FL 33605
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
const BASE_URL = 'https://property.corelogicapi.com'

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
  const url = new URL(`${BASE_URL}/v2/properties/search`)
  url.searchParams.set('streetAddress', address)
  url.searchParams.set('city', city)
  url.searchParams.set('state', state)
  url.searchParams.set('zipCode', zip)
  url.searchParams.set('bestMatch', 'true')

  const resp = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  })
  if (!resp.ok && resp.status !== 404) throw new Error(`Search failed: ${resp.status} ${await resp.text()}`)
  if (resp.status === 404) return { properties: [] } as { properties?: Array<{ clipId?: string; clip?: string; [k: string]: unknown }> }
  const result = await resp.json() as Record<string, unknown>
  console.log('Search response keys:', Object.keys(result))
  if (!result.properties) console.log('Raw response:', JSON.stringify(result).slice(0, 500))
  return result as { properties?: Array<{ clipId?: string; clip?: string; [k: string]: unknown }> }
}

async function getPropertyDetail(token: string, clipId: string) {
  const resp = await fetch(`${BASE_URL}/v2/properties/${clipId}/property-detail`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  })
  if (!resp.ok) throw new Error(`Detail failed: ${resp.status} ${await resp.text()}`)
  return await resp.json() as Record<string, unknown>
}

async function getComparables(token: string, clipId: string) {
  const url = new URL(`${BASE_URL}/v2/properties/${clipId}/comparables`)
  url.searchParams.set('radiusMiles', '1')
  url.searchParams.set('maxComps', '10')
  url.searchParams.set('monthsBack', '12')

  const resp = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  })
  if (!resp.ok) throw new Error(`Comps failed: ${resp.status} ${await resp.text()}`)
  return await resp.json() as { comparables?: Array<{ clipId?: string; clip?: string; streetAddress?: string; [k: string]: unknown }> }
}

function extractFeatures(data: Record<string, unknown>, verbose = false): Record<string, unknown> {
  // CoreLogic property-detail response has nested structure
  const buildings = data.buildings as { data?: Array<Record<string, unknown>> } | undefined
  const buildingData = buildings?.data?.[0]
  const summary = buildingData?.summary as Record<string, unknown> | undefined
  const structureData = data.structure as { data?: Record<string, unknown> } | undefined
  const structureExterior = (structureData?.data?.exterior ?? structureData?.exterior) as Record<string, unknown> | undefined

  // Also check top-level building fields (v1-style response)
  const building = data.building as Record<string, unknown> | undefined

  const pool = structureExterior?.pool as Record<string, unknown> | undefined
  const parking = structureExterior?.parking as Record<string, unknown> | undefined

  if (verbose) {
    console.log('  [raw] buildings.data[0].summary:', summary ? JSON.stringify(summary).slice(0, 300) : 'null')
    console.log('  [raw] structure.exterior.pool:', pool ? JSON.stringify(pool) : 'null')
    console.log('  [raw] structure.exterior.parking:', parking ? JSON.stringify(parking) : 'null')
    console.log('  [raw] building (top-level):', building ? JSON.stringify({
      poolType: building.poolType, garageType: building.garageType,
      garageSquareFeet: building.garageSquareFeet, parkingSpaces: building.parkingSpaces,
      carportType: building.carportType,
    }) : 'null')
  }

  return {
    poolType: pool?.typeCode ?? summary?.poolTypeCode ?? building?.poolType ?? null,
    garageType: parking?.garageTypeCode ?? summary?.garageTypeCode ?? building?.garageType ?? null,
    garageSquareFeet: parking?.garageAreaSquareFeet ?? summary?.garageSquareFeet ?? building?.garageSquareFeet ?? null,
    parkingSpaces: parking?.parkingSpacesCount ?? summary?.parkingSpaces ?? building?.parkingSpaces ?? null,
    carportType: summary?.carportTypeCode ?? building?.carportType ?? null,
  }
}

async function main() {
  console.log('=== CoreLogic Feature Test ===\n')
  const addresses = [
    { street: '5012 W DICKENS AVE', city: 'TAMPA', state: 'FL', zip: '33629' },
    { street: '3216 DELRAY DR', city: 'TAMPA', state: 'FL', zip: '33619' },
    { street: '4207 W EMPEDRADO ST', city: 'TAMPA', state: 'FL', zip: '33629' },
  ]

  const token = await getToken()
  console.log('✓ Authenticated\n')

  for (const addr of addresses) {
    console.log(`\n${'='.repeat(60)}`)
    console.log(`Address: ${addr.street}, ${addr.city}, ${addr.state} ${addr.zip}`)
    console.log('='.repeat(60))

  const searchResult = await searchProperty(token, addr.street, addr.city, addr.state, addr.zip)
  const items = (searchResult as unknown as { items?: Array<Record<string, unknown>> }).items ?? searchResult.properties ?? []
  const subject = items[0]
  if (!subject) {
    console.log('✗ Property not found')
    continue
  }
  const clipId = (subject.clipId || subject.clip) as string
  console.log(`CLIP: ${clipId}`)

  // Get subject detail
  const subjectDetail = await getPropertyDetail(token, clipId)
  console.log('  [raw] Detail response keys:', Object.keys(subjectDetail))
  // Dump buildings data to find pool/garage fields
  const bd = subjectDetail.buildings as Record<string, unknown> | undefined
  const bdData = bd?.data as Record<string, unknown> | undefined
  if (bdData) {
    console.log('  [raw] buildings.data keys:', Object.keys(bdData))
    // Check for buildings array (capital or lowercase B)
    const bldgArr = (bdData.Buildings || bdData.buildings) as Array<Record<string, unknown>> | undefined
    console.log('  [raw] buildings array found:', bldgArr ? `${bldgArr.length} buildings` : 'null (tried Buildings and buildings)')
    const allBldg = bdData.allBuildingsSummary as Record<string, unknown> | undefined
    if (allBldg) {
      // Look for pool/garage/carport/parking in the summary
      const relevant = Object.entries(allBldg).filter(([k]) =>
        /pool|garage|carport|parking/i.test(k)
      )
      console.log('  [raw] allBuildingsSummary pool/garage/parking fields:', relevant.length > 0 ? relevant : 'NONE')
    }
    const bldgs = bdData.buildings as Array<Record<string, unknown>> | undefined
    if (bldgs?.[0]) {
      const b0 = bldgs[0]
      console.log('  [raw] buildings.data.buildings[0] keys:', Object.keys(b0))
      const summary = b0.summary as Record<string, unknown> | undefined
      if (summary) {
        const relevant = Object.entries(summary).filter(([k]) =>
          /pool|garage|carport|parking/i.test(k)
        )
        console.log('  [raw] buildings[0].summary pool/garage/parking:', relevant.length > 0 ? relevant : 'NONE')
      }
      const exterior = (b0.structureExterior ?? b0.exterior) as Record<string, unknown> | undefined
      if (exterior) {
        console.log('  [raw] structureExterior keys:', Object.keys(exterior))
        console.log('  [raw] structureExterior.pool:', JSON.stringify(exterior.pool) ?? 'null')
        console.log('  [raw] structureExterior.parking:', JSON.stringify(exterior.parking) ?? 'null')
      } else {
        console.log('  [raw] structureExterior: null')
      }
    }
  }
  const subjectFeatures = extractFeatures(subjectDetail, true)
  console.log('Features:')
  console.log(JSON.stringify(subjectFeatures, null, 2))
  console.log()

  // Get comps
  console.log('--- Comparables ---')
  const compsResult = await getComparables(token, clipId)
  const comps = compsResult.comparables ?? []
  console.log(`Found ${comps.length} comps\n`)

  // Check first 5 comps for features
  for (let i = 0; i < Math.min(5, comps.length); i++) {
    const comp = comps[i]
    const compId = comp.clipId || comp.clip
    console.log(`Comp ${i + 1}: ${comp.streetAddress} (${compId})`)

    if (compId) {
      try {
        const compDetail = await getPropertyDetail(token, compId as string)
        const compFeatures = extractFeatures(compDetail)
        console.log('  Features:', JSON.stringify(compFeatures))
      } catch (e) {
        console.log(`  ✗ Could not fetch detail: ${(e as Error).message}`)
      }
    }
    console.log()
  }

  } // end address loop

  console.log('\n=== Done ===')
}

main().catch(console.error)
