import { AlertTriangle, Droplets, FileCheck } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import type { FloodZoneData } from './shared-types'

interface PermitsData {
  count?: number
  totalValue?: number
  recentTypes?: string[]
}

interface RiskFloodCardProps {
  riskFlags?: string[] | null
  floodZone?: FloodZoneData | null
  permits?: PermitsData | null
}

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount)
}

export function RiskFloodCard({ riskFlags, floodZone, permits }: RiskFloodCardProps) {
  const hasRiskFlags = riskFlags && riskFlags.length > 0
  const hasFloodZone = !!floodZone
  const hasPermits = permits && (permits.count || permits.recentTypes?.length)

  if (!hasRiskFlags && !hasFloodZone && !hasPermits) return null

  return (
    <div className="overflow-hidden border border-border px-6 py-4 space-y-4">
      {hasFloodZone && (
        <div>
          <div className="flex items-center gap-2.5 mb-2">
            <Droplets className="w-4 h-4 text-blue-600" />
            <span className="text-body-sm font-medium">Flood Zone</span>
            {floodZone.source === 'listing' && (
              <Badge variant="outline" className="bg-secondary text-foreground-secondary border-border text-[10px]">
                Listing estimate — not FEMA
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-4 text-body-sm">
            {floodZone.zone && (
              <span>
                {floodZone.source === 'listing' ? 'Risk' : 'Zone'}: <span className="font-medium">{floodZone.zone}</span>
              </span>
            )}
            <span>
              {floodZone.source === 'listing' ? 'Elevated Risk' : 'In Flood Zone'}:{' '}
              <span className={cn('font-medium', floodZone.inFloodZone ? 'text-red-600' : 'text-emerald-600')}>
                {floodZone.inFloodZone ? 'Yes' : 'No'}
              </span>
            </span>
          </div>
          {floodZone.description && <p className="text-caption text-foreground-tertiary mt-1">{floodZone.description}</p>}
        </div>
      )}

      {hasPermits && hasFloodZone && <div className="border-t border-border" />}

      {hasPermits && (
        <div>
          <div className="flex items-center gap-2.5 mb-2">
            <FileCheck className="w-4 h-4 text-foreground-secondary" />
            <span className="text-body-sm font-medium">Building Permits</span>
          </div>
          <div className="flex items-center gap-4 text-body-sm">
            {permits.count != null && (
              <span>
                Permits: <span className="font-medium">{permits.count}</span>
              </span>
            )}
            {permits.totalValue != null && permits.totalValue > 0 && (
              <span>
                Total Value: <span className="font-medium">{formatCurrency(permits.totalValue)}</span>
              </span>
            )}
          </div>
          {permits.recentTypes && permits.recentTypes.length > 0 && (
            <div className="flex flex-wrap gap-2 mt-2">
              {permits.recentTypes.map((type, i) => (
                <Badge key={i} variant="outline" className="bg-secondary text-foreground-secondary border-border">
                  {type}
                </Badge>
              ))}
            </div>
          )}
        </div>
      )}

      {hasRiskFlags && (hasFloodZone || hasPermits) && <div className="border-t border-border" />}

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
