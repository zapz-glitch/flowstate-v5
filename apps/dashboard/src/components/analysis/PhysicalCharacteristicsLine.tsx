import { cn } from '@/lib/utils'
import type { PhysicalCharacteristic, PhysicalCharacteristics, PhysicalCharacteristicValue } from './shared-types'

const FIELDS: Array<{ key: keyof PhysicalCharacteristics; label: string }> = [
  { key: 'style', label: 'Style' },
  { key: 'stories', label: 'Stories' },
  { key: 'constructionType', label: 'Construction Type' },
  { key: 'exterior', label: 'Exterior' },
  { key: 'roof', label: 'Roof' },
  { key: 'foundation', label: 'Foundation' },
  { key: 'garage', label: 'Garage' },
  { key: 'pool', label: 'Pool' },
]

function displayValue(value: PhysicalCharacteristicValue): string {
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  return String(value)
}

function sourceTitle(field: PhysicalCharacteristic): string | undefined {
  if (field.sources.length === 0) return undefined
  return field.sources.map(({ source, value }) => `${source}: ${displayValue(value)}`).join(' · ')
}

export function PhysicalCharacteristicsLine({
  characteristics,
  label,
}: {
  characteristics?: PhysicalCharacteristics | null
  label: string
}) {
  // Show what is known · a verified value or a source conflict. A field with
  // neither says nothing, so it is left out instead of drawing a dash.
  const shown = FIELDS.flatMap(({ key, label: fieldLabel }) => {
    const field = characteristics?.[key]
    if (!field) return []
    const conflict = field.status === 'conflict'
    const value = field.status === 'verified' && field.value != null ? displayValue(field.value) : null
    return conflict || value ? [{ key, fieldLabel, field, conflict, value }] : []
  })
  if (shown.length === 0) return null

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px]" aria-label={label}>
      {shown.map(({ key, fieldLabel, field, conflict, value }) => (
        <span key={key} className="inline-flex items-baseline gap-1 min-w-0">
          <span className="text-foreground-tertiary">{fieldLabel}</span>
          <span
            className={cn('font-medium truncate capitalize', conflict && 'text-amber-600 dark:text-amber-400')}
            title={sourceTitle(field)}
          >
            {conflict ? 'Conflict' : value}
          </span>
        </span>
      ))}
    </div>
  )
}
