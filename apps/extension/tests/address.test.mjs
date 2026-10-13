import assert from 'node:assert/strict'
import { test } from 'node:test'
import { pickAddress } from '../address.js'

test('highlighted text wins over anything on the page', () => {
  const found = pickAddress({ selection: ' 12 Oak St,\n Tampa, FL 33604 ', headings: ['910 E Eskimo Ave, Tampa, FL 33604 | Redfin'] })
  assert.deepEqual(found, { address: '12 Oak St, Tampa, FL 33604', source: 'selection' })
})

test('a listing page gives up its address from structured data', () => {
  const jsonLd = [
    'not json',
    JSON.stringify({ '@type': 'Organization', address: { streetAddress: 'PO Box 9', addressLocality: 'Seattle', addressRegion: 'WA', postalCode: '98101' } }),
    JSON.stringify({ '@graph': [{ '@type': 'BreadcrumbList' }, { '@type': 'SingleFamilyResidence', address: { '@type': 'PostalAddress', streetAddress: '910 E Eskimo Ave', addressLocality: 'Tampa', addressRegion: 'FL', postalCode: '33604' } }] }),
  ]
  assert.deepEqual(pickAddress({ selection: '', jsonLd, headings: [] }), { address: '910 E Eskimo Ave, Tampa, FL 33604', source: 'listing data' })
})

test('the page title is the fallback, and a page with no address gives nothing', () => {
  const zillow = { headings: ['', '4207 W Empedrado St, Tampa, FL 33629 | MLS #T3501234 | Zillow'] }
  assert.deepEqual(pickAddress(zillow), { address: '4207 W Empedrado St, Tampa, FL 33629', source: 'page title' })
  const unit = { headings: ['For sale: 1457 E 56th St #2, Los Angeles, CA 90011-1234 - 3 beds'] }
  assert.equal(pickAddress(unit).address, '1457 E 56th St #2, Los Angeles, CA 90011-1234')
  assert.equal(pickAddress({ headings: ['Marketplace - 3 Beds 2 Baths House | Facebook', '3 homes in Tampa, FL'] }), null)
  assert.equal(pickAddress(undefined), null)
})
