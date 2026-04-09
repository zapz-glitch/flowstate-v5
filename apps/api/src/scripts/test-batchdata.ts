/**
 * Test script: BatchData Property Lookup
 *
 * Usage: npx tsx apps/api/src/scripts/test-batchdata.ts
 *
 * Tests the BatchData API for property details including
 * building condition, quality, AVM, listing data, flip data, distress flags.
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

const API_KEY = env.BATCH_DATA_API_KEY
if (!API_KEY) throw new Error('Missing BATCH_DATA_API_KEY in .dev.vars')

const BASE_URL = 'https://api.batchdata.com/api/v1'

const HEADERS = {
  'Content-Type': 'application/json',
  'Authorization': `Bearer ${API_KEY}`,
}

async function lookupProperty(street: string, city: string, state: string, zip: string) {
  const resp = await fetch(`${BASE_URL}/property/lookup`, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({
      requests: [{
        address: { street, city, state, zip },
      }],
    }),
  })

  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(`BatchData API error: ${resp.status} ${text}`)
  }

  return await resp.json() as Record<string, unknown>
}

function printSection(label: string, data: unknown) {
  if (!data || (typeof data === 'object' && Object.keys(data as Record<string, unknown>).length === 0)) return
  console.log(`\n── ${label} ──`)
  console.log(JSON.stringify(data, null, 2))
}

// ─── Comp Search ───────────────────────────────────────────────────────────

async function searchComps(street: string, city: string, state: string, zip: string) {
  const resp = await fetch(`${BASE_URL}/property/search`, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({
      searchCriteria: {
        compAddress: {
          street,
          city,
          state,
          zip,
        },
      },
      options: {
        useDistance: true,
        distanceMiles: 1,
        useBedrooms: true,
        minBedrooms: 2,
        maxBedrooms: 5,
        useBathrooms: true,
        minBathrooms: 1,
        maxBathrooms: 4,
        useArea: true,
        minAreaPercent: 75,
        maxAreaPercent: 125,
        useYearBuilt: true,
        minYearBuilt: 1950,
        maxYearBuilt: 2025,
        take: 15,
      },
    }),
  })

  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(`BatchData Comp Search error: ${resp.status} ${text}`)
  }

  return await resp.json() as Record<string, unknown>
}

async function main() {
  const addr = { street: '4207 W EMPEDRADO ST', city: 'TAMPA', state: 'FL', zip: '33629' }

  // ── Test 1: Property Lookup ──────────────────────────────────────────────
  console.log(`\n${'='.repeat(70)}`)
  console.log(`PROPERTY LOOKUP: ${addr.street}, ${addr.city}, ${addr.state} ${addr.zip}`)
  console.log('='.repeat(70))

  try {
    const result = await lookupProperty(addr.street, addr.city, addr.state, addr.zip)

    const results = (result as { results?: { properties?: unknown[] } }).results
    const properties = (results as { properties?: unknown[] })?.properties
    const property = (properties as Record<string, unknown>[])?.[0] as Record<string, unknown> | undefined

    if (!property) {
      console.log('Response keys:', Object.keys(result))
      console.log('Raw response (first 500 chars):', JSON.stringify(result).slice(0, 500))
    } else {
      printSection('BUILDING', property.building)
      printSection('ASSESSMENT', property.assessment)
      printSection('VALUATION (AVM)', property.valuation)
      printSection('SALE', property.sale)
      printSection('LOT', property.lot)
      printSection('QUICK LISTS', property.quickLists)

      const building = property.building as Record<string, unknown> | undefined
      const valuation = property.valuation as Record<string, unknown> | undefined
      const sale = property.sale as Record<string, unknown> | undefined

      console.log('\n── KEY FIELDS ──')
      console.log('Building Condition:', building?.buildingCondition ?? 'N/A')
      console.log('Building Quality:', building?.buildingQuality ?? 'N/A')
      console.log('Pool:', building?.pool ?? 'N/A')
      console.log('Garage:', building?.garage ?? 'N/A')
      console.log('AVM Value:', valuation?.estimatedValue ?? 'N/A')
      console.log('AVM Confidence:', valuation?.confidenceScore ?? 'N/A')
      console.log('Flip Profit:', (sale as Record<string, unknown>)?.flipProfit ?? 'N/A')
    }
  } catch (e) {
    console.error('Lookup Error:', (e as Error).message)
  }

  // ── Test 2: Comparable Search ────────────────────────────────────────────
  console.log(`\n${'='.repeat(70)}`)
  console.log(`COMP SEARCH: ${addr.street}, ${addr.city}, ${addr.state} ${addr.zip}`)
  console.log('='.repeat(70))

  try {
    const result = await searchComps(addr.street, addr.city, addr.state, addr.zip)

    const results = result.results as { properties?: Record<string, unknown>[] } | undefined
    const comps = results?.properties

    if (!comps || comps.length === 0) {
      console.log('No comps found.')
      console.log('Raw response:', JSON.stringify(result).slice(0, 1000))
    } else {
      console.log(`\n📊 Found ${comps.length} comparable properties:\n`)
      for (let i = 0; i < comps.length; i++) {
        const p = comps[i]
        const address = p.address as Record<string, unknown> | undefined
        const building = p.building as Record<string, unknown> | undefined
        const sale = p.sale as Record<string, unknown> | undefined
        const location = p.location as Record<string, unknown> | undefined

        const addr = address?.formattedAddress || `${address?.street}, ${address?.city}, ${address?.state}`
        const price = sale?.salePrice ? `$${(sale.salePrice as number).toLocaleString()}` : 'N/A'
        const sqft = building?.livingArea || '?'
        const beds = building?.bedrooms || '?'
        const baths = building?.bathrooms || '?'
        const year = building?.yearBuilt || '?'
        const dist = location?.distance ? `${(location.distance as number).toFixed(2)} mi` : 'N/A'

        console.log(`  ${i + 1}. ${addr}`)
        console.log(`     ${price} | ${sqft} sqft | ${beds}bd/${baths}ba | Year: ${year} | ${dist}`)
      }
    }
  } catch (e) {
    console.error('Comp Search Error:', (e as Error).message)
  }

  console.log('\n=== Done ===')
}

main().catch(console.error)
