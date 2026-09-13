/**
 * comp-feedback — generates a paste-ready ticket for devin.ai when an
 * analyst overrides comp selection ("Notify").
 *
 * The report explains WHY each user-added comp wasn't selected (rule
 * audit trail + ranking), WHAT to change so it would be (thresholds,
 * priorities, expansion policy), and WHERE those knobs live in the repo.
 */

import type { CompItem, SubjectData } from '@/app/(dashboard)/dashboard/analyze/actions'
import { getCompKey } from '@/components/analysis/format-helpers'

export interface AppliedFilter {
  type: string
  enabled: boolean
  value: number
  priority?: 'hard' | 'soft'
}

export interface FeedbackContext {
  appliedFilters?: AppliedFilter[] | null
  fallbackUsed?: string | null
  fallbackReason?: string | null
  jobId?: string | null
  subjectAddress?: string | null
}

export type FeedbackKind = 'improve' | 'validate'

export interface FeedbackInput {
  subject: SubjectData | null | undefined
  comps: CompItem[]
  /** User's manual selection (comp keys via getCompKey) */
  userSelectedKeys: Set<string>
  context?: FeedbackContext
  userNotes?: string
  /** 'improve' = flagged for a system fix; 'validate' = stamped as correct */
  kind?: FeedbackKind
}

const FILTER_LABEL: Record<string, string> = {
  subdivision_match: 'Subdivision',
  neighborhood_match: 'Neighborhood',
  building_style_match: 'Style',
  foundation_match: 'Foundation',
  construction_material_match: 'Construction',
  pool_match: 'Pool',
  garage_match: 'Garage',
  condition_match: 'Condition',
  stories_match: 'Stories',
  roof_material_match: 'Roof material',
  sale_age: 'Sale age (days)',
  sqft_diff: 'Sqft diff (sf)',
  year_built_diff: 'Year built diff (yr)',
  distance: 'Distance (mi)',
  property_type: 'Property type',
  lot_size_diff: 'Lot diff (sf)',
  road_barrier: 'Road barrier',
}

const label = (t: string) => FILTER_LABEL[t] ?? t
const fmt = (v: unknown) => (v == null ? '—' : typeof v === 'number' ? v.toLocaleString() : String(v))

/** Per-rule remediation guidance when a hard rule killed the comp. */
function remediation(type: string, actual: unknown, threshold: unknown, priority: string): string {
  switch (type) {
    case 'sale_age':
      return `sale_age is absolute — never relaxed at any tier by design. Selecting this comp (${fmt(actual)}d old) requires a product decision to change the rule in code (apps/api/src/services/appraisal), not a settings change.`
    case 'year_built_diff':
      return `raise year_built_diff to ≥ ${fmt(actual)}yr. NOTE: the expansion ladder tops out at configured value + 4 (DEFAULT_EXPANSION_POLICY.yearBuiltExpansionSteps [2,4]) — if ${fmt(actual)} exceeds value+4, also extend the steps or raise the value past the actual diff.`
    case 'sqft_diff':
      return `raise sqft_diff to ≥ ${fmt(actual)}sf (or set to Preferred so it ranks instead of disqualifying).`
    case 'distance':
      return `raise distance to ≥ ${fmt(actual)}mi, or rely on expansion tiers (radius ×2 then radius dropped) — out-of-radius comps only appear rescued, never at the strict tier.`
    case 'lot_size_diff':
      return `raise lot_size_diff to ≥ ${fmt(actual)}sf or keep it Preferred (soft — already non-disqualifying).`
    case 'subdivision_match':
      return `hard by design. Options: set to Preferred, or confirm the comp shares the subject's neighborhood name/code — the neighborhood fallback tier rescues subdivision failures on verified neighborhood match.`
    case 'neighborhood_match':
      return `soft datapoint — a neighborhood failure should not disqualify; if it did, its priority was set to hard in the preset.`
    case 'stories_match':
      return `verified stories mismatch (>±0.5 tolerance). Set to Preferred to rank instead of disqualify — or the comp is genuinely unlike the subject.`
    case 'building_style_match':
      return `verified style mismatch. Set to Preferred to rank instead of disqualify.`
    case 'property_type':
      return `verified property-type mismatch — likely a genuinely wrong comp. Only override if the provider type is wrong.`
    case 'road_barrier':
      return `comp is across a major road from the subject — hard by design.`
    default:
      return `set this rule to Preferred in Evaluation Settings, or disable it, to stop it disqualifying this comp.`
  }
}

