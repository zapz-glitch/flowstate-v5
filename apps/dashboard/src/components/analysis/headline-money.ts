import type { ValuationData } from './shared-types'

export function formatHeadlineMoney(
  exact: number | null | undefined,
  displayed: number | null | undefined,
  policy?: ValuationData['displayRounding'],
): string {
  // Valuation box displays everything rounded to the nearest $1,000 —
  // displayed/policy values still apply their own increment first, then
  // the final figure is normalized to the thousand.
  const raw = displayed != null && Number.isFinite(displayed)
    ? displayed
    : exact != null && Number.isFinite(exact)
      ? policy?.mode === 'half_up' && (policy.increment === 500 || policy.increment === 1000)
        ? Math.sign(exact) * Math.round(Math.abs(exact) / policy.increment) * policy.increment
        : exact
      : null
  if (raw == null) return '-'
  const amount = Math.sign(raw) * Math.round(Math.abs(raw) / 1000) * 1000
  return amount.toLocaleString('en-US', { maximumFractionDigits: 0 })
}
