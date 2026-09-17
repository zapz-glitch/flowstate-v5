import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { test } from 'node:test'
import { transformSync } from 'esbuild'

function compile(name, globals = {}) {
  const { code } = transformSync(readFileSync(new URL(`./${name}.ts`, import.meta.url), 'utf8'), { loader: 'ts', format: 'cjs' })
  const module = { exports: {} }
  vm.runInNewContext(code, { module, exports: module.exports, ...globals })
  return module.exports
}
const geometry = compile('property-map-geometry')
function load(maps, timers = {}) {
  return compile('resolve-property-map', { window: { google: { maps } }, setTimeout, clearTimeout, require: () => geometry, ...timers })
}
const point = { lat: 30, lng: -97 }
const location = p => ({ toJSON: () => p })
const rooftop = {
  geometry: { location_type: 'ROOFTOP', location: location(point) },
  address_components: [{ long_name: '123', types: ['street_number'] }, { long_name: 'Main Street', types: ['route'] }, { long_name: 'Austin', types: ['locality'] }, { long_name: 'Texas', short_name: 'TX', types: ['administrative_area_level_1'] }, { long_name: '78701', types: ['postal_code'] }],
}

test('precise rooftop address replaces a distant provider coordinate; partial result never does', async () => {
  let result = rooftop
  const requests = []
  const api = load({ Geocoder: class { async geocode(request) { requests.push(request); return { results: [result] } } } })
  const provider = { lat: 35, lng: -90 }
  const verified = await api.resolvePropertyLocation('123 Main St, Austin, TX 78701', provider)
  assert.equal(verified.addressMatched, true)
  assert.equal(verified.coordinate, point)
  assert.equal(requests[0].address, '123 Main St, Austin, TX 78701')
  assert.equal(requests[0].bounds.south, provider.lat - 0.025)
  const ambiguous = await api.resolvePropertyLocation('123 Main St', provider)
  assert.equal(ambiguous.addressMatched, false)
  assert.equal(ambiguous.coordinate, provider)
  const nearby = await api.resolvePropertyLocation('123 Main St', { lat: 30.0001, lng: -97 })
  assert.equal(nearby.addressMatched, true)
  result = { ...rooftop, partial_match: true }
  const fallback = await api.resolvePropertyLocation('123 Main St, Austin, TX 78701', provider)
  assert.equal(fallback.addressMatched, false)
  assert.equal(fallback.coordinate, provider)
})

test('nearest official outdoor panorama retains exact ID and aims back toward subject', async () => {
  let pano = { pano: 'official-near', latLng: location({ lat: 29.9995, lng: -97 }) }
  const requests = []
  const api = load({ StreetViewService: class { async getPanorama(request) { requests.push(request); return { data: { location: pano } } } }, StreetViewPreference: { NEAREST: 'nearest' }, StreetViewSource: { GOOGLE: 'google', OUTDOOR: 'outdoor' } })
  const result = await api.resolveSubjectPanorama(point)
  assert.equal(result.panoId, 'official-near')
  assert.equal(result.heading, 0)
  assert.ok(result.distanceMeters > 55 && result.distanceMeters < 56)
  assert.equal(requests[0].radius, 80)
  assert.equal(requests[0].preference, 'nearest')
  assert.deepEqual(Array.from(requests[0].sources), ['google', 'outdoor'])
  pano = { pano: 'too-far', latLng: location({ lat: 30.001, lng: -97 }) }
  assert.equal(await api.resolveSubjectPanorama(point), null)
  pano = { latLng: location(point) }
  assert.equal(await api.resolveSubjectPanorama(point), null)
})

test('missing libraries and rejected service requests return explicit fallbacks', async () => {
  for (const maps of [undefined, {
    Geocoder: class { geocode() { throw new Error('denied') } },
    StreetViewService: class { async getPanorama() { throw new Error('unavailable') } },
    StreetViewPreference: { NEAREST: 'nearest' }, StreetViewSource: { GOOGLE: 'google', OUTDOOR: 'outdoor' },
  }]) {
    const api = load(maps)
    assert.equal((await api.resolvePropertyLocation('123 Main St', point)).addressMatched, false)
    assert.equal(await api.resolveSubjectPanorama(point), null)
  }
})

test('unresponsive services time out after six seconds and late results cannot change fallback', async () => {
  const callbacks = []
  let finish
  const api = load({ Geocoder: class { geocode() { return new Promise(resolve => { finish = resolve }) } } }, {
    setTimeout(callback, duration) { assert.equal(duration, 6000); callbacks.push(callback); return 1 }, clearTimeout() {},
  })
  const pending = api.resolvePropertyLocation('123 Main St', point)
  callbacks[0]()
  const result = await pending
  assert.equal(result.addressMatched, false)
  finish({ results: [rooftop] })
  await Promise.resolve()
  assert.equal(result.addressMatched, false)
})
