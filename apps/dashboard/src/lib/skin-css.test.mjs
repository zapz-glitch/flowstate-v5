import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

// The prototype "Studio" skin is one block at the end of globals.css. These guards keep it a skin:
// every rule scoped to html[data-skin], no selector shape that can leak onto the whole page, and
// every theme token covered. They read the CSS text; what the page actually looks like is checked in
// the browser (tests/ui-polish.e2e.ts, "Skin prototype").
const css = readFileSync(new URL('../app/globals.css', import.meta.url), 'utf8')
const marker = css.indexOf('PROTOTYPE SKIN')
assert.ok(marker > 0, 'the skin block is present')
const cut = css.lastIndexOf('/*', marker)
const base = css.slice(0, cut)
const skin = css.slice(cut)

/** Every style rule in a stylesheet text: its selector list, its declarations, and the @media it sits in */
function rules(text) {
  const out = []
  const src = text.replace(/\/\*[\s\S]*?\*\//g, '')
  const stack = []
  let buf = ''
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (ch === '{') {
      const head = buf.trim()
      buf = ''
      if (head.startsWith('@')) { stack.push({ at: head }); continue }
      const end = src.indexOf('}', i)
      out.push({ selectors: head.split(/,(?![^(]*\))/).map((s) => s.trim()), body: src.slice(i + 1, end), media: stack.map((s) => s.at).join(' ') })
      i = end
    } else if (ch === '}') { stack.pop(); buf = '' } else buf += ch
  }
  return out
}
const skinRules = rules(skin)
const SCOPE = /^(html\[data-skin="nds"\]|:where\(html\[data-skin="nds"\]\))/
/** The last compound of a selector: the element the rule styles */
const subject = (selector) => selector.replace(/::?[\w-]+(\([^)]*\))?$/g, '').split(/[\s>+~]+/).pop()
const tokensOf = (body) => new Set([...body.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]))

test('every selector in the skin starts at the skin attribute, so nothing applies with the skin off', () => {
  assert.ok(skinRules.length > 10, `found ${skinRules.length} rules`)
  for (const rule of skinRules) {
    for (const selector of rule.selectors) {
      assert.match(selector, SCOPE, `selector does not start at html[data-skin="nds"]: ${selector}`)
      assert.doesNotMatch(selector, /:not\(\[data-skin/, `selector applies when the skin is OFF: ${selector}`)
    }
  }
})

test('no skin selector uses a bare class that the base stylesheet @applies', () => {
  // `* { @apply border-border }` and `body { @apply bg-background text-foreground }` make Tailwind copy any
  // selector containing those classes into the global rule. That is how one line once grayed every border.
  const applied = new Set([...base.matchAll(/@apply\s+([^;]+);/g)].flatMap((m) => m[1].trim().split(/\s+/)))
  for (const cls of ['border-border', 'bg-background', 'text-foreground']) assert.ok(applied.has(cls), `${cls} is @applied in the base`)
  for (const rule of skinRules) {
    for (const selector of rule.selectors) {
      for (const cls of applied) {
        const bare = new RegExp(`\\.${cls.replace(/[.*+?^${}()|[\]\\/:]/g, '\\$&')}(?![\\w/-])`)
        assert.doesNotMatch(selector, bare, `bare @applied class .${cls} in: ${selector}`)
      }
    }
  }
})

test('the skin never sets spacing or a typeface on the whole page', () => {
  for (const rule of skinRules) {
    if (!/letter-spacing|font-family|font-feature-settings/.test(rule.body)) continue
    for (const selector of rule.selectors) {
      const target = subject(selector.replace(SCOPE, 'ROOT'))
      assert.ok(!/^(ROOT|html\b.*|body|main|\*)$/.test(target), `page-wide type rule: ${selector}`)
    }
  }
  assert.doesNotMatch(skin.replace(/\/\*[\s\S]*?\*\//g, ''), /monospace|font-feature-settings/)
  for (const rule of skinRules) for (const selector of rule.selectors) assert.doesNotMatch(selector, /uppercase/, `labels are not re-voiced by a utility class: ${selector}`)
})

test('light, dark and print each set every token the theme presets set', () => {
  const preset = base.match(/html\.light\[data-preset="led"\]\s*\{([\s\S]*?)\n\s*\}/)
  assert.ok(preset, 'the LED preset block is found')
  const needed = [...tokensOf(preset[1])]
  assert.ok(needed.length >= 20, `the preset sets ${needed.length} tokens`)
  const block = (test) => skinRules.find(test)
  const light = block((r) => !r.media && r.selectors.some((s) => /\[data-skin="nds"\]\[data-skin="nds"\]:not\(\.dark\)$/.test(s)))
  const dark = block((r) => !r.media && r.selectors.some((s) => /\[data-skin="nds"\]\[data-skin="nds"\]\.dark$/.test(s)))
  const print = block((r) => /@media print/.test(r.media) && r.selectors.some((s) => /^html(\[data-skin="nds"\]){3}$/.test(s)))
  for (const [name, rule] of [['light', light], ['dark', dark], ['print', print]]) {
    assert.ok(rule, `${name} token block is present and out-ranks the presets`)
    const have = tokensOf(rule.body)
    for (const token of needed) assert.ok(have.has(token), `${name} block is missing ${token}: it would fall through to the preset underneath`)
    assert.ok(!have.has('--radius'), 'the radius is the base value; repeating it did nothing')
  }
})

test('on screen, meaning colors are only darkened in light; on paper, in every theme', () => {
  let screen = 0, paper = 0
  for (const rule of skinRules) {
    for (const selector of rule.selectors) {
      if (!/text-(emerald|amber|red)-\d/.test(selector)) continue
      if (/@media print/.test(rule.media)) { paper++; continue }
      screen++
      assert.match(selector, /:not\(\.dark\)/, `darkens a meaning color in dark too: ${selector}`)
    }
  }
  assert.ok(screen >= 3 && paper >= 3, `screen ${screen}, paper ${paper}`)
})

test('rules key on hooks for what a thing is: ARV membership, stamps, surfaces, deal buttons, the notice, Run', () => {
  const all = skinRules.flatMap((r) => r.selectors).join('\n')
  for (const hook of ['[data-in-arv="false"]', '[data-stamp="median"]', '[data-stamp="anchor"]', '[data-surface="card"]', '[data-deal="prep"]', '[data-deal="decline"]', '[data-notice]', '[data-action="run"]']) {
    assert.ok(all.includes(hook), `${hook} is used`)
  }
  // The classes these hooks replaced must not creep back as selectors
  assert.doesNotMatch(all, /\.opacity-70|bg-blue-600|bg-amber-500\]|bg-emerald-500\/5/)
})
