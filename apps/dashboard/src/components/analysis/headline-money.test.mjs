import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import { test } from 'node:test'
import { transformSync } from 'esbuild'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const require = createRequire(import.meta.url)
function load(file, mocks = {}) {
  const source = readFileSync(new URL(file, import.meta.url), 'utf8')
  const { code } = transformSync(source, { loader: file.endsWith('tsx') ? 'tsx' : 'ts', format: 'cjs', jsx: 'automatic' })
  const module = { exports: {} }
  vm.runInNewContext(code, { module, exports: module.exports, require: name => mocks[name] ?? require(name) })
  return module.exports
}
const money = load('./headline-money.ts')
const whole = load('./valuation-number.ts')
const { formatHeadlineMoney } = money
const thousand = { increment: 1000, mode: 'half_up' }
const fiveHundred = { increment: 500, mode: 'half_up' }

test('authoritative rounded amounts win without altering the exact amount or configured $500 output', () => {
  assert.equal(formatHeadlineMoney(612345.67, 612000, thousand), '612,000')
  assert.equal(formatHeadlineMoney(450123.45, 450500, thousand), '450,500')
  assert.equal(formatHeadlineMoney(440123.45, 440000, fiveHundred), '440,000')
  assert.equal(formatHeadlineMoney(1, 0, thousand), '0')
})

test('configured display fallback uses half-up ties for positive and negative amounts', () => {
  assert.equal(formatHeadlineMoney(612499.99, null, thousand), '612,000')
  assert.equal(formatHeadlineMoney(612500, null, thousand), '613,000')
  assert.equal(formatHeadlineMoney(-612500, null, thousand), '-613,000')
  assert.equal(formatHeadlineMoney(612250, null, fiveHundred), '612,500')
  assert.equal(formatHeadlineMoney(-612250, null, fiveHundred), '-612,500')
})

test('old reports keep whole-dollar fallback without assuming an absent rounding policy', () => {
  assert.equal(formatHeadlineMoney(612345.67), '612,346')
  assert.equal(formatHeadlineMoney(612345.67, NaN), '612,346')
  for (const amount of [undefined, null, NaN, Infinity, -Infinity]) assert.equal(formatHeadlineMoney(amount), '-')
})

test('valuation headline renders ARV, Buy and Wholesale from display fields and leaves exact data intact', () => {
  const { DealSummaryHero } = load('./DealSummaryHero.tsx', {
    './headline-money': money,
    './valuation-number': whole,
    './format-helpers': { fmtNumber: value => value?.toLocaleString('en-US') ?? '-' },
    '@/lib/utils': { cn: (...classes) => classes.filter(Boolean).join(' ') },
  })
  const valuation = Object.freeze({
    arv: 612345.67, buyPrice: 450123.45, wholesalePrice: 440123.45,
    displayedArv: 612000, displayedBuyPrice: 450000, displayedWholesalePrice: 440000,
    buyPricePercent: 73.50981, projectedROI: 14.7265, closingCosts: 15000.123,
    displayRounding: thousand,
  })
  const before = JSON.stringify(valuation)
  const html = renderToStaticMarkup(React.createElement(DealSummaryHero, { valuation }))
  for (const amount of ['612,000', '450,000', '440,000']) assert.ok(html.includes(amount))
  for (const amount of ['612,345.67', '450,123.45', '440,123.45']) assert.ok(!html.includes(amount))
  assert.equal(JSON.stringify(valuation), before)
  assert.ok(html.includes('74% of ARV'))
  assert.ok(html.includes('15% ROI'))
  assert.ok(html.includes('15,000'))
  assert.ok(!html.includes('73.50981'))
})

test('permits render records and distinguish empty, unavailable, historical and loading states', () => {
  const { PropertyPermits } = load('./PropertyPermits.tsx', { './format-helpers': { formatShortDate: value => value } })
  const render = props => renderToStaticMarkup(React.createElement(PropertyPermits, props))
  assert.match(render({ permits: { status: 'empty', items: [] } }), /Permits - NA.*No permit records returned/)
  assert.match(render({ permits: { status: 'unavailable', items: [] } }), /lookup unavailable/)
  assert.match(render({}), /not saved/)
  assert.match(render({ loading: true }), /Loading/)
  const html = render({ permits: { status: 'available', items: [{ permitId: 'p1', permitNumber: 'R1', projectType: 'Roofing', description: 'Replace roof', status: 'Completed', effectiveDate: '2024-03-01', jobValue: 12000 }] } })
  for (const value of ['Roofing', 'R1', 'Replace roof', 'Completed', '2024-03-01', '12,000']) assert.ok(html.includes(value))
  assert.ok(!html.includes('Permits - NA'))
})

test('PDF and secondary card use the same formatter for all three headline amounts', () => {
  for (const path of ['./ValuationCard.tsx', '../report/UnderwritingReportPDF.tsx']) {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8')
    for (const [exact, displayed] of [['arv', 'displayedArv'], ['buyPrice', 'displayedBuyPrice'], ['wholesalePrice', 'displayedWholesalePrice']]) {
      assert.match(source, new RegExp(`formatHeadlineMoney\\(valuation\\??\\.${exact}, valuation\\??\\.${displayed}, valuation\\??\\.displayRounding\\)`))
    }
  }
})
