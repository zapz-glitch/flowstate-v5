import type { ValuationData } from './shared-types'

export function formatHeadlineMoney(
  exact: number | null | undefined,
  displayed: number | null | undefined,
  policy?: ValuationData['displayRounding'],
): string {
  if (displayed != null && Number.isFinite(displayed)) {
    return displayed.toLocaleString('en-US', { maximumFractionDigits: 0 })
  }
  if (exact == null || !Number.isFinite(exact)) return '-'
  const amount = policy?.mode === 'half_up' && (policy.increment === 500 || policy.increment === 1000)
    ? Math.sign(exact) * Math.round(Math.abs(exact) / policy.increment) * policy.increment
    : exact
  return amount.toLocaleString('en-US', { maximumFractionDigits: 0 })
}
