import type { ValuationData } from './shared-types'

export function InvestorAnalysisSummary({ analysis }: { analysis: ValuationData['investorAnalysis'] }) {
  if (!analysis) return null
  const hasValue = analysis.value != null && Number.isFinite(analysis.value)
  return (
    <section className="border border-border rounded-sm px-4 py-3 space-y-2 text-foreground break-words">
      <h3 className="text-body-sm font-semibold">As-is / investor analysis</h3>
      <p className="text-body-sm">{analysis.methodLabel}</p>
      <p className="text-body-sm tabular-nums">
        {hasValue ? `$${analysis.value!.toLocaleString('en-US')} estimated as-is value` : 'As-is value not available'}
      </p>
      <p className="text-[11px]">{analysis.status.replaceAll('_', ' ')} · {analysis.sampleCount} investor cohort comparables</p>
      {analysis.eligibleCount != null && <p className="text-[11px]">{analysis.eligibleCount} eligible candidates reviewed</p>}
      {analysis.limitations.map((limitation, index) => <p key={index} className="text-[11px]">{limitation}</p>)}
    </section>
  )
}
