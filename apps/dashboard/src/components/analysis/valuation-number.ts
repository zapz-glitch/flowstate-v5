export function formatValuationNumber(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? '-' : value.toLocaleString('en-US', { maximumFractionDigits: 0 })
}
