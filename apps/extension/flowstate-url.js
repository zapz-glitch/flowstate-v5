export const DEFAULT_BASE_URL = 'https://app.flowstate.homes'

// Selections copied off a listing often span lines or carry non-breaking spaces.
export function cleanAddress(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim()
}

// Returns the dashboard origin, the default when blank, or null when unusable.
export function normalizeBaseUrl(input) {
  const raw = String(input ?? '').trim()
  if (!raw) return DEFAULT_BASE_URL
  const isLocal = /^(localhost|127\.0\.0\.1)(:|\/|$)/i.test(raw)
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `${isLocal ? 'http' : 'https'}://${raw}`
  try {
    const url = new URL(withScheme)
    return url.hostname.includes('.') || url.hostname === 'localhost' ? url.origin : null
  } catch {
    return null
  }
}

export function buildAnalyzeUrl(baseUrl, selection) {
  const address = cleanAddress(selection)
  if (!address) return null
  const base = normalizeBaseUrl(baseUrl) ?? DEFAULT_BASE_URL
  return `${base}/dashboard/analyze?address=${encodeURIComponent(address)}`
}
