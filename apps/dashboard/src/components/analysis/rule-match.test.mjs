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
const helpers = load('./rule-match.ts')
const { formatRuleMatch } = helpers
const { RuleMatchDetails } = load('./RuleMatchDetails.tsx', { './rule-match': helpers })
const { InvestorAnalysisSummary } = load('./InvestorAnalysisSummary.tsx')

test('rule percentages never round an incomplete match to 100%', () => {
  assert.equal(formatRuleMatch({ matchPercent: 100, matchRuleCount: 6, matchRuleTotal: 6 }), '100% match · 6 of 6 checks passed')
  assert.equal(formatRuleMatch({ matchPercent: 83.33333, matchRuleCount: 5, matchRuleTotal: 6 }), '83% match · 5 of 6 checks passed')
  assert.equal(formatRuleMatch({ matchPercent: 99.999999, matchRuleCount: 99999, matchRuleTotal: 100000 }), '99% match · 99999 of 100000 checks passed')
  assert.equal(formatRuleMatch({ matchPercent: 100, matchRuleCount: 5, matchRuleTotal: 6 }), 'Match not scored')
  assert.equal(formatRuleMatch({ matchPercent: 0, matchRuleCount: 0, matchRuleTotal: 6 }), '0% match · 0 of 6 checks passed')
})

test('unknown scores are explicit while legacy reports have no added content', () => {
  for (const matchPercent of [null, NaN, Infinity, -1, 101]) {
    assert.equal(formatRuleMatch({ matchPercent, matchRuleCount: 1, matchRuleTotal: 2 }), 'Match not scored')
  }
  assert.equal(formatRuleMatch({ matchPercent: 100, matchRuleCount: 0, matchRuleTotal: 0 }), 'Match not scored')
  assert.equal(formatRuleMatch({}), null)
  assert.equal(renderToStaticMarkup(React.createElement(RuleMatchDetails, { comp: {} })), '')
})

test('comparable report shows the score and escaped mismatch evidence', () => {
  const html = renderToStaticMarkup(React.createElement(RuleMatchDetails, { comp: {
    matchPercent: 83.3333, matchRuleCount: 5, matchRuleTotal: 6,
    matchReasons: ['Year difference 15 exceeds 10', '<script>untrusted provider text</script>'],
  } }))
  assert.match(html, /83% match · 5 of 6 checks passed/)
  assert.match(html, /Year difference 15 exceeds 10/)
  assert.match(html, /&lt;script&gt;/)
  assert.doesNotMatch(html, /<script>|confidence|accuracy/i)
})

test('priority evidence is visible independently of rule matching', () => {
  const html = renderToStaticMarkup(React.createElement(RuleMatchDetails, { comp: {
    priorityRank: 1, compGroup: 'arv', rankingDetails: ['Subdivision: same', 'Year built difference: 3'],
  } }))
  assert.match(html, /Match rank #1/)
  assert.match(html, /Subdivision: same/)
  assert.match(html, /Year built difference: 3/)
  assert.match(html, /ARV comparable/)
  assert.doesNotMatch(html, /100%|renovated/i)
})

test('raw ratios become readable whole percentages without changing evidence', () => {
  const comp = {
    rankingDetails: ['subdivision: match', 'year-built difference: 0', 'relative sqft difference: 0.07796193984039287906691221608', 'relative lot-area difference: 0.1499607432609264590421355666', 'physical style: unknown'],
    matchReasons: ['building_style_match: unknown subject building style'],
  }
  const before = JSON.stringify(comp)
  assert.deepEqual(Array.from(helpers.formatComparisonDetails(comp)), [
    'Same subdivision', 'Same year built', 'Size difference: 8%', 'Lot size difference: 15%',
    'Subject style unavailable; style match cannot be verified',
  ])
  assert.equal(JSON.stringify(comp), before)
  assert.equal(helpers.formatComparisonDetails({ rankingDetails: ['relative sqft difference: 0.0001'] })[0], 'Size difference: less than 1%')
  assert.equal(helpers.formatComparisonDetails({ rankingDetails: ['relative sqft difference: unknown'] })[0], 'Size unavailable')
  assert.equal(helpers.formatMatchReason('building_style_match: building style Ranch != Conventional'), 'Style differs: Ranch vs. Conventional')
})

test('investor report keeps absent values and inferred methods explicit', () => {
  const analysis = { status: 'INSUFFICIENT_INVESTOR_DATA', methodLabel: 'Inferred investor cohort; engineering proposal', sampleCount: 0, eligibleCount: 2, value: null, limitations: ['No qualifying cohort'] }
  const empty = renderToStaticMarkup(React.createElement(InvestorAnalysisSummary, { analysis }))
  assert.match(empty, /As-is value not available/)
  assert.match(empty, /Inferred investor cohort; engineering proposal/)
  assert.match(empty, /No qualifying cohort/)
  assert.match(empty, /2 eligible candidates reviewed/)
  assert.doesNotMatch(empty, /\$0|70%/)
  const found = renderToStaticMarkup(React.createElement(InvestorAnalysisSummary, { analysis: { ...analysis, status: 'COHORT_FOUND', value: 456789, sampleCount: 3 } }))
  assert.match(found, /\$456,789 estimated as-is value/)
  assert.equal(renderToStaticMarkup(React.createElement(InvestorAnalysisSummary, { analysis: null })), '')
})
