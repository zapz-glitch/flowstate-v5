import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import { test } from 'node:test'
import { transformSync } from 'esbuild'

const require = createRequire(import.meta.url)
function load(file, mocks = {}) {
  const source = readFileSync(new URL(file, import.meta.url), 'utf8')
  const { code } = transformSync(source, { loader: file.endsWith('tsx') ? 'tsx' : 'ts', format: 'cjs', jsx: 'automatic' })
  const module = { exports: {} }
  vm.runInNewContext(code, { module, exports: module.exports, require: name => mocks[name] ?? require(name) })
  return module.exports
}

// Real shared appraisal logic — loaded from source so the test verifies the
// same matchers the API evaluator uses, not a copy.
const sharedFilters = load('../../../../../packages/shared/src/appraisal/filters.ts', {
  './adjustments': load('../../../../../packages/shared/src/appraisal/adjustments.ts'),
})
const shared = {
  subdivisionsMatch: sharedFilters.subdivisionsMatch,
  foundationFamily: load('../../../../../packages/shared/src/appraisal/adjustments.ts').foundationFamily,
}

const { compFeatureMatches, featureState } = load('./feature-match.ts', { '@flowstate-api/shared': shared })

const subject = {
  subdivision: 'HIGHLAND HILLS SUB UN 17 NCB 1',
  neighborhoodName: 'High Country',
  foundationType: 'Slab',
  buildingStyle: 'Ranch',
  storiesType: 'One Story',
  constructionType: 'Frame',
  exteriorWalls: 'Brick',
  roofCover: 'Composition Shingle',
  buildingCondition: 'Average',
  pool: 'In Ground',
  garage: 'Attached',
  heating: 'Forced Air',
  cooling: 'Central',
  fireplacesCount: 1,
  bedrooms: 3,
  bathrooms: 2,
  squareFeet: 1800,
  yearBuilt: 1998,
  lotSizeAcres: 0.2,
}

const matchingComp = {
  subdivision: 'HIGHLAND HILLS BL 10854 UN 15',
  neighborhoodName: 'High Country',
  foundationType: 'Concrete Slab',
  buildingStyle: 'Ranch',
  storiesType: '1 Story',
  stories: 1,
  constructionType: 'Frame',
  exteriorWalls: 'Brick',
  roofCover: 'Composition Shingle',
  buildingCondition: 'Good',
  pool: 'In Ground',
  garage: 'Attached',
  heating: 'Forced Air',
  cooling: 'Central',
  fireplacesCount: 1,
  bedrooms: 3,
  bathrooms: 2,
  squareFeet: 1900,
  yearBuilt: 2000,
  lotSizeAcres: 0.21,
}

test('every feature matches a like-for-like comp', () => {
  const matches = compFeatureMatches(matchingComp, subject)
  assert.equal(matches.length, 17)
  for (const m of matches) {
    assert.equal(m.state, 'match', `${m.key}: ${m.state}`)
  }
})

test('verified mismatches are red across the feature set', () => {
  const comp = {
    ...matchingComp,
    subdivision: 'OAKWOOD ESTATES',
    foundationType: 'Pier & Beam',
    buildingStyle: 'Colonial',
    stories: 2,
    constructionType: 'Masonry',
    exteriorWalls: 'Stucco',
    roofCover: 'Tile',
    buildingCondition: 'Poor',
    pool: '',
    garage: '',
    carport: '',
    heating: 'Window Unit',
    cooling: 'None',
    fireplacesCount: 0,
    bedrooms: 5,
    bathrooms: 4,
    squareFeet: 2600,
    yearBuilt: 2015,
    lotSizeAcres: 0.9,
    neighborhoodName: 'Elsewhere',
    neighborhoodCode: 'X',
  }
  const m = compFeatureMatches(comp, subject)
  for (const key of ['subdivision', 'foundation', 'style', 'stories', 'construction', 'roof', 'condition', 'pool', 'garage', 'hvac', 'fireplaces', 'beds', 'baths', 'sqft', 'year', 'lot', 'neighborhood']) {
    assert.equal(featureState(m, key), 'mismatch', key)
  }
})

test('missing data is unknown, never a false mismatch', () => {
  const comp = { ...matchingComp, foundationType: null, stories: null, storiesType: null, pool: null, garage: null, carport: null, neighborhoodName: null, neighborhoodCode: null, subdivision: null }
  const m = compFeatureMatches(comp, subject)
  for (const key of ['subdivision', 'foundation', 'stories', 'pool', 'garage', 'neighborhood']) {
    assert.equal(featureState(m, key), 'unknown', key)
  }
  // Populated fields still compare normally
  assert.equal(featureState(m, 'style'), 'match')
})

test('no subject → no comparisons', () => {
  assert.equal(compFeatureMatches(matchingComp, null).length, 0)
})

test('sub-1000sf subject: comps ≤1000sf qualify regardless of ±250', () => {
  const small = { ...subject, squareFeet: 700 }
  assert.equal(featureState(compFeatureMatches({ ...matchingComp, squareFeet: 999 }, small), 'sqft'), 'match')
  assert.equal(featureState(compFeatureMatches({ ...matchingComp, squareFeet: 1100 }, small), 'sqft'), 'mismatch')
})

test('unclassifiable foundation strings are not treated as mismatches', () => {
  const m = compFeatureMatches({ ...matchingComp, foundationType: 'Unknown (with basement)' }, { ...subject, foundationType: 'Brick Veneer' })
  assert.equal(featureState(m, 'foundation'), 'unknown')
})
