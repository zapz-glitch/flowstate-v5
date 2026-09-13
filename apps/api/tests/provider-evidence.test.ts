import assert from 'node:assert/strict'
import { createCoreLogicProvider, normalizeBuildingPermits } from '../src/services/property-api/providers/corelogic'
import { floodZoneKey, permitsKey } from '../src/services/cache'
import type { Env } from '../src/types'

const fixture = { items: [{ clip: 'test', permit: { id: 'p1', number: 'roof1', buildingPermitStatus: [{ status: 'Issued', effectiveDate: '2020-01-02' }, { status: 'Completed', effectiveDate: '2020-04-03' }], areaSquareFeet: 1200 }, project: { type: 'Roofing', subType: 'Replacement', description: 'Replace entire roof', jobValue: 12000, buildingPermitClassifications: [{ projectType: 'Roof replacement', projectTypeCategory: 'Roofing' }] }, contractors: [{ businessName: 'Fixture Contractor' }] }] }
const [permit] = normalizeBuildingPermits(fixture)
assert.equal(permit.permitId, 'p1')
assert.equal(permit.status, 'Completed')
assert.equal(permit.effectiveDate, '2020-04-03')
assert.equal(permit.statusHistory?.length, 2)
assert.equal(permit.jobValue, 12000)
assert.equal(permit.source, 'corelogic:building-permits')
assert.deepEqual(permit.raw, fixture.items[0])
assert.deepEqual(normalizeBuildingPermits({ items: [] }), [])
assert.throws(() => normalizeBuildingPermits({}), /INVALID_RESPONSE/)
assert.match(permitsKey('test', 'corelogic'), /evidence-v2/)
assert.match(floodZoneKey('test', 'corelogic'), /evidence-v2/)
const originalFetch = globalThis.fetch
let payload: unknown = fixture
let status = 200
const paths: string[] = []
globalThis.fetch = async (input, options) => {
  if (options?.method === 'POST') return Response.json({ access_token: 'fixture-token', expires_in: 3600 })
  paths.push(new URL(String(input)).pathname)
  return Response.json(payload, { status })
}
try {
  const provider = createCoreLogicProvider({ CORELOGIC_CLIENT_ID: 'fixture', CORELOGIC_CLIENT_SECRET: 'fixture' } as Env)
  assert.equal((await provider.getBuildingPermits('test')).success, true)
  assert.equal(paths[0], '/v2/properties/test/building-permits')
  payload = { message: 'not have proper entitlements' }; status = 403
  const denied = await provider.getBuildingPermits('test')
  assert.equal(denied.success, false)
  assert.equal(!denied.success && denied.code, 'ENTITLEMENTS_ERROR')
  assert.equal((await provider.getFloodZone(27, -82)).success, false)
  status = 404; payload = {}
  assert.equal((await provider.getBuildingPermits('test')).success, false)
  status = 200
  assert.equal((await provider.getFloodZone(27, -82)).success, false)
  for (const floodZone of [' ', 'unknown', 'D', 7]) {
    payload = { floodZone }
    assert.equal((await provider.getFloodZone(27, -82)).success, false)
  }
  payload = { floodZone: ' ae ' }
  const flood = await provider.getFloodZone(27, -82)
  assert.equal(flood.success && flood.data.isInFloodZone, true)
  assert.equal(flood.success && flood.data.source, 'spatial')
  payload = { items: [] }
  const empty = await provider.getBuildingPermits('test')
  assert.equal(empty.success && empty.data.count, 0)

  // Parcel-level flood-zone: GET /property/{fipsCode:universalParcelId}/flood-zone
  payload = {
    corelogicPropertyId: '48029:36205502',
    compositePropertyId: '48029:36205502',
    floodZoneCode: 'X',
    panelNumber: '48029C0260G',
    panelDate: '20100929',
    specialFloodHazardArea: 'Out',
    floodZoneDescription: ' Zone X-An area that is determined to be outside the 100- and 500-year floodplains.',
    communityName: 'SAN ANTONIO',
    multipleFloodZoneProximity: 'No',
    communityNumber: '480045',
  }
  const parcelFlood = await provider.getFloodZoneByParcel!('48029:36205502')
  assert.equal(paths.at(-1), '/property/48029%3A36205502/flood-zone')
  assert.equal(parcelFlood.success, true)
  if (parcelFlood.success) {
    assert.equal(parcelFlood.data.floodZone, 'X')
    assert.equal(parcelFlood.data.isInFloodZone, false)
    assert.equal(parcelFlood.data.isNearFloodZone, false)
    assert.equal(parcelFlood.data.specialFloodHazardArea, 'Out')
    assert.equal(parcelFlood.data.mapPanel, '48029C0260G')
    assert.equal(parcelFlood.data.mapDate, '2010-09-29')
    assert.equal(parcelFlood.data.communityName, 'SAN ANTONIO')
    assert.equal(parcelFlood.data.source, 'parcel')
    assert.match(parcelFlood.data.floodZoneDescription ?? '', /outside the 100- and 500-year/)
  }

  // SFHA 'In' must flag high risk even for unexpected zone codes
  payload = { floodZoneCode: 'D', specialFloodHazardArea: 'In' }
  assert.equal((await provider.getFloodZoneByParcel!('48029:36205502')).success, false) // D rejected by zone validation

  payload = { floodZoneCode: 'AE', specialFloodHazardArea: 'In' }
  const sfhaIn = await provider.getFloodZoneByParcel!('48029:36205502')
  assert.equal(sfhaIn.success && sfhaIn.data.isInFloodZone, true)

  // Malformed parcel ID — must fail without firing a request
  const beforeMalformed = paths.length
  const malformed = await provider.getFloodZoneByParcel!('5533034499')
  assert.equal(malformed.success, false)
  assert.equal(!malformed.success && malformed.code, 'INVALID_RESPONSE')
  assert.equal(paths.length, beforeMalformed)
} finally { globalThis.fetch = originalFetch }