function compSummary(c: CompItem): string {
  const bits = [
    c.salePrice != null ? `$${c.salePrice.toLocaleString()}` : null,
    c.squareFeet != null ? `${c.squareFeet.toLocaleString()} sf` : null,
    c.yearBuilt != null ? `built ${c.yearBuilt}` : null,
    c.bedrooms != null ? `${c.bedrooms}bd` : null,
    c.bathrooms != null ? `${c.bathrooms}ba` : null,
    c.distanceMiles != null ? `${c.distanceMiles.toFixed(2)}mi` : null,
    c.saleDate ? `sold ${c.saleDate.slice(0, 10)}` : null,
    c.subdivision ? `sub: ${c.subdivision}` : null,
    c.neighborhoodName ? `hood: ${c.neighborhoodName}` : null,
    c.buildingStyle ? `style: ${c.buildingStyle}` : null,
    c.buildingCondition ? `condition: ${c.buildingCondition}` : null,
  ]
  return bits.filter(Boolean).join(' · ')
}

/** Analyze one user-added comp: why excluded + what would select it. */
function explainAddedComp(comp: CompItem, appliedFilters: AppliedFilter[] | null | undefined, engineSelected: CompItem[]): { why: string[]; changes: string[] } {
  const why: string[] = []
  const changes: string[] = []
  const filterResults = comp.appraisalRules?.filters ?? []

  const priorityOf = new Map((appliedFilters ?? []).map((f) => [f.type, f.priority ?? 'hard']))

  const hardFailures = filterResults.filter((f) => f.status === 'failed' && !f.passed && priorityOf.get(f.type) !== 'soft')
  const softFailures = filterResults.filter((f) => f.status === 'failed' && !f.passed && priorityOf.get(f.type) === 'soft')
  const unverified = filterResults.filter((f) => f.status === 'not_verified')

  if (comp.curbAppeal && (comp.curbAppeal.condition === 'dated' || comp.curbAppeal.condition === 'distressed') && comp.curbAppeal.source === 'vision') {
    why.push(`ARV-condition gate: vision classified it ${comp.curbAppeal.condition} (${comp.curbAppeal.confidence ?? '?'}% confidence) — verified below ARV spec`)
    changes.push('Condition evidence is an ARV-quality check, not a rule. If photos misled the vision pass, re-run analysis — or accept the comp only if its condition is actually ARV-spec.')
  }

  if (hardFailures.length > 0) {
    for (const f of hardFailures) {
      why.push(`FAILED ${label(f.type)}: ${f.reason ?? `actual ${fmt(f.actualValue)} vs threshold ${fmt(f.threshold)}`}`)
      changes.push(`${label(f.type)} — ${remediation(f.type, f.actualValue, f.threshold, 'hard')}`)
    }
  } else if (comp.isEnabled && comp.compGroup !== 'arv') {
    // Passed every rule but lost the top-3 ranking (verified passes →
    // sale recency → price). It's eligible — just outranked.
    why.push('Passed all rules but lost the ARV ranking — selection orders by verified rule passes, then sale recency, then price')
    const winners = engineSelected.slice(0, 3).map((c) => `${c.address} (${c.salePrice != null ? `$${c.salePrice.toLocaleString()}` : '?'}${c.saleDate ? `, sold ${c.saleDate.slice(0, 10)}` : ''})`)
    if (winners.length) why.push(`Outranked by: ${winners.join('; ')}`)
    changes.push('No rule change needed — it is eligible. To force it into the ARV set, it must outrank a selected comp on verified passes / recency / price, or the ARV comp count must increase (REQUIRED_ARV_COMPS in apps/api/src/services/appraisal/index.ts).')
  } else {
    why.push('Disabled without a recorded hard failure — check rule audit below')
  }

  for (const f of softFailures) {
    why.push(`soft fail ${label(f.type)}: ${f.reason ?? 'mismatch'} (ranked lower, not disqualifying)`)
  }
  if (unverified.length > 0) {
    why.push(`unverified: ${unverified.map((f) => label(f.type)).join(', ')} — missing provider data; no threshold change fixes this`)
  }

  return { why, changes }
}

