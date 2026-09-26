export function formatValuationNumber(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? '-' : value.toLocaleString('en-US', { maximumFractionDigits: 0 })
}

/** Money display — nearest $1,000 for clean valuation numbers. */
export function formatMoneyThousands(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value)
    ? '-'
    : (Math.round(value / 1000) * 1000).toLocaleString('en-US', { maximumFractionDigits: 0 })
}
