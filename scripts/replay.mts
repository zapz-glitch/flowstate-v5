#!/usr/bin/env tsx
/**
 * Replay — run saved report evidence through the CURRENT harness and
 * score the diff. This is the compliance layer: a rule change's blast
 * radius is what it does to saved answers, not vibes.
 *
 *   npx tsx scripts/replay.mts <saved-report.json> [more.json ...]
 *   npx tsx scripts/replay.mts --all          (every saved_report in local D1)
 *
 * Exit code 1 when any replay diverges >2% from the stored ARV.
 */
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { evaluateB, HARNESS_VERSION } from '@flowstate-api/shared/appraisal'
import { savedToBComps, savedToBSubject } from '../apps/api/src/services/evaluation/saved-pool'

const usd = (n: number | null | undefined) =>
  n == null ? '—' : `$${Math.round(n).toLocaleString('en-US')}`

const root = resolve(process.cwd())

function loadCorpus(): { label: string; saved: Record<string, unknown> }[] {
  // wrangler d1 executes against apps/api/wrangler.toml's local D1
  const out = execFileSync(
    'npx',
    ['wrangler', 'd1', 'execute', 'flowstate-api-db', '--local', '--json',
     '--command', 'SELECT id, property_address, full_response_json FROM saved_reports WHERE full_response_json IS NOT NULL'],
    { cwd: resolve(root, 'apps/api'), maxBuffer: 512 * 1024 * 1024 },
  ).toString()
  const rows = JSON.parse(out)[0].results as { id: string; property_address: string; full_response_json: string }[]
  return rows.map((r) => ({
    label: `#${r.id} ${r.property_address}`,
    saved: JSON.parse(r.full_response_json),
  }))
}

function loadFiles(files: string[]) {
  return files.map((f) => {
    const raw = JSON.parse(readFileSync(f, 'utf8'))
    const saved = raw?.data?.result ?? raw?.result ?? raw
    return { label: saved?.subject?.address ?? f, saved }
  })
}

const args = process.argv.slice(2)
const corpus = args[0] === '--all' ? loadCorpus() : loadFiles(args)
if (!corpus.length) {
  console.error('usage: npx tsx scripts/replay.mts <report.json> [...] | --all')
  process.exit(2)
}

let diverged = 0, replayed = 0, skipped = 0
for (const { label, saved } of corpus) {
  const items = (saved as any)?.comps?.items ?? []
  if (!items.length) { skipped++; continue }

  const b = evaluateB(savedToBSubject(saved), savedToBComps(items, null), {
    rehabCost: (saved as any)?.valuation?.rehabCost ?? null,
  })

  const storedArv = (saved as any)?.valuation?.arvB ?? (saved as any)?.valuation?.arv ?? null
  const storedVersion = (saved as any)?.valuation?.bMechanics?.harnessVersion ?? 'unstamped'
  const delta = storedArv != null && b.arv != null ? b.arv - storedArv : null
  const drift = delta != null && Math.abs(delta) > Math.max(1, storedArv * 0.02)
  replayed++
  if (drift) diverged++

  console.log(
    `${drift ? '⚠' : '✓'} ${label}\n` +
    `    stored ${usd(storedArv)} (${storedVersion}) → replay ${usd(b.arv)}` +
    `${delta != null ? `  ${delta >= 0 ? '+' : ''}${Math.round(delta).toLocaleString('en-US')}` : ''}` +
    `  [${b.source}${b.anchorAddress ? ` — ${b.anchorAddress}` : ''}]`,
  )
}

console.log(`\n${replayed} replayed under ${HARNESS_VERSION} — ${diverged} diverged, ${skipped} skipped (no comp pool)`)
process.exit(diverged ? 1 : 0)
