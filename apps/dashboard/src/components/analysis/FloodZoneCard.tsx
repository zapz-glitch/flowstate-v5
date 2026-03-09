import { Droplets } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { FloodZoneData } from './shared-types'

export function FloodZoneCard({ floodZone }: { floodZone: FloodZoneData }) {
  return (
    <div className="rounded-2xl overflow-hidden border border-border px-6 py-4">
      <div className="flex items-center gap-3 mb-3">
        <div className="w-8 h-8 rounded-lg bg-blue-500/10 flex items-center justify-center">
          <Droplets className="w-4 h-4 text-blue-600" />
        </div>
        <h3 className="text-body font-semibold">Flood Zone</h3>
      </div>
      <div className="flex items-center gap-4 text-body-sm">
        {floodZone.zone && <span>Zone: <span className="font-medium">{floodZone.zone}</span></span>}
        <span>
          In Flood Zone:{' '}
          <span className={cn('font-medium', floodZone.inFloodZone ? 'text-red-600' : 'text-emerald-600')}>
            {floodZone.inFloodZone ? 'Yes' : 'No'}
          </span>
        </span>
      </div>
      {floodZone.description && <p className="text-caption text-foreground-tertiary mt-1.5">{floodZone.description}</p>}
    </div>
  )
}