export function generateCompFeedbackReport(input: FeedbackInput): string {
  const { subject, comps, userSelectedKeys, context, userNotes, kind = 'improve' } = input

  const indexed = comps.map((c, i) => ({ comp: c, key: getCompKey(c, i) }))
  // Engine's ARV selection is marked by compGroup === 'arv' on the server data
  const engineSelected = indexed.filter(({ comp }) => comp.compGroup === 'arv').map(({ comp }) => comp)
  const engineKeys = new Set(indexed.filter(({ comp }) => comp.compGroup === 'arv').map(({ key }) => key))

  const added = indexed.filter(({ key }) => userSelectedKeys.has(key) && !engineKeys.has(key))
  const removed = indexed.filter(({ key }) => engineKeys.has(key) && !userSelectedKeys.has(key))

  const lines: string[] = []
  lines.push(kind === 'validate'
    ? '# Comp Selection VALIDATION — analyst stamped this report as correct'
    : '# Comp Selection Feedback — paste into devin.ai')
  lines.push('')
  lines.push('**Repo:** flowstate-v5 — `apps/api/src/services/appraisal/` (rules engine), `apps/dashboard/` (settings UI)')
  lines.push(kind === 'validate'
    ? '**Task:** NO changes needed — the analyst reviewed this report and marked it correct. Use it as a positive example when tuning rules (a passing pattern to preserve in tests).'
    : '**Task:** adjust appraisal rules/data so the comp selection below matches what the analyst intended. Read the per-comp analysis and the suggested changes; implement the smallest change that achieves it, then run `cd apps/api && npx vitest run src/services/appraisal && npx tsc --noEmit`.')
  lines.push('')

  // Analyst notes
  lines.push('## Analyst notes')
  lines.push(userNotes?.trim() ? userNotes.trim() : '_(none)_')
  lines.push('')

  // Subject
  lines.push('## Subject')
  lines.push(`- ${context?.subjectAddress ?? subject?.address ?? 'unknown'}`)
  lines.push(`- ${compSummary({ salePrice: subject?.lastSale?.price, squareFeet: subject?.squareFeet, yearBuilt: subject?.yearBuilt, bedrooms: subject?.bedrooms, bathrooms: subject?.bathrooms, subdivision: subject?.subdivision } as CompItem)}`)
  lines.push('')

  // Engine context
  lines.push('## Engine context')
  if (context?.jobId) lines.push(`- Job: ${context.jobId}`)
  lines.push(`- Fallback tier: ${context?.fallbackUsed ?? 'none'}${context?.fallbackReason ? ` — ${context.fallbackReason}` : ''}`)
  lines.push(`- Pool: ${comps.length} returned, ${comps.filter((c) => c.isEnabled).length} enabled, ${engineSelected.length} selected for ARV`)
  lines.push('')

  // Applied rules
  if (context?.appliedFilters?.length) {
    lines.push('## Rules applied (this run)')
    lines.push('| Rule | Mode | Threshold |')
    lines.push('|---|---|---|')
    for (const f of context.appliedFilters) {
      lines.push(`| ${label(f.type)} | ${f.enabled ? (f.priority ?? 'hard') : 'OFF'} | ${f.enabled ? fmt(f.value) : '—'} |`)
    }
    lines.push('')
  }

  // Engine selection
  lines.push('## Engine selected')
  if (engineSelected.length === 0) lines.push('_(none)_')
  for (const c of engineSelected) lines.push(`- ${c.address} — ${compSummary(c)}`)
  lines.push('')

  // Analyst changes
  lines.push('## Analyst changes')
  if (added.length === 0 && removed.length === 0) {
    lines.push('_(no selection changes)_')
  }
  for (const { comp } of added) {
    lines.push(`### + ${comp.address} (analyst added)`)
    lines.push(`- ${compSummary(comp)}`)
    const { why, changes } = explainAddedComp(comp, context?.appliedFilters, engineSelected)
    lines.push('- Why not selected:')
    for (const w of why) lines.push(`  - ${w}`)
    if (changes.length) {
      lines.push('- To select it:')
      for (const ch of changes) lines.push(`  - ${ch}`)
    }
    if (comp.appraisalRules?.filters?.length) {
      lines.push('- Rule audit:')
      lines.push('  | Rule | Result | Actual | Threshold |')
      lines.push('  |---|---|---|---|')
      for (const f of comp.appraisalRules.filters) {
        const status = f.status ?? (f.passed ? 'passed' : 'failed')
        lines.push(`  | ${label(f.type)} | ${status} | ${fmt(f.actualValue)} | ${fmt(f.threshold)} |`)
      }
    }
    lines.push('')
  }
  for (const { comp } of removed) {
    lines.push(`### − ${comp.address} (analyst removed)`)
    lines.push(`- ${compSummary(comp)}`)
    lines.push(`- Was engine-selected for ARV; analyst excluded it. If this comp should never qualify, identify which rule should have failed it.`)
    lines.push('')
  }

  lines.push('## Notes for the agent')
  lines.push('- `not_verified` results mean missing provider data — do not treat them as failures; fix by improving data coverage, not thresholds.')
  lines.push('- `sale_age` and `stories_match`/`building_style_match`/`subdivision_match` are intentionally hard; prefer `priority: "soft"` changes over deleting rules.')
  lines.push('- Threshold defaults live in `DEFAULT_FILTERS`/`DEFAULT_EXPANSION_POLICY` (apps/api/src/services/appraisal/types.ts); per-user overrides flow through appraisal presets.')
  lines.push('- The rescue ladder only carries location failures (subdivision/distance/neighborhood); intrinsic hard failures can never be rescued.')

  return lines.join('\n')
}