// parcelId + site-location propagation: the search item's v1PropertyId must reach
// NormalizedProperty so getPropertyBundle can prefer the parcel flood-zone resource.
globalThis.fetch = async (input, init) => {
  if (init?.method === 'POST') return Response.json({ access_token: 'fixture-token', expires_in: 3600 })
  const url = new URL(String(input))
  if (url.pathname === '/v2/properties/search') {
    return Response.json({ items: [{
      clip: '5533034499',
      v1PropertyId: '48029:36205502',
      propertyAPN: { fipsCode: '48029', universalParcelId: '36205502', apnParcelNumberFormatted: '17786-042-0330' },
      propertyAddress: { streetAddress: '5802 Misty Gln', city: 'San Antonio', state: 'TX', zipCode: '78247' },
    }] })
  }
  return Response.json({ siteLocation: { data: {
    neighborhood: { code: '98476', name: 'HIGH COUNTRY' },
    cbsa: { code: '41700', type: 'Metro' },
    censusTract: { id: '1218125002' },
    locationLegal: { subdivisionName: 'HIGH COUNTRY BL 17786 UN 13', blockNumber: '42', lotNumber: '33', description: 'NCB 17786 BLK 42 LOT 33' },
  } }, buildings: { data: { buildings: [{
    structureClassification: { gradeTypeCode: 'FAI' },
    constructionDetails: { buildingImprovementConditionCode: 'AVE', buildingImprovementValue: 171470, yearBuilt: 1982 },
  }] } } })
}
try {
  const provider = createCoreLogicProvider({ CORELOGIC_CLIENT_ID: 'fixture', CORELOGIC_CLIENT_SECRET: 'fixture' } as Env)
  const result = await provider.searchProperty({ address: '5802 Misty Gln, San Antonio, TX 78247' })
  assert.equal(result.success, true)
  if (result.success) {
    assert.equal(result.data.id, '5533034499')
    assert.equal(result.data.parcelId, '48029:36205502')
    assert.equal(result.data.apnFormatted, '17786-042-0330')
    assert.equal(result.data.subdivision, 'HIGH COUNTRY BL 17786 UN 13')
    assert.equal(result.data.neighborhoodName, 'HIGH COUNTRY')
    assert.equal(result.data.neighborhoodCode, '98476')
    assert.equal(result.data.cbsaCode, '41700')
    assert.equal(result.data.censusTract, '1218125002')
    assert.equal(result.data.legalDescription, 'NCB 17786 BLK 42 LOT 33')
    assert.equal(result.data.buildingCondition, 'Average')
    assert.equal(result.data.buildingGrade, 'Fair')
    assert.equal(result.data.improvementValue, 171470)
  }
} finally { globalThis.fetch = originalFetch }

