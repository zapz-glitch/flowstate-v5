import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { test } from 'node:test'
import { transformSync } from 'esbuild'

const { code } = transformSync(readFileSync(new URL('./property-map-geometry.ts', import.meta.url), 'utf8'), { loader: 'ts', format: 'cjs' })
const module = { exports: {} }
vm.runInNewContext(code, { module, exports: module.exports })
const { isValidCoordinate, distanceMeters, normalizeHeading, nextCounterclockwiseHeading, headingToSubject, assessPanoramaLocation, isPreciseSubjectGeocode } = module.exports

test('coordinates allow zero and reject absent, nonfinite and out-of-range values', () => {
  for (const point of [{ lat: 0, lng: 0 }, { lat: -90, lng: 180 }]) assert.equal(isValidCoordinate(point), true)
  for (const point of [null, {}, { lat: '0', lng: 0 }, { lat: NaN, lng: 0 }, { lat: 91, lng: 0 }, { lat: 0, lng: -181 }]) assert.equal(isValidCoordinate(point), false)
})

test('distance uses great-circle geometry including dateline and antipodes', () => {
  assert.equal(distanceMeters({ lat: 0, lng: 0 }, { lat: 0, lng: 0 }), 0)
  assert.ok(Math.abs(distanceMeters({ lat: 0, lng: 0 }, { lat: 0, lng: 1 }) - 111195) < 1)
  assert.ok(distanceMeters({ lat: 0, lng: 179.9999 }, { lat: 0, lng: -179.9999 }) < 23)
  assert.ok(Number.isFinite(distanceMeters({ lat: 90, lng: 0 }, { lat: -90, lng: 0 })))
})

test('panorama heading points toward the subject in all compass directions', () => {
  const origin = { lat: 0, lng: 0 }
  for (const [point, expected] of [[{ lat: 1, lng: 0 }, 0], [{ lat: 0, lng: 1 }, 90], [{ lat: -1, lng: 0 }, 180], [{ lat: 0, lng: -1 }, 270]]) assert.equal(headingToSubject(origin, point), expected)
  assert.equal(normalizeHeading(-90), 270)
  assert.equal(normalizeHeading(720), 0)
  assert.equal(normalizeHeading(NaN), 0)
  let heading = 0
  for (const expected of [270, 180, 90, 0]) assert.equal(heading = nextCounterclockwiseHeading(heading), expected)
})

test('panorama proximity rejects missing IDs, invalid positions and imagery beyond 80 meters', () => {
  const subject = { lat: 0, lng: 0 }
  assert.equal(assessPanoramaLocation({ panoId: 'near', location: { lat: 0.0005, lng: 0 } }, subject).accepted, true)
  assert.equal(assessPanoramaLocation({ panoId: 'far', location: { lat: 0.001, lng: 0 } }, subject).reason, 'too-far')
  assert.equal(assessPanoramaLocation({ panoId: ' ', location: subject }, subject).reason, 'missing-panorama')
  assert.equal(assessPanoramaLocation({ panoId: 'x', location: { lat: NaN, lng: 0 } }, subject).reason, 'invalid-coordinate')
  assert.equal(assessPanoramaLocation({ panoId: 'x', location: subject }, subject, -1).accepted, false)
})

const result = {
  geometry: { location_type: 'ROOFTOP' },
  address_components: [
    ['123', '123', 'street_number'], ['North Main Street', 'N Main St', 'route'], ['Austin', 'Austin', 'locality'], ['Texas', 'TX', 'administrative_area_level_1'], ['78701', '78701', 'postal_code'],
  ].map(([long_name, short_name, type]) => ({ long_name, short_name, types: [type] })),
}
test('precise address matching accepts street abbreviations and verifies supplied locality and ZIP', () => {
  for (const address of ['123 N Main St', '123 North Main Street, Austin, TX 78701', '123 N. Main St., Austin, TX 78701-1234', '123 N Main St Apt 2, Austin, TX 78701']) assert.equal(isPreciseSubjectGeocode(result, address), true, address)
  for (const address of ['124 N Main St, Austin, TX 78701', '123 S Main St, Austin, TX 78701', '123 N Main St, Dallas, TX 78701', '123 N Main St, Austin, TX 78702', '123 N Main St, Austin, CA 78701']) assert.equal(isPreciseSubjectGeocode(result, address), false, address)
})
test('partial, approximate and street-only geocodes fail closed', () => {
  assert.equal(isPreciseSubjectGeocode({ ...result, partial_match: true }, '123 N Main St'), false)
  for (const location_type of ['APPROXIMATE', 'RANGE_INTERPOLATED', 'GEOMETRIC_CENTER']) assert.equal(isPreciseSubjectGeocode({ ...result, geometry: { location_type } }, '123 N Main St'), false)
  assert.equal(isPreciseSubjectGeocode({ ...result, address_components: [] }, '123 N Main St'), false)
})
