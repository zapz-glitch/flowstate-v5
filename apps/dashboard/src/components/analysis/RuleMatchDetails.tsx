import type { CompItem } from './shared-types'
import { formatRuleMatch, formatComparisonDetails } from './rule-match'

export function RuleMatchDetails({ comp }: { comp: CompItem }) {
  const summary = formatRuleMatch(comp)
  const rank = comp.priorityRank != null && Number.isInteger(comp.priorityRank) && comp.priorityRank > 0 ? comp.priorityRank : null
  if (!summary && rank == null && !comp.rankingDetails?.length) return null
  return (
    <div className="mt-1.5 space-y-0.5 text-[11px] leading-snug text-foreground-tertiary break-words">
      {rank != null && <p className="font-medium text-foreground-secondary tabular-nums">Match rank #{rank}</p>}
      {comp.compGroup === 'arv' && <p>ARV comparable</p>}
      {comp.selectionReason?.startsWith('Selected explicitly by operator') && <p>Manually selected · preliminary estimate</p>}
      {comp.compGroup === 'as_is' && <p>Investor cohort comparable</p>}
      {summary && <p className="font-medium text-foreground-secondary tabular-nums">{summary}</p>}
      {formatComparisonDetails(comp).map((detail, index) => <p key={index}>{detail}</p>)}
    </div>
  )
}
