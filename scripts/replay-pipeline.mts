#!/usr/bin/env node
// replay-pipeline.mts — replay a recorded pipeline artifact through the real
// performAnalysis offline (no providers, no LLM, no DB), then diff the fresh
// output against the recorded result.
//
//   npx tsx scripts/replay-pipeline.mts .data/attom-mcp/pipeline-sterling-v8.json
//   npx tsx scripts/replay-pipeline.mts --all            # every pipeline-*.json
//
// Boundary: artifacts store the POST-enrichment response, so this exercises
// evidence classification → ARV → group B → report assembly — the stages that
// churned in the 10-01 excision. ppsfMedians / transaction detail are NOT in
// recorded comp items, so replays can differ where those fields feed rules —
// check `diffs` before assuming a regression.
//
// Artifact: .data/replay/<slug>-<ts>.json with { recorded, replayed, diffs }.

import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { performAnalysis } from '../apps/api/src/services/evaluation'
import { flexNumericFilters } from '../apps/api/src/services/appraisal/evaluator'
import { filtersForLadder } from '../apps/api/src/services/appraisal/filter-ladder'
import { DEFAULT_FILTERS, DEFAULT_ADJUSTMENTS } from '../apps/api/src/services/appraisal/types'
import type { Env } from '../apps/api/src/types'
import type {
  NormalizedComparable,
  NormalizedProperty,
  PropertyBundle,
} from '../apps/api/src/services/property-api/types'

const ARTIFACT_DIR = new URL('../.data/attom-mcp/', import.meta.url).pathname
const OUT_DIR = new URL('../.data/replay/', import.meta.url).pathname
const env = {} as Env

// ─── address parsing ─────────────────────────────────────────────────────────

function parseAddress(full: string): { street: string; city: string; state: string; zip: string } {
  const parts = (full ?? '').split(',').map((p) => p.trim()).filter(Boolean)
  const street = parts[0] ?? full
  const city = parts[1] ?? ''
  const stZip = (parts[2] ?? '').match(/([A-Z]{2})\s*(\d{5})?/)
  return { street, city, state: stZip?.[1] ?? '', zip: stZip?.[2] ?? '' }
}

// ─── artifact → PropertyBundle ───────────────────────────────────────────────

function toProperty(s: any): NormalizedProperty {
  const a = parseAddress(s.address)
  return {
    id: String(s.id ?? 'replay-subject'),
    provider: 'attom-mcp',
    address: a.street,
    city: s.city ?? a.city,
    state: s.state ?? a.state,
    zipCode: s.zipCode ?? a.zip,
    county: s.county,
    latitude: s.latitude ?? null,
    longitude: s.longitude ?? null,
    bedrooms: s.bedrooms ?? null,
    bathrooms: s.bathrooms ?? null,
    squareFeet: s.squareFeet ?? null,
    lotSizeAcres: s.lotSizeAcres ?? null,
    yearBuilt: s.yearBuilt ?? null,
    propertyType: s.propertyType ?? null,
    stories: s.stories ?? null,
    lastSalePrice: s.lastSale?.price ?? s.lastSalePrice ?? null,
    lastSaleDate: s.lastSale?.date ?? s.lastSaleDate ?? null,
    pricePerSqft: s.lastSale?.pricePerSqft ?? null,
    assessedValue: s.taxAssessment ?? s.assessedValue ?? null,
    marketValue: s.taxAssessment ?? s.marketValue ?? null,
    taxAmount: s.taxAmount ?? null,
    avmValue: s.avm?.value ?? s.avmValue ?? null,
    avmConfidence: s.avm?.confidence ?? s.avmConfidence ?? null,
    hoaFee: s.hoaFee ?? null,
    subdivision: s.subdivision ?? null,
    parcelId: s.parcelId ?? null,
    apnFormatted: s.apnFormatted ?? null,
    neighborhoodName: s.neighborhoodName ?? null,
    neighborhoodCode: s.neighborhoodCode ?? null,
    cbsaCode: s.cbsaCode ?? null,
    censusTract: s.censusTract ?? null,
    legalDescription: s.legalDescription ?? null,
    buildingCondition: s.buildingCondition ?? null,
    buildingGrade: s.buildingGrade ?? null,
    improvementValue: s.improvementValue ?? null,
    additionSquareFeet: s.additionSquareFeet ?? null,
    construction: {
      type: s.constructionType ?? null,
      qualityCode: s.qualityCode ?? null,
      buildingStyle: s.buildingStyle ?? null,
      storiesType: s.storiesType ?? null,
      roofType: s.roofType ?? null,
      roofCover: s.roofCover ?? null,
      foundationType: s.foundationType ?? null,
      exteriorWalls: s.exteriorWalls ?? null,
    },
    features: {
      poolType: s.pool ?? null,
      garageType: s.garage ?? null,
      garageSquareFeet: s.garageSquareFeet ?? null,
      carportType: s.carport ?? null,
      heating: s.heating ?? null,
      cooling: s.cooling ?? null,
      fireplacesCount: s.fireplacesCount ?? null,
    },
  }
}

