export const FILTER_TYPE_LABELS: Record<string, string> = {
  subdivision_match: 'Subdivision Match',
  building_style_match: 'Building Style',
  sale_age: 'Sale Age',
  sqft_diff: 'Sqft Difference',
  year_built_diff: 'Year Built Diff',
  distance: 'Distance',
}

export const ADJUSTMENT_TYPE_LABELS: Record<string, string> = {
  old_comp_discount: 'Old Comp Discount',
  bedroom: 'Bedroom Adjustment',
  bathroom: 'Bathroom Adjustment',
  pool: 'Pool Adjustment',
  garage: 'Garage Adjustment',
  carport: 'Carport Adjustment',
}

export function formatFilterType(type: string): string {
  return FILTER_TYPE_LABELS[type] || type.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

export function formatAdjustmentType(type: string): string {
  return ADJUSTMENT_TYPE_LABELS[type] || type.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

export function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount)
}

export function normalizeSubdivision(sub: string | null | undefined): string {
  if (!sub) return ''
  return sub.toLowerCase().trim().replace(/\s+/g, ' ')
}

export function getCompKey(comp: { address?: string }, index: number): string {
  return comp.address || `comp-${index}`
}

/** Format a number with commas, returning '-' for null/NaN */
export function fmtNumber(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return '-'
  return v.toLocaleString()
}

/** Format a date string as "Mar 15, 2024" */
export function formatShortDate(date: string | null | undefined): string {
  if (!date) return '-'
  return new Date(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

/** Format a numeric delta as "+1,200" or "-300" */
export function fmtDelta(diff: number): string {
  return diff > 0 ? `+${diff.toLocaleString()}` : diff.toLocaleString()
}

/** Sqft match quality color class: green (≤10%), neutral (≤20%), red (>20%) */
export function sqftMatchColor(compSf: number, subSf: number): string {
  const pct = Math.abs(compSf - subSf) / subSf
  if (pct <= 0.10) return 'text-emerald-500'
  if (pct <= 0.20) return 'text-foreground-tertiary'
  return 'text-red-400'
}

/** Lot-size match quality color class — deltas in sqft vs lot_size_diff default (±2,500 sf) */
export function lotMatchColor(compAcres: number, subAcres: number): string {
  const diffSf = Math.abs(compAcres - subAcres) * 43560
  if (diffSf <= 2500) return 'text-emerald-500'
  if (diffSf <= 5000) return 'text-foreground-tertiary'
  return 'text-red-400'
}

/** Format a lot-size delta in sqft as "+2,310 sf" */
export function fmtLotDelta(compAcres: number, subAcres: number): string {
  const diffSf = Math.round((compAcres - subAcres) * 43560)
  return diffSf > 0 ? `+${diffSf.toLocaleString()} sf` : `${diffSf.toLocaleString()} sf`
}

/** Year-built match quality color class */
export function yearMatchColor(compYr: number, subYr: number): string {
  if (compYr <= 1940 && subYr <= 1940) return 'text-emerald-500'
  const diff = Math.abs(compYr - subYr)
  if (diff <= 5) return 'text-emerald-500'
  if (diff <= 10) return 'text-foreground-tertiary'
  return 'text-red-400'
}
