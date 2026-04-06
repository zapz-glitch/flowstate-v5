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

async function lookupProperty(street: string, city: string, state: string, zip: string) {
  const resp = await fetch(`${BASE_URL}/property/lookup`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': API_KEY,
    },
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

async function main() {
  const addresses = [
    { street: '4207 W EMPEDRADO ST', city: 'TAMPA', state: 'FL', zip: '33629' },
    { street: '4206 W PALMIRA AVE', city: 'TAMPA', state: 'FL', zip: '33629' },
  ]

  for (const addr of addresses) {
    console.log(`\n${'='.repeat(70)}`)
    console.log(`${addr.street}, ${addr.city}, ${addr.state} ${addr.zip}`)
    console.log('='.repeat(70))

    try {
      const result = await lookupProperty(addr.street, addr.city, addr.state, addr.zip)

      // Extract the property data from response
      const results = (result as { results?: { properties?: unknown[] } }).results
      const properties = (results as { properties?: unknown[] })?.properties
      const property = (properties as Record<string, unknown>[])?.[0] as Record<string, unknown> | undefined

      if (!property) {
        console.log('Response keys:', Object.keys(result))
        console.log('Raw response (first 500 chars):', JSON.stringify(result).slice(0, 500))
        continue
      }

      // Print key sections
      printSection('BUILDING', property.building)
      printSection('ASSESSMENT', property.assessment)
      printSection('VALUATION (AVM)', property.valuation)
      printSection('SALE', property.sale)
      printSection('LOT', property.lot)
      printSection('OWNER', property.owner)
      printSection('LEGAL', property.legal)
      printSection('LISTING', property.listing)
      printSection('FORECLOSURE', property.foreclosure)
      printSection('OPEN LIENS', property.openLien)
      printSection('PERMITS', property.permit)
      printSection('QUICK LISTS', property.quickLists)
      printSection('GENERAL', property.general)

      // Highlight the most valuable fields
      const building = property.building as Record<string, unknown> | undefined
      const valuation = property.valuation as Record<string, unknown> | undefined
      const sale = property.sale as Record<string, unknown> | undefined
      const quickLists = property.quickLists as Record<string, unknown> | undefined

      console.log('\n── KEY VALUATION FIELDS ──')
      console.log('Building Condition:', building?.buildingCondition ?? 'N/A')
      console.log('Building Quality:', building?.buildingQuality ?? 'N/A')
      console.log('Effective Year Built:', building?.effectiveYearBuilt ?? 'N/A')
      console.log('Pool:', building?.pool ?? 'N/A')
      console.log('Garage:', building?.garage ?? 'N/A')
      console.log('AVM Value:', valuation?.estimatedValue ?? 'N/A')
      console.log('AVM Confidence:', valuation?.confidenceScore ?? 'N/A')
      console.log('Flip Profit:', (sale as Record<string, unknown>)?.flipProfit ?? 'N/A')
      console.log('Flip Length:', (sale as Record<string, unknown>)?.flipLength ?? 'N/A')
      console.log('Fix & Flip:', quickLists?.fixAndFlip ?? 'N/A')
      console.log('Corporate Owned:', quickLists?.corporateOwned ?? 'N/A')
      console.log('Vacant:', quickLists?.vacant ?? 'N/A')
      console.log('Pre-foreclosure:', quickLists?.preforeclosure ?? 'N/A')
    } catch (e) {
      console.error('Error:', (e as Error).message)
    }
  }

  console.log('\n=== Done ===')
}

main().catch(console.error)
