import type { CompItem } from './shared-types'
import { formatRuleMatch, formatComparisonDetails } from './rule-match'

export function RuleMatchDetails({ comp }: { comp: CompItem }) {
  const summary = formatRuleMatch(comp)
  const rank = comp.priorityRank != null && Number.isInteger(comp.priorityRank) && comp.priorityRank > 0 ? comp.priorityRank : null
  if (!summary && rank == null && !comp.rankingDetails?.length) return null
  return (
    <div className="mt-2 space-y-1 text-[11px] text-foreground break-words">
      {rank != null && <p className="font-medium tabular-nums">Match rank #{rank}</p>}
      {comp.compGroup === 'arv' && <p>ARV comparable</p>}
      {comp.selectionReason?.startsWith('Selected explicitly by operator') && <p>Manually selected · preliminary estimate</p>}
      {comp.compGroup === 'as_is' && <p>Investor cohort comparable</p>}
      {summary && <p className="font-medium tabular-nums">{summary}</p>}
      {formatComparisonDetails(comp).map((detail, index) => <p key={index}>{detail}</p>)}
    </div>
  )
}
