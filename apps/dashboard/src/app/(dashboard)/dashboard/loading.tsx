import { SkeletonPageHeader, SkeletonRows, SkeletonStat } from '@/components/ui/skeleton'

// The dashboard's default loading screen: a title, a row of tiles, a list.
// Pages with their own shape (reports, settings, offers, ...) have their own loading.tsx.
export default function DashboardLoading() {
  return (
    <div className="space-y-8" aria-busy="true">
      <SkeletonPageHeader actions />
      <SkeletonStat label="Loading page" count={4} />
      <SkeletonRows label="Loading page" rows={4} />
    </div>
  )
}
