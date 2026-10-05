'use client'

import { useState } from 'react'
import { Input } from '@/components/ui/input'

/**
 * Numeric input that owns its text while focused.
 *
 * Rewriting `value` from the parsed number on every keystroke moves the caret
 * ("typing backwards") and makes a field impossible to clear. Here the typed
 * text stays as typed; each valid number is committed as it appears, so 0 is
 * a value like any other. Leaving the field empty restores the last value, so
 * a setting is never zeroed by accident.
 */
export function DraftNumberInput({
  value, min = 0, max, step, disabled, integer, onCommit, className, title, 'aria-label': ariaLabel,
}: {
  value: number
  min?: number
  max?: number
  step?: number
  disabled?: boolean
  /** Whole numbers only */
  integer?: boolean
  onCommit: (v: number) => void
  className?: string
  title?: string
  'aria-label'?: string
}) {
  const [draft, setDraft] = useState<string | null>(null)
  return (
    <Input
      type="number"
      inputMode={integer ? 'numeric' : 'decimal'}
      min={min}
      max={max}
      step={step}
      value={draft ?? String(value)}
      disabled={disabled}
      title={title}
      aria-label={ariaLabel}
      onChange={(e) => {
        const raw = e.target.value
        setDraft(raw)
        if (raw === '') return // clearing is legal · nothing commits until a number is typed
        const v = integer ? parseInt(raw, 10) : parseFloat(raw)
        if (!isNaN(v) && v >= min && (max == null || v <= max)) onCommit(v)
      }}
      onBlur={() => setDraft(null)}
      className={className}
    />
  )
}