function toComp(c: any): NormalizedComparable {
  const a = parseAddress(c.address)
  return {
    id: String(c.id),
    provider: 'attom-mcp',
    address: a.street,
    city: c.city ?? a.city,
    state: c.state ?? a.state,
    zipCode: c.zipCode ?? a.zip,
    latitude: c.latitude ?? null,
    longitude: c.longitude ?? null,
    distanceMiles: c.distanceMiles ?? null,
    bedrooms: c.bedrooms ?? null,
    bathrooms: c.bathrooms ?? null,
    squareFeet: c.squareFeet ?? null,
    lotSizeAcres: c.lotSizeAcres ?? null,
    yearBuilt: c.yearBuilt ?? null,
    propertyType: c.propertyType ?? null,
    salePrice: c.salePrice ?? null,
    saleDate: c.saleDate ?? null,
    pricePerSqft: c.pricePerSqft ?? null,
    saleReconciled: c.saleReconciled ?? null,
    flip: c.flip ?? null,
    distressedSale: c.distressedSale ?? null,
    subdivision: c.subdivision ?? null,
    parcelId: c.parcelId ?? null,
    neighborhoodName: c.neighborhoodName ?? null,
    neighborhoodCode: c.neighborhoodCode ?? null,
    censusTract: c.censusTract ?? null,
    ppsfMedians: c.ppsfMedians ?? null,
    avmValue: c.avmValue ?? null,
    buildingCondition: c.buildingCondition ?? null,
    buildingGrade: c.buildingGrade ?? null,
    stories: c.stories ?? null,
    crossesMajorRoad: c.crossesMajorRoad,
    sameBlockGroup: c.sameBlockGroup,
    construction: {
      type: c.constructionType ?? null,
      qualityCode: c.qualityCode ?? null,
      buildingStyle: c.buildingStyle ?? null,
      storiesType: c.storiesType ?? null,
      roofType: c.roofType ?? null,
      roofCover: c.roofCover ?? null,
      foundationType: c.foundationType ?? null,
      exteriorWalls: c.exteriorWalls ?? null,
    },
    features: {
      poolType: c.pool ?? null,
      garageType: c.garage ?? null,
      garageSquareFeet: c.garageSquareFeet ?? null,
      carportType: c.carport ?? null,
      heating: c.heating ?? null,
      cooling: c.cooling ?? null,
      fireplacesCount: c.fireplacesCount ?? null,
    },
    isEnriched: true,
  }
}

