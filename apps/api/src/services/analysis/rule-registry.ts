/**
 * Stable decision IDs for the Set-B trace.
 *
 * Flags stay human-readable for reports. checks[] gives replay and review a
 * stable rule name when prose wording changes.
 */

export interface RuleCheck {
  ruleId: string
  message: string
}

export function ruleIdForFlag(flag: string): string {
  const f = flag.toLowerCase()
  if (f.includes('lot-size failed')) return 'setb.t1.lot_delta_rescue'
  if (f.startsWith('t2 pocket-implied')) return 'setb.t2.pocket_implied'
  if (f.startsWith('t3 as-is avm floor')) return 'setb.t3.avm_floor'
  if (f.startsWith('t4 assessed')) return 'setb.t4.assessed_floor'
  if (f.startsWith('t5 report-only')) return 'setb.t5.report_only'
  if (f.startsWith('land rate:')) return 'setb.adjust.land_rate'
  if (f.startsWith('size rate:')) return 'setb.adjust.size_rate'
  if (f.includes('land adj')) return 'setb.adjust.land_delta'
  if (f.includes('adj > cap')) return 'setb.adjust.delta_cap'
  if (f.includes('verification —')) return 'evidence.verification'
  if (f.includes('median-tier driver')) return 'evidence.median_driver'
  if (f.includes('median-tier evidence only')) return 'setb.median_uplift'
  if (f.includes('non-median comps below similarity floor')) return 'setb.median_fallback'
  if (f.includes('no retail-priced evidence')) return 'setb.no_retail_evidence'
  if (f.includes('no arv-tier labels')) return 'setb.unlabeled_retail_evidence'
  if (f.includes('dropped from drivers')) return 'setb.similarity_gate'
  if (f.startsWith('anchored to')) return 'setb.anchor'
  if (f.startsWith('supporting range')) return 'setb.supporting_range'
  if (f.includes('anchor above supporting range')) return 'setb.support_bound.high'
  if (f.includes('anchor below supporting range')) return 'setb.support_bound.low'
  if (f.startsWith('self-heal:')) return 'setb.self_heal'
  if (f.includes('condition adj')) return 'setb.condition_adjustment'
  if (f.includes('condition uplift unverified')) return 'setb.condition_unverified'
  if (f.includes('size-adjusted ceiling')) return 'setb.size_ceiling'
  if (f.startsWith('bracketing:')) return 'setb.size_bracket'
  if (f.includes('different neighborhood')) return 'geo.neighborhood_bound'
  return 'setb.trace_flag'
}

export function checksForFlags(flags: string[] | null | undefined): RuleCheck[] {
  return (flags ?? []).map((message) => ({ ruleId: ruleIdForFlag(message), message }))
}
