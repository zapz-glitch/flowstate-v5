#!/usr/bin/env tsx
/**
 * Re-baseline frozen replay fixtures after an intentional engine change.
 * Replays each run-record's last frozen attempt through the CURRENT
 * evaluateB and writes the result back (attempt.result, checks,
 * valuation + bMechanics, harnessVersion), then recomputes payloadHash.
 *
 *   npx tsx scripts/rebaseline-snapshots.mts fixtures/snapshots/*.json
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { evaluateB, HARNESS_VERSION } from '@flowstate-api/shared/appraisal'
import { gradeResult, resultStatusReason } from '../apps/api/src/services/analysis/result-grade'
import { checksForFlags } from '../apps/api/src/services/analysis/rule-registry'
import { savedToBComps, savedToBSubject } from '../apps/api/src/services/evaluation/saved-pool'
import { canonicalJson, sha256Text } from '../apps/api/src/services/evaluation/run-record'
import { createValuationService } from '../apps/api/src/services/valuation'

const numberOrNull = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null

function replayValuation(payload: Record<string, unknown>, arv: number | null) {
  if (arv == null) return null
  const response = (payload.result as Record<string, unknown> | undefined)?.response as Record<string, unknown> | undefined
  const evidence = payload.evidence as Record<string, unknown> | undefined
  const applied = (evidence?.appliedSettings ?? response?.appliedSettings) as Record<string, unknown> | undefined
  if (!applied) return null
  const subject = ((evidence?.subject ?? response?.subject) ?? {}) as Record<string, unknown>
  const valuation = (response?.valuation ?? {}) as Record<string, unknown>
  const items = ((response?.comps as { items?: Array<Record<string, unknown>> } | undefined)?.items ?? [])
  const eligible = items.filter((item) => {
    const rules = item.appraisalRules as { passedFilters?: boolean } | undefined
    const price = numberOrNull(item.adjustedPrice) ?? numberOrNull(item.salePrice)
    return rules?.passedFilters !== false && price != null && price > 0
  })
  const arvComps = [...eligible]
    .sort((a, b) => ((numberOrNull(b.adjustedPrice) ?? numberOrNull(b.salePrice)) ?? 0)
      - ((numberOrNull(a.adjustedPrice) ?? numberOrNull(a.salePrice)) ?? 0))
    .slice(0, 3)
  const subjectSqft = numberOrNull(subject.squareFeet) ?? 0
  const compAvgSqft = arvComps.length
    ? arvComps.reduce((sum, item) => sum + (numberOrNull(item.squareFeet) ?? 0), 0) / arvComps.length
    : subjectSqft
  const dealParams = applied.dealParams as Record<string, unknown> | undefined
  const service = createValuationService(applied.rehabTable as never)
  return service.calculateValuation({
    arv,
    subjectSqft,
    compAvgSqft,
    rehabLevelIndex: numberOrNull(applied.rehabLevelIndex) ?? 2,
    skipBaseRehab: valuation.rehabLevel === 'Renovated',
    majorItems: (applied.majorItems as never) ?? [],
    additionPlay: numberOrNull(applied.additionPlay) ?? 0,
    closingCostsPercent: numberOrNull(dealParams?.closingCostsPercent) ?? 8,
    carryingCostsPercent: numberOrNull(dealParams?.carryingCostsPercent) ?? 2,
    wholesaleFee: numberOrNull(dealParams?.wholesaleFee) ?? 10000,
    locationPenaltyAmount: numberOrNull(valuation.locationPenalty) ?? undefined,
    locationPenaltyPercent: numberOrNull(valuation.locationPenaltyPercent) ?? undefined,
  })
}

async function main() {
  const files = process.argv.slice(2)
  for (const file of files) {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    const payload = raw?.payload?.recordVersion === 'run-record.v1' ? raw.payload : null
    if (!payload) { console.log(`skip ${file} — not a run-record`); continue }

    const evidence = payload.evidence as Record<string, unknown>
    const attempts = Array.isArray(evidence?.attempts) ? evidence.attempts as Array<Record<string, unknown>> : []
    const last = attempts[attempts.length - 1]
    const response = ((payload.result as Record<string, unknown>)?.response ?? {}) as Record<string, unknown>
    const valuation = (response.valuation ?? {}) as Record<string, unknown>

    let replay: ReturnType<typeof evaluateB>
    if (last?.subject && Array.isArray(last.comps)) {
      // evaluateB adjusts comps in place — clone so the frozen evidence stays pristine
      replay = evaluateB(
        JSON.parse(JSON.stringify(last.subject)) as Parameters<typeof evaluateB>[0],
        JSON.parse(JSON.stringify(last.comps)) as Parameters<typeof evaluateB>[1],
        (last.options as Parameters<typeof evaluateB>[2] | undefined) ?? {})
    } else if (((response.comps as { items?: unknown[] } | undefined)?.items ?? []).length) {
      const items = (response.comps as { items: Array<Record<string, unknown>> }).items
      replay = evaluateB(
        savedToBSubject(response),
        savedToBComps(items as never, null),
        { rehabCost: numberOrNull(valuation.rehabCost) })
    } else {
      console.log(`skip ${file} — no Set-B inputs`); continue
    }

    const mechanics = (valuation.bMechanics ?? {}) as Record<string, unknown>
    const attemptTrail = Array.isArray(evidence?.bAttemptTrail)
      ? evidence.bAttemptTrail as string[]
      : Array.isArray(mechanics.attemptTrail) ? mechanics.attemptTrail as string[] : []
    const fallbackUsed = String(evidence?.fallbackUsed ?? mechanics.fallbackUsed ?? '') || null
    const grades = gradeResult(replay, fallbackUsed, attemptTrail)

    const attemptSubject = (last?.subject ?? {}) as Record<string, unknown>
    const responseSubject = (response.subject ?? {}) as Record<string, unknown>
    const subjectAvm = numberOrNull(attemptSubject.avmValue)
      ?? numberOrNull((responseSubject.avm as Record<string, unknown> | undefined)?.value)
    const assessed = numberOrNull(attemptSubject.assessedValue) ?? numberOrNull(responseSubject.assessedValue)
    const terminalArv = valuation.arvSource === 'avm' ? subjectAvm
      : valuation.arvSource === 'assessed' ? assessed
      : replay.arv

    const checks = checksForFlags(replay.flags)

    if (last?.subject && Array.isArray(last.comps)) {
      last.result = { ...replay }
      last.checks = checks
      // run-records mirror the attempts list at payload.attempts — keep it identical
      const top = Array.isArray(payload.attempts) ? payload.attempts as Array<Record<string, unknown>> : []
      const topLast = top[top.length - 1]
      if (topLast) {
        topLast.result = { ...replay }
        topLast.checks = checks
      }
    }
    valuation.arv = terminalArv
    valuation.arvB = replay.arv
    valuation.resultGrade = grades.resultGrade
    valuation.processGrade = grades.processGrade
    valuation.statusReason = resultStatusReason(replay, fallbackUsed, attemptTrail, grades, {
      arvSource: typeof valuation.arvSource === 'string' ? valuation.arvSource : null,
    })
    const valuationReplay = replayValuation(payload, terminalArv)
    if (valuationReplay) {
      valuation.buyPrice = valuationReplay.buyPrice
      valuation.rehabCost = valuationReplay.totalRehabCost
      valuation.projectedROI = valuationReplay.projectedROI
      valuation.recommendation = valuationReplay.recommendation
    }
    valuation.bMechanics = {
      ...replay,
      harnessVersion: HARNESS_VERSION,
      checks,
      attemptTrail,
      ...(mechanics.fallbackUsed !== undefined ? { fallbackUsed: mechanics.fallbackUsed } : {}),
    }
    response.valuation = valuation
    ;(payload.result as Record<string, unknown>).response = response
    ;(payload.rules as Record<string, unknown>).harnessVersion = HARNESS_VERSION
    const rules = payload.rules as Record<string, unknown>
    if (rules.models == null) rules.models = { fixture: 'synthetic' }
    if (rules.providers == null) rules.providers = { property: 'fixture' }

    const hash = await sha256Text(canonicalJson(payload))
    const out = { ...raw, payload, payloadHash: hash, exportedAt: new Date().toISOString() }
    writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`)
    console.log(`rebaselined ${file} — arv ${terminalArv} (${replay.source}), grade ${grades.resultGrade}`)
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