function toBundle(result: any): PropertyBundle {
  return {
    property: toProperty(result.subject),
    comparables: (result.comps?.items ?? []).map(toComp),
    enrichment: {
      permits: null, // response.permits is a summary; the pipeline wants records
      floodZone: result.floodZone
        ? {
            floodZone: result.floodZone.zone ?? null,
            floodZoneDescription: result.floodZone.description ?? null,
            isInFloodZone: result.floodZone.inFloodZone ?? false,
            isNearFloodZone: result.floodZone.isNearFloodZone ?? false,
            communityName: null,
            communityNumber: null,
            firmMapNumber: null,
            mapPanel: result.floodZone.mapPanel ?? null,
            mapDate: result.floodZone.mapDate ?? null,
            participationStatus: null,
            specialFloodHazardArea: result.floodZone.specialFloodHazardArea ?? null,
            source: 'listing' as const,
          }
        : null,
      avm: result.subject?.avm
        ? {
            value: result.subject.avm.value ?? null,
            confidence: result.subject.avm.confidence ?? null,
            valueRangeLow: result.subject.avm.valueRangeLow ?? null,
            valueRangeHigh: result.subject.avm.valueRangeHigh ?? null,
            model: result.subject.avm.model ?? null,
            asOfDate: result.subject.avm.asOfDate ?? null,
          }
        : null,
      locationRisks: result.locationRisks ?? null,
      weatherRisk: null,
      neighbourhood: result.neighbourhood ?? null,
    },
    metadata: {
      fetchedAt: result.meta?.fetchedAt ?? new Date().toISOString(),
      provider: 'attom-mcp',
      searchParams: { propertyId: String(result.subject?.id ?? 'replay') },
      comparablesParams: {
        propertyId: String(result.subject?.id ?? 'replay'),
        ...(result.comps?.retrieval ?? {}),
      } as PropertyBundle['metadata']['comparablesParams'],
      enrichmentOptions: {},
      retrieval: result.comps?.retrieval ?? undefined,
    },
  }
}

// ─── diff ────────────────────────────────────────────────────────────────────

function summarize(result: any) {
  const items = result?.comps?.items ?? []
  const byGroup: Record<string, number> = {}
  const byClass: Record<string, number> = {}
  for (const c of items) {
    byGroup[c.compGroup ?? 'none'] = (byGroup[c.compGroup ?? 'none'] ?? 0) + 1
    const t = c.classification?.type ?? 'none'
    byClass[t] = (byClass[t] ?? 0) + 1
  }
  return {
    arv: result?.valuation?.arv ?? result?.report?.arv?.value ?? null,
    asIsMarketPrice: result?.comps?.asIsMarketIntel?.asIsMarketPrice ?? null,
    flipSaleCount: result?.comps?.asIsMarketIntel?.flipSaleCount ?? null,
    insufficientComps: result?.comps?.insufficientComps ?? null,
    enabledCount: result?.comps?.enabledCount ?? null,
    compGroupCounts: byGroup,
    classificationCounts: byClass,
    steps: (result?.report?.steps ?? []).map((s: any) => `${s.step}:${s.status}`),
    fallbacksUsed: result?.report?.fallbacksUsed ?? [],
    recommendation: result?.valuation?.recommendation ?? null,
    subjectClassification: result?.subject?.classification?.type ?? null,
    comps: items.map((c: any) => ({
      id: c.id,
      address: c.address,
      isEnabled: c.isEnabled,
      compGroup: c.compGroup ?? null,
      classType: c.classification?.type ?? null,
      arvStatus: c.arvStatus ?? null,
      disableReasons: c.disableReasons ?? [],
      paramFlex: c.paramFlex ?? null,
    })),
  }
}

