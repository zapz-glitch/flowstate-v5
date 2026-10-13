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

// The API host pairs with the dashboard host: app.* → api.*, local dev → :8787.
export function apiUrlFor(baseUrl, override) {
  const explicit = String(override ?? '').trim() ? normalizeBaseUrl(override) : null
  if (explicit) return explicit
  const base = new URL(normalizeBaseUrl(baseUrl) ?? DEFAULT_BASE_URL)
  if (base.hostname === 'localhost' || base.hostname === '127.0.0.1') return 'http://localhost:8787'
  return `https://${base.hostname.replace(/^app\./, 'api.')}`
}

export function reportUrl(baseUrl, jobId) {
  return `${normalizeBaseUrl(baseUrl) ?? DEFAULT_BASE_URL}/dashboard/reports/${encodeURIComponent(jobId)}`
}

export function propertySearchUrl(baseUrl) {
  return `${normalizeBaseUrl(baseUrl) ?? DEFAULT_BASE_URL}/dashboard/analyze`
}

export function buildAnalyzeUrl(baseUrl, selection) {
  const address = cleanAddress(selection)
  if (!address) return null
  return `${propertySearchUrl(baseUrl)}?address=${encodeURIComponent(address)}`
}
