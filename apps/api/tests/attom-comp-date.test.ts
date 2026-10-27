/**
 * ATTOM find_comparable_sales dropped `saleDate` (seen 2026-10-26: records
 * carry only `recordedDate`). A comp without a date fails every recency
 * check — the whole pool reads "sale age unverified".
 */
import assert from 'node:assert/strict'
import { normalizeMcpComp } from '../src/services/property-api/providers/attom-mcp'

const base = { attomId: '1', address: '7361 Watersilk Dr N, Pinellas Park, FL 33782', salePrice: 1_186_000, squareFootage: 3787 }
assert.equal(normalizeMcpComp({ ...base, recordedDate: '2026-06-12T00:00:00' }).saleDate, '2026-06-12', 'recorded date fills a missing sale date')
assert.equal(normalizeMcpComp({ ...base, saleDate: '2026-06-01', recordedDate: '2026-06-12T00:00:00' }).saleDate, '2026-06-01', 'a real sale date wins')
assert.equal(normalizeMcpComp(base).saleDate, null)

console.log('attom comp date: passed')
