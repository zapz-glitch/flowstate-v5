/**
 * Subject by provider id — /v1/analyze accepts propertyId, but the job
 * only searched by address, so a zip-less address ATTOM's matcher misses
 * (3209 Amalfi Cir SW, 2649 Janice Dr, 2877 Motts Cove Dr — verified
 * flips, 2026-10-28) failed even with its attomId in hand.
 */
import assert from 'node:assert/strict'
import { createAttomMcpProvider } from '../src/services/property-api/providers/attom-mcp'

const provider = createAttomMcpProvider({} as never) as unknown as {
  propertyData: (lookup: Record<string, unknown>, datasets: string[]) => Promise<unknown[]>
  searchProperty: (p: Record<string, unknown>) => Promise<{ success: boolean; data?: { id: string } }>
}
const lookups: { lookup: Record<string, unknown>; datasets: string[] }[] = []
provider.propertyData = async (lookup, datasets) => {
  lookups.push({ lookup, datasets })
  if (lookup.lookupMode !== 'attomId') return [] // the address matcher misses
  return [{ dataset: 'identity', data: { attomId: 171550568, address: { oneLine: '3209 AMALFI CIR SW, ATLANTA, GA 30311' } } }]
}

const r = await provider.searchProperty({ address: '3209 Amalfi Cir Sw, Atlanta, GA', propertyId: '171550568' })
assert.equal(r.success, true)
assert.equal(r.data?.id, '171550568')
assert.deepEqual(lookups[0].lookup, { lookupMode: 'attomId', attomId: '171550568' }, 'id goes first')
assert.ok(lookups[0].datasets.includes('valuation') && lookups[0].datasets.includes('permits'), 'subject datasets, not comp detail')

// Without an id the address path is unchanged.
lookups.length = 0
const miss = await provider.searchProperty({ address: '3209 Amalfi Cir Sw, Atlanta, GA' })
assert.equal(miss.success, false)
assert.ok(lookups.every((l) => l.lookup.lookupMode === 'address'))

console.log('subject by provider id: passed')
