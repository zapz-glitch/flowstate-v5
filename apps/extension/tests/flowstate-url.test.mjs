import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apiUrlFor, buildAnalyzeUrl, cleanAddress, normalizeBaseUrl, propertySearchUrl, reportUrl } from '../flowstate-url.js'

test('a selected address is flattened to one clean line', () => {
  assert.equal(cleanAddress(' 123 Main St,\n\tHouston, TX   77002 '), '123 Main St, Houston, TX 77002')
  assert.equal(cleanAddress('   \n '), '')
  assert.equal(cleanAddress(undefined), '')
})

test('the saved dashboard URL is repaired or rejected', () => {
  assert.equal(normalizeBaseUrl(''), 'https://app.flowstate.homes')
  assert.equal(normalizeBaseUrl('https://app.flowstate.homes/dashboard/analyze/'), 'https://app.flowstate.homes')
  assert.equal(normalizeBaseUrl('localhost:3000'), 'http://localhost:3000')
  assert.equal(normalizeBaseUrl('app.flowstate.homes'), 'https://app.flowstate.homes')
  assert.equal(normalizeBaseUrl('javascript:alert(1)'), null)
  assert.equal(normalizeBaseUrl('not a url'), null)
})

test('the link opens the analyze page with the address', () => {
  assert.equal(
    buildAnalyzeUrl('http://localhost:3000/', '123 Main St #4,\nHouston, TX'),
    'http://localhost:3000/dashboard/analyze?address=123%20Main%20St%20%234%2C%20Houston%2C%20TX',
  )
  // A broken saved URL falls back to the live site instead of opening nothing.
  assert.equal(buildAnalyzeUrl('not a url', '1 A St'), 'https://app.flowstate.homes/dashboard/analyze?address=1%20A%20St')
  assert.equal(buildAnalyzeUrl('http://localhost:3000', '  \n'), null)
})

test('the toolbar button opens Property Search on the saved dashboard', () => {
  assert.equal(propertySearchUrl('localhost:3000'), 'http://localhost:3000/dashboard/analyze')
  assert.equal(propertySearchUrl('not a url'), 'https://app.flowstate.homes/dashboard/analyze')
})

test('the API address follows the dashboard unless one is set', () => {
  assert.equal(apiUrlFor('https://app.flowstate.homes', ''), 'https://api.flowstate.homes')
  assert.equal(apiUrlFor('localhost:3000', undefined), 'http://localhost:8787')
  assert.equal(apiUrlFor('https://app.flowstate.homes', 'api.staging.flowstate.homes/'), 'https://api.staging.flowstate.homes')
  assert.equal(apiUrlFor('garbage url', 'also garbage'), 'https://api.flowstate.homes')
  assert.equal(reportUrl('localhost:3000', 'job_1 2'), 'http://localhost:3000/dashboard/reports/job_1%202')
})
