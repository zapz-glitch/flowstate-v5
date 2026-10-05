#!/usr/bin/env node
// Replay evaluateB against a stored run artifact and diff the output.
// Proves whether a code change moved the number — and only the number.
//   node --import tsx scripts/ab-replay.mjs <artifact.json|latest> [--dump]
import { evaluateB } from '../packages/shared/src/appraisal/set-b.ts'
import { readFileSync, readdirSync } from 'fs'
import { resolve } from 'path'

const arg = process.argv[2]
const artifacts = readdirSync('e2e/artifacts').filter((f) => f.endsWith('.json')).sort()
const file = !arg || arg === 'latest'
  ? `e2e/artifacts/${artifacts[artifacts.length - 1]}`
  : arg
const d = JSON.parse(readFileSync(file, 'utf8'))
const r = d.result
const stored = r.valuation?.bMechanics ?? {}

const s = r.subject
const subj = {
  squareFeet: s.squareFeet, yearBuilt: s.yearBuilt, censusTract: s.censusTract,
  subdivision: s.subdivision, neighborhoodName: s.neighborhoodName,
  landAssessedValue: s.landAssessedValue, taxAssessment: s.assessedValue,
  assessedValue: s.assessedValue, avmValue: s.avm?.value,
  lotSizeAcres: s.lotSizeAcres, lotSizeSquareFeet: s.lotSizeSquareFeet, condition: null,
}
const comps = (r.comps?.items ?? []).map((c) => ({
  address: c.address, isEnabled: c.isEnabled, salePrice: c.salePrice, saleDate: c.saleDate,
  squareFeet: c.squareFeet, pricePerSqft: c.pricePerSqft, adjustedPrice: c.adjustedPrice,
  distanceMiles: c.distanceMiles, sameBlockGroup: c.sameBlockGroup, censusTract: c.censusTract,
  subdivision: c.subdivision, neighborhoodName: c.neighborhoodName, yearBuilt: c.yearBuilt,
  lotSizeAcres: c.lotSizeAcres, lotSizeSquareFeet: c.lotSizeSquareFeet,
  landAssessedValue: c.landAssessedValue, propertyType: c.propertyType,
  crossesMajorRoad: c.crossesMajorRoad, disableReasons: c.disableReasons,
  classification: c.classification ? { type: c.classification.type } : null,
  curbAppeal: c.curbAppeal, evidenceVerification: c.evidenceVerification,
  appraisalRules: c.appraisalRules ? { totalAdjustment: c.appraisalRules.totalAdjustment } : null,
}))

const out = evaluateB(subj, comps, { rehabCost: null })
const diffs = []
if (out.arv !== r.valuation?.arv) diffs.push(`arv: stored $${r.valuation?.arv} → replay $${out.arv}`)
if (out.source !== stored.source) diffs.push(`source: "${stored.source}" → "${out.source}"`)
const storedDrivers = (stored.drivers ?? []).map((x) => x.address)
const replayDrivers = out.drivers.map((x) => x.comp.address)
if (JSON.stringify(storedDrivers.sort()) !== JSON.stringify(replayDrivers.sort()))
  diffs.push(`drivers: [${storedDrivers}] → [${replayDrivers}]`)
const newFlags = out.flags.filter((f) => !(stored.flags ?? []).includes(f))
const lostFlags = (stored.flags ?? []).filter((f) => !out.flags.includes(f))
if (newFlags.length) diffs.push(`new flags: ${newFlags.map((f) => '"' + f.slice(0, 60) + '"').join(', ')}`)
if (lostFlags.length) diffs.push(`lost flags: ${lostFlags.map((f) => '"' + f.slice(0, 60) + '"').join(', ')}`)

console.log(`${d.meta.address} — ${file.split('/').pop()}`)
console.log(`stored: arv=$${r.valuation?.arv} source="${stored.source}" drivers=[${storedDrivers}]`)
console.log(`replay: arv=$${out.arv} source="${out.source}" drivers=[${replayDrivers}] decisions=${out.decisions?.length ?? 0}`)
if (diffs.length) { console.log('DIFFS:'); diffs.forEach((x) => console.log('  ' + x)) }
else console.log('identical — code produced the same result')

if (process.argv.includes('--dump'))
  for (const x of out.decisions ?? [])
    console.log(`  ${x.stage.padEnd(10)} ${x.rule.padEnd(18)} ${x.verdict.padEnd(12)} ${x.compAddress ?? '(answer)'}${x.value != null ? ' = ' + x.value : ''}${x.note ? ' — ' + x.note : ''}`)
