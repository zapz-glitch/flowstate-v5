import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import type { ClassificationSummary } from './shared-types'

function getClassificationStyle(type: string) {
  switch (type) {
    case 'as_is':
      return 'bg-orange-500/10 text-orange-700 border-orange-500/30'
    case 'after_renovation':
      return 'bg-emerald-500/10 text-emerald-700 border-emerald-500/30'
    case 'transitional':
      return 'bg-blue-500/10 text-blue-700 border-blue-500/30'
    default:
      return 'bg-gray-500/10 text-gray-700 border-gray-500/30'
  }
}

function getClassificationLabel(type: string) {
  switch (type) {
    case 'as_is':
      return 'As-Is'
    case 'after_renovation':
      return 'Renovated'
    case 'transitional':
      return 'Transitional'
    default:
      return type
  }
}

export function ClassificationBadge({
  classification,
  showConfidence = false,
}: {
  classification: ClassificationSummary | null | undefined
  showConfidence?: boolean
}) {
  if (!classification) return null

  return (
    <Badge variant="outline" className={cn('font-medium', getClassificationStyle(classification.type))}>
      {getClassificationLabel(classification.type)}
      {showConfidence && classification.confidence > 0 && (
        <span className="ml-1 opacity-70">({classification.confidence}%)</span>
      )}
    </Badge>
  )
}
