import { AlertTriangle } from 'lucide-react'
import { Badge } from '@/components/ui/badge'

export function RiskFlagsCard({ riskFlags }: { riskFlags: string[] }) {
  return (
    <div className="rounded-2xl overflow-hidden border border-border px-6 py-4">
      <div className="flex items-center gap-3 mb-3">
        <div className="w-8 h-8 rounded-lg bg-amber-500/10 flex items-center justify-center">
          <AlertTriangle className="w-4 h-4 text-amber-600" />
        </div>
        <h3 className="text-body font-semibold text-amber-600">Risk Flags</h3>
      </div>
      <div className="flex flex-wrap gap-2">
        {riskFlags.map((flag, i) => (
          <Badge key={i} variant="outline" className="bg-amber-500/10 text-amber-700 border-amber-500/30">
            {flag}
          </Badge>
        ))}
      </div>
    </div>
  )
}
