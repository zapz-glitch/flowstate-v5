#!/usr/bin/env tsx
/**
 * Replay — run saved report evidence through the CURRENT harness and
 * score the diff. This is the compliance layer: a rule change's blast
 * radius is what it does to saved answers, not vibes.
 *
 *   npx tsx scripts/replay.mts <saved-report.json> [more.json ...]
 *   npx tsx scripts/replay.mts /tmp/api-result-*.json
 *
 * Accepts either the raw analysis result JSON or the {data:{result}}
 * envelope the API returns. Exit code 1 when any replay diverges.
 */
import { readFileSync } from 'node:fs'
import { evaluateB, HARNESS_VERSION } from '@flowstate-api/shared/appraisal'
import { savedToBComps, savedToBSubject } from '../apps/api/src/services/evaluation/saved-pool'

const usd = (n: number | null | undefined) =>
  n == null ? '—' : `$${Math.round(n).toLocaleString('en-US')}`

const files = process.argv.slice(2)
if (files.length === 0) {
  console.error('usage: npx tsx scripts/replay.mts <report.json> [more.json ...]')
  process.exit(2)
}

let diverged = 0
for (const file of files) {
  const raw = JSON.parse(readFileSync(file, 'utf8'))
  const saved = raw?.data?.result ?? raw?.result ?? raw
  const items = saved?.comps?.items ?? []
  if (!items.length) {
    console.log(`${file}: no comp pool — skipped`)
    continue
  }

  const subject = savedToBSubject(saved)
  const comps = savedToBComps(items, null)
  const b = evaluateB(subject, comps, {
    rehabCost: saved?.valuation?.rehabCost ?? null,
  })

  const storedArv = saved?.valuation?.arvB ?? saved?.valuation?.arv ?? null
  const storedVersion = saved?.valuation?.bMechanics?.harnessVersion ?? 'unstamped'
  const addr = saved?.subject?.address ?? file
  const delta = storedArv != null && b.arv != null ? b.arv - storedArv : null
  const drift = delta != null && Math.abs(delta) > Math.max(1, storedArv * 0.02)

  console.log(`\n${addr}`)
  console.log(`  stored:  ${usd(storedArv)}  (harness ${storedVersion})`)
  console.log(`  replay:  ${usd(b.arv)}  ${delta != null ? (delta >= 0 ? '+' : '') + Math.round(delta).toLocaleString('en-US') : ''}${drift ? '  ⚠ DRIFT' : ''}`)
  console.log(`  source:  ${b.source}  conf ${b.conf}  anchor ${b.anchorAddress ?? '—'}`)
  console.log(`  drivers: ${(b.drivers ?? []).map((d) => `${d.comp.address} (${usd(d.contrib)})`).join(', ') || '—'}`)
  if (drift) diverged++
}

console.log(`\nreplayed ${files.length} report(s) under harness ${HARNESS_VERSION} — ${diverged} diverged`)
process.exit(diverged ? 1 : 0)
