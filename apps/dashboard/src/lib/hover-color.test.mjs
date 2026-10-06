import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

// One hover color across the app: light gray (hover:bg-secondary + hover:text-foreground).
// Green is only for Prep offer. Landing page, login and docs keep their own look.
const root = new URL('../', import.meta.url).pathname
const skip = ['components/landing', 'app/page.tsx', 'app/docs/', 'AuthModals', '.test.']
const files = []
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full)
    else if (/\.(tsx|ts)$/.test(name)) files.push(full)
  }
}
walk(root)

test('no dashboard control hovers green except Prep offer', () => {
  const offenders = []
  for (const file of files) {
    const rel = relative(root, file)
    if (skip.some((k) => rel.includes(k))) continue
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (!/hover:(bg|text)-(emerald|green)/.test(line)) return
      if (rel.endsWith('components/analysis/DealActions.tsx')) return // Prep offer
      if (/bg-emerald-500 hover:bg-emerald-600|text-green-400 hover:text-green-300/.test(line)) return // solid success buttons, not an overlay
      offenders.push(`${rel}:${i + 1}`)
    })
  }
  assert.deepEqual(offenders, [])
})

test('Prep offer keeps the green hover', () => {
  const src = readFileSync(join(root, 'components/analysis/DealActions.tsx'), 'utf8')
  assert.match(src, /hover:text-emerald-600 hover:bg-emerald-500\/10/)
})

test('the shared Button hovers light gray in every variant that has a hover color', () => {
  const src = readFileSync(join(root, 'components/ui/button.tsx'), 'utf8')
  assert.doesNotMatch(src, /emerald/)
  assert.match(src, /outline:[\s\S]*hover:bg-secondary hover:text-foreground/)
})