// Subject AVM (THV): normalized estimate, malformed parcel ID, missing value
let avmPayload: unknown = { amount: 312000, confidenceScore: 82, fsd: 0.061, valueRange: { low: 295000, high: 329000 }, asOfDate: '2026-09-01' }
globalThis.fetch = async (input, init) => {
  if (init?.method === 'POST') return Response.json({ access_token: 'fixture-token', expires_in: 3600 })
  paths.push(new URL(String(input)).pathname)
  return Response.json(avmPayload)
}
try {
  const provider = createCoreLogicProvider({ CORELOGIC_CLIENT_ID: 'fixture', CORELOGIC_CLIENT_SECRET: 'fixture' } as Env)
  const avm = await provider.getAvm!('48029:36205502')
  assert.equal(paths.at(-1), '/property/48029%3A36205502/avm/thv/thvMarketingStandard')
  assert.equal(avm.success, true)
  if (avm.success) {
    assert.equal(avm.data.value, 312000)
    assert.equal(avm.data.confidence, 82)
    assert.equal(avm.data.valueRangeLow, 295000)
    assert.equal(avm.data.valueRangeHigh, 329000)
    assert.equal(avm.data.fsd, 0.061)
    assert.equal(avm.data.model, 'thvMarketingStandard')
  }
  // Malformed parcel ID — must fail without firing a request
  const beforeAvm = paths.length
  const badAvm = await provider.getAvm!('5533034499')
  assert.equal(badAvm.success, false)
  assert.equal(paths.length, beforeAvm)
  // Missing value — INVALID_RESPONSE
  avmPayload = { corelogicPropertyId: '48029:36205502' }
  const noValue = await provider.getAvm!('48029:36205502')
  assert.equal(noValue.success, false)
  assert.equal(!noValue.success && noValue.code, 'INVALID_RESPONSE')
} finally { globalThis.fetch = originalFetch }

// Building detail supplement: GET /property/{parcelId}/building — literal-text
// condition/style/foundation when the coded property-detail block lacks them.
let buildingPayload: unknown = {
  buildings: [{
    condition: 'AVERAGE',
    style: 'RANCH/RAMBler',
    foundationType: 'SLAB',
    constructionType: 'FRAME',
    exteriorWallType: 'VINYL SIDING',
    roofCoverType: 'COMPOSITION SHINGLE',
    numberOfStories: 1,
    heatType: 'CENTRAL',
    airConditioning: 'CENTRAL',
    parkingType: 'ATTACHED GARAGE',
    garageAreaSquareFeet: 440,
    poolType: 'NONE',
    yearBuilt: 1996,
  }],
}
globalThis.fetch = async (input, init) => {
  if (init?.method === 'POST') return Response.json({ access_token: 'fixture-token', expires_in: 3600 })
  paths.push(new URL(String(input)).pathname)
  return Response.json(buildingPayload)
}
try {
  const provider = createCoreLogicProvider({ CORELOGIC_CLIENT_ID: 'fixture', CORELOGIC_CLIENT_SECRET: 'fixture' } as Env)
  const detail = await provider.getBuildingDetail!('48029:36205502')
  assert.equal(paths.at(-1), '/property/48029%3A36205502/building')
  assert.equal(detail.success, true)
  if (detail.success) {
    assert.equal(detail.data.condition, 'AVERAGE')
    assert.equal(detail.data.buildingStyle, 'RANCH/RAMBler')
    assert.equal(detail.data.foundation, 'SLAB')
    assert.equal(detail.data.constructionType, 'FRAME')
    assert.equal(detail.data.exteriorWalls, 'VINYL SIDING')
    assert.equal(detail.data.roofCover, 'COMPOSITION SHINGLE')
    assert.equal(detail.data.stories, 1)
    assert.equal(detail.data.heating, 'CENTRAL')
    assert.equal(detail.data.cooling, 'CENTRAL')
    assert.equal(detail.data.parkingType, 'ATTACHED GARAGE')
    assert.equal(detail.data.garageSquareFeet, 440)
    assert.equal(detail.data.pool, 'NONE')
    assert.equal(detail.data.yearBuilt, 1996)
  }
  // Alternate nesting (data.buildings) resolves identically
  buildingPayload = { data: { buildings: [{ buildingCondition: 'GOOD', stories: '2' }] } }
  const nested = await provider.getBuildingDetail!('48029:36205502')
  assert.equal(nested.success, true)
  if (nested.success) {
    assert.equal(nested.data.condition, 'GOOD')
    assert.equal(nested.data.stories, 2)
  }
  // Malformed parcel ID — must fail without firing a request
  const beforeBd = paths.length
  const badBd = await provider.getBuildingDetail!('5533034499')
  assert.equal(badBd.success, false)
  assert.equal(paths.length, beforeBd)
} finally { globalThis.fetch = originalFetch }
console.log('Provider evidence fixtures: permit nesting/history, empty versus unavailable, flood unknown/parcel, parcelId/building-detail propagation, AVM, building detail and cache version passed')
