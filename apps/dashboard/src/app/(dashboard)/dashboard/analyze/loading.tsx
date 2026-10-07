import { AnalysisPageSkeleton } from '@/components/analysis/AnalysisSkeletons'

export default function AnalyzeLoading() {
  return (
    <div className="space-y-6" aria-busy="true">
      <p role="status" className="sr-only">Loading property search…</p>
      <AnalysisPageSkeleton />
    </div>
  )
}
