import { AlertTriangle, Droplets } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import type { FloodZoneData } from './shared-types'

interface RiskFloodCardProps {
  riskFlags?: string[] | null
  floodZone?: FloodZoneData | null
}

export function RiskFloodCard({ riskFlags, floodZone }: RiskFloodCardProps) {
  const hasRiskFlags = riskFlags && riskFlags.length > 0
  const hasFloodZone = !!floodZone

  if (!hasRiskFlags && !hasFloodZone) return null

  return (
    <div className="rounded-xl overflow-hidden border border-border px-6 py-4 space-y-4">
      {hasFloodZone && (
        <div>
          <div className="flex items-center gap-2.5 mb-2">
            <Droplets className="w-4 h-4 text-blue-600" />
            <span className="text-body-sm font-medium">Flood Zone</span>
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
          {floodZone.description && <p className="text-caption text-foreground-tertiary mt-1">{floodZone.description}</p>}
        </div>
      )}

      {hasRiskFlags && hasFloodZone && <div className="border-t border-border" />}

      {hasRiskFlags && (
        <div>
          <div className="flex items-center gap-2.5 mb-2">
            <AlertTriangle className="w-4 h-4 text-amber-600" />
            <span className="text-body-sm font-medium text-amber-600">Risk Flags</span>
          </div>
          <div className="flex flex-wrap gap-2">
            {riskFlags.map((flag, i) => (
              <Badge key={i} variant="outline" className="bg-amber-500/10 text-amber-700 border-amber-500/30">
                {flag}
              </Badge>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