function diff(recorded: any, replayed: any) {
  const diffs: string[] = []
  for (const key of ['arv', 'asIsMarketPrice', 'flipSaleCount', 'insufficientComps', 'enabledCount', 'recommendation']) {
    if (JSON.stringify(recorded[key]) !== JSON.stringify(replayed[key]))
      diffs.push(`${key}: recorded=${JSON.stringify(recorded[key])} replayed=${JSON.stringify(replayed[key])}`)
  }
  for (const key of ['compGroupCounts', 'classificationCounts']) {
    const keys = new Set([...Object.keys(recorded[key] ?? {}), ...Object.keys(replayed[key] ?? {})])
    for (const k of keys) {
      if (recorded[key][k] !== replayed[key][k])
        diffs.push(`${key}.${k}: recorded=${recorded[key][k] ?? 0} replayed=${replayed[key][k] ?? 0}`)
    }
  }
  return diffs
}

// ─── main ────────────────────────────────────────────────────────────────────

async function replay(path: string) {
  const artifact = JSON.parse(readFileSync(path, 'utf8'))
  const recorded = artifact?.data?.result ?? artifact?.result ?? artifact
  if (!recorded?.subject || !recorded?.comps) throw new Error(`${path}: no recorded result shape`)
  const bundle = toBundle(recorded)
  // The DO's filter ladder lives outside performAnalysis — re-apply the
  // recorded winning step so ladder-admitted comps stay enabled. New records
  // carry the exact limits; records from before the ladder carry only the
  // old all-rules flex factor.
  const flex = recorded.comps?.retrieval?.paramFlex
  const flexFactor = flex?.factor ?? 1
  const isAttom = bundle.metadata.provider === 'attom-mcp'
  const appraisalRules =
    isAttom && flex?.limits
      ? { filters: filtersForLadder(DEFAULT_FILTERS, flex.extensions, flex.scope, recorded.subject?.squareFeet), adjustments: DEFAULT_ADJUSTMENTS }
      : isAttom && flexFactor > 1
        ? { filters: flexNumericFilters(DEFAULT_FILTERS, flexFactor), adjustments: DEFAULT_ADJUSTMENTS }
        : undefined
  const { response } = await performAnalysis(
    { jobId: `replay-${Date.now()}`, bundle, appraisalRules },
    env,
  )
  const rec = summarize(recorded)
  const rep = summarize(response)
  const diffs = diff(rec, rep)
  return { file: basename(path), recorded: rec, replayed: rep, diffs }
}

const arg = process.argv[2]
const files =
  arg === '--all'
    ? readdirSync(ARTIFACT_DIR).filter((f) => f.startsWith('pipeline-')).map((f) => join(ARTIFACT_DIR, f))
    : [arg]
if (!arg) {
  console.error('usage: npx tsx scripts/replay-pipeline.mts <artifact.json | --all>')
  process.exit(1)
}

mkdirSync(OUT_DIR, { recursive: true })
let anyDiffs = false
for (const file of files) {
  try {
    const out = await replay(file)
    const outPath = join(OUT_DIR, `${basename(file, '.json')}-replay-${Date.now()}.json`)
    writeFileSync(outPath, JSON.stringify(out, null, 2))
    anyDiffs ||= out.diffs.length > 0
    console.log(`\n=== ${out.file} ===`)
    console.log(`  ARV    recorded=${JSON.stringify(out.recorded.arv)}  replayed=${JSON.stringify(out.replayed.arv)}`)
    console.log(`  floor  recorded=${JSON.stringify(out.recorded.asIsMarketPrice)}  replayed=${JSON.stringify(out.replayed.asIsMarketPrice)}`)
    console.log(`  groups recorded=${JSON.stringify(out.recorded.compGroupCounts)} replayed=${JSON.stringify(out.replayed.compGroupCounts)}`)
    if (out.diffs.length) {
      console.log(`  DIFFS (${out.diffs.length}):`)
      for (const d of out.diffs) console.log(`    - ${d}`)
    } else {
      console.log('  no diffs')
    }
    console.log(`  artifact → ${outPath}`)
  } catch (e: any) {
    console.error(`\n=== ${basename(file)} === replay failed: ${e.message}`)
  }
}
process.exitCode = 0 // diffs are informational — artifacts record them
