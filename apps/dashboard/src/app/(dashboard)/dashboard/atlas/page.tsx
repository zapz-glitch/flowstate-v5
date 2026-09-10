'use client'

import { useEffect, useState } from 'react'
import dynamic from 'next/dynamic'
import { Loader2 } from 'lucide-react'
import { getReportMapPoints, type ReportMapPoint } from '@/lib/client-api'

const GlobeInner = dynamic(() => import('@/components/atlas/GlobeInner'), {
  ssr: false,
  loading: () => (
    <div className="absolute inset-0 flex items-center justify-center bg-background">
      <Loader2 className="w-6 h-6 animate-spin text-foreground-secondary" />
    </div>
  ),
})

export default function AtlasPage() {
  const [points, setPoints] = useState<ReportMapPoint[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    getReportMapPoints()
      .then((res) => setPoints(res.points))
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load map data'))
      .finally(() => setLoading(false))
  }, [])

  const cities = new Set(points.map((p) => `${p.propertyCity}|${p.propertyState}`)).size

  return (
    <div className="flex flex-col h-[calc(100dvh-4rem)] -m-4 sm:-m-6 lg:-m-8">
      {/* Header strip */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-border flex-shrink-0">
        <div className="flex items-baseline gap-4">
          <h1 className="text-sm font-medium tracking-tight text-foreground">Atlas</h1>
          <span className="mono-label">Portfolio geography</span>
        </div>
        {!loading && !error && (
          <div className="mono-label">
            {points.length} properties · {cities} markets
          </div>
        )}
      </div>

      {/* Globe */}
      <div className="relative flex-1 min-h-0 bg-black">
        {error ? (
          <div className="absolute inset-0 flex items-center justify-center text-foreground-tertiary text-sm">
            {error}
          </div>
        ) : (
          <GlobeInner points={points} />
        )}
        {!loading && !error && points.length === 0 && (
          <div className="absolute bottom-6 left-1/2 -translate-x-1/2 mono-label text-center pointer-events-none">
            No geocoded reports yet — run a Property Search to plot deals
          </div>
        )}
      </div>
    </div>
  )
}
