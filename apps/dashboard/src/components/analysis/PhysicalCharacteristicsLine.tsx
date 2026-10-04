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
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]" aria-label={label}>
      {FIELDS.map(({ key, label: fieldLabel }, index) => {
        const field = characteristics?.[key]
        const conflict = field?.status === 'conflict'
        const value = field?.status === 'verified' && field.value != null ? displayValue(field.value) : null
        return (
          <span key={key} className="inline-flex items-center gap-1 min-w-0">
            {index > 0 && <span className="text-border">·</span>}
            <span className="text-foreground-tertiary">{fieldLabel}</span>
            <span
              className={cn(
                'font-medium truncate',
                conflict && 'text-amber-500',
                !conflict && !value && 'text-foreground-tertiary',
              )}
              title={field ? sourceTitle(field) : undefined}
            >
              {conflict ? '⚠ conflict' : value || '—'}
            </span>
          </span>
        )
      })}
    </div>
  )
}
