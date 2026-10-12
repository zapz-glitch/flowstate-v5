#!/usr/bin/env node
/**
 * npm audit with an explicit, reviewed allowlist.
 *
 * `npm audit` has no native exclusion mechanism, so a transitive advisory
 * with no published fix would block CI forever. Allowlisted advisories are
 * listed in scripts/security-audit-allowlist.json — each entry must carry a
 * reason so the acceptance is auditable. Anything not on the list still
 * fails the gate at the same severity threshold as before
 * (`npm audit --audit-level=moderate`).
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const allowlistPath = resolve(root, 'scripts/security-audit-allowlist.json')
const allowlist = JSON.parse(readFileSync(allowlistPath, 'utf8'))
const allowed = new Map((allowlist.advisories ?? []).map((a) => [a.id, a]))

let audit
try {
  audit = JSON.parse(execFileSync('npm', ['audit', '--json'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }).toString())
} catch (e) {
  audit = JSON.parse((e.stdout ?? '').toString())
}

const BLOCKING = new Set(['moderate', 'high', 'critical'])
const failures = []
for (const vuln of Object.values(audit?.vulnerabilities ?? {})) {
  const advisories = (vuln.via ?? []).filter((v) => typeof v === 'object' && BLOCKING.has(v.severity))
  for (const adv of advisories) {
    const id = adv.url?.match(/GHSA-[a-z0-9-]+/i)?.[0] ?? `${adv.source}`
    if (allowed.has(id)) {
      console.warn(`allowlisted ${id}: ${vuln.name} (${adv.severity}) — ${allowed.get(id).reason}`)
      continue
    }
    failures.push(`${vuln.name}: ${adv.severity} — ${adv.title ?? id} (${adv.url ?? 'no url'})`)
  }
}

if (failures.length) {
  console.error(`security audit: ${failures.length} advisory(ies) at moderate+ severity`)
  for (const f of failures) console.error(`  ${f}`)
  process.exit(1)
}
console.log('security audit: no blocking advisories')
