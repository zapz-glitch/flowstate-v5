import { AnalysisPageSkeleton } from '@/components/analysis/AnalysisSkeletons'

export default function AnalyzeLoading() {
  return (
    <div className="space-y-6" aria-busy="true">
      <p role="status" className="text-body-sm text-foreground-tertiary">Loading property search…</p>
      <AnalysisPageSkeleton />
    </div>
  )
}
