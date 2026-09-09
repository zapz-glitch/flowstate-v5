import type { CompItem } from './shared-types'

export function formatRuleMatch(comp: Pick<CompItem, 'matchPercent' | 'matchRuleCount' | 'matchRuleTotal'>): string | null {
  if (comp.matchPercent === undefined) return null
  const percent = comp.matchPercent
  const count = comp.matchRuleCount
  const total = comp.matchRuleTotal
  if (percent == null || !Number.isFinite(percent) || percent < 0 || percent > 100 ||
      !Number.isInteger(count) || !Number.isInteger(total) || total! <= 0 || count! < 0 || count! > total! ||
      (percent === 100 && count !== total)) {
    return 'Match not scored'
  }
  const displayed = percent === 100 ? 100 : Math.min(99, Math.round(percent))
  return `${displayed}% match · ${count} of ${total} checks passed`
}

export function formatMatchReason(reason: string): string {
  const clean = reason.replace(/^[a-z_]+:\s*/, '')
  if (clean === 'unknown subject building style') return 'Subject style unavailable; style match cannot be verified'
  if (clean === 'unknown comp building style') return 'Comparable style unavailable; style match cannot be verified'
  if (clean.startsWith('building style ') && clean.includes(' != ')) return `Style differs: ${clean.slice(15).replace(' != ', ' vs. ')}`
  if (clean === 'subdivision mismatch') return 'Different subdivision'
  if (clean.startsWith('sqft difference ') && clean.includes(' exceeds ')) return 'Size difference exceeds your appraisal limit'
  if (clean.startsWith('year-built difference exceeds ')) return 'Year-built difference exceeds your appraisal limit'
  if (clean.startsWith('sale age ') && clean.includes(' exceeds ')) return 'Sale is older than your appraisal limit'
  if (clean.startsWith('distance ') && clean.includes(' exceeds ')) return 'Outside your distance limit'
  return clean.replace(/_/g, ' ').replace(/\d+\.\d+/g, value => Math.round(Number(value)).toLocaleString('en-US'))
}

export function formatComparisonDetails(comp: Pick<CompItem, 'rankingDetails' | 'matchReasons'>): string[] {
  const details = (comp.rankingDetails ?? []).map(detail => {
    const [key, ...parts] = detail.split(':')
    const value = parts.join(':').trim()
    if (key === 'subdivision') return value === 'match' ? 'Same subdivision' : value === 'mismatch' ? 'Different subdivision' : 'Subdivision unavailable'
    if (key === 'physical style') {
      if (comp.matchReasons?.some(reason => reason.startsWith('building_style_match:'))) return null
      return value === 'match' ? 'Same style' : value === 'mismatch' ? 'Different style' : 'Style unavailable'
    }
    const number = value !== '' ? Number(value) : NaN
    if (key === 'year-built difference') return !Number.isFinite(number) ? 'Year built unavailable' : number === 0 ? 'Same year built' : `Built ${Math.round(number)} ${Math.round(number) === 1 ? 'year' : 'years'} apart`
    if (key === 'relative sqft difference' || key === 'relative lot-area difference') {
      const label = key === 'relative sqft difference' ? 'Size' : 'Lot size'
      if (!Number.isFinite(number) || number < 0) return `${label} unavailable`
      if (number === 0) return `Same ${label.toLowerCase()}`
      return `${label} difference: ${number * 100 < 1 ? 'less than 1' : Math.round(number * 100)}%`
    }
    return formatMatchReason(detail)
  }).filter((detail): detail is string => detail !== null)
  return [...new Set([...details, ...(comp.matchReasons ?? []).map(formatMatchReason)])]
}
