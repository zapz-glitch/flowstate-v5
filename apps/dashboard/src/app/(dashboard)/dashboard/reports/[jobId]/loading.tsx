import { AnalysisPageSkeleton } from '@/components/analysis/AnalysisSkeletons'

// The report view draws its own header once loaded, so this is only the body.
// (It is also shown under the Offers queue bar, so it carries no title or links of its own.)
export default function ReportLoading() {
  return (
    <div aria-busy="true">
      <p role="status" className="sr-only">Loading report…</p>
      <AnalysisPageSkeleton />
    </div>
  )
}
