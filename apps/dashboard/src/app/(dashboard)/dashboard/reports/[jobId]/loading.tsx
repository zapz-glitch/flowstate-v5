import Link from 'next/link'
import { AnalysisPageSkeleton } from '@/components/analysis/AnalysisSkeletons'

export default function ReportLoading() {
  return (
    <div className="space-y-6" aria-busy="true">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-heading-lg">Property report</h1>
        <Link href="/dashboard/batch" className="text-body-sm text-primary hover:underline">Back to Batch Import</Link>
      </div>
      <p role="status" className="text-body-sm text-foreground-tertiary">Loading report…</p>
      <AnalysisPageSkeleton />
    </div>
  )
}
