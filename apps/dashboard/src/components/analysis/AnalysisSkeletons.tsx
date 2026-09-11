'use client'

import { Skeleton } from '@/components/ui/skeleton'

export function SubjectPropertySkeleton() {
  return (
    <div className="border border-border rounded-sm overflow-hidden">
      <div className="flex flex-col sm:flex-row">
        <Skeleton className="w-full sm:w-56 h-28 sm:h-auto rounded-none" />
        <div className="flex-1 px-4 py-3 space-y-3">
          <Skeleton className="h-4 w-3/4" />
          <div className="grid grid-cols-2 gap-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="flex justify-between">
                <Skeleton className="h-3 w-12" />
                <Skeleton className="h-3 w-10" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

export function ValuationSkeleton() {
  return (
    <div className="border border-border rounded-sm">
      <div className="px-3 py-1.5 border-b border-border/30 flex items-center gap-2">
        <Skeleton className="h-3 w-16" />
      </div>
      <div className="grid grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="px-3 py-2.5 border-r border-border/20 last:border-r-0">
            <Skeleton className="h-2.5 w-10 mb-1.5" />
            <Skeleton className="h-5 w-16" />
          </div>
        ))}
      </div>
    </div>
  )
}

export function ComparablesSkeleton() {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-4 w-16" />
      </div>
      <div className="comps-grid">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="border border-border rounded-sm overflow-hidden">
            <Skeleton className="h-28 w-full rounded-none" />
            <div className="px-3 py-2.5 space-y-2">
              <Skeleton className="h-3 w-3/4" />
              <div className="grid grid-cols-2 gap-1">
                {Array.from({ length: 4 }).map((_, j) => (
                  <div key={j} className="flex justify-between">
                    <Skeleton className="h-2.5 w-10" />
                    <Skeleton className="h-2.5 w-8" />
                  </div>
                ))}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

/** Two-column skeleton matching the analysis page layout (map left + content right) */
export function AnalysisPageSkeleton() {
  return (
    <div className="flex-1 flex mx-4 sm:mx-6 mt-3 gap-4 min-h-[60vh]">
      {/* Map placeholder */}
      <div className="hidden lg:block w-1/2 flex-shrink-0">
        <Skeleton className="h-full w-full rounded-sm" />
      </div>
      {/* Content skeleton */}
      <div className="flex-1 min-w-0 space-y-4 lg:pl-4 pt-2 pb-4">
        <SubjectPropertySkeleton />
        <ValuationSkeleton />
        <ComparablesSkeleton />
      </div>
    </div>
  )
}

export function RiskFloodSkeleton() {
  return (
    <div className="border border-border rounded-sm p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Skeleton className="h-4 w-4 rounded-full" />
        <Skeleton className="h-3 w-28" />
      </div>
      <div className="grid grid-cols-2 gap-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="flex items-center gap-2">
            <Skeleton className="h-4 w-4 rounded-full" />
            <Skeleton className="h-3 w-24" />
          </div>
        ))}
      </div>
    </div>
  )
}
