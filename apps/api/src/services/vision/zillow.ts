/**
 * Zillow URL Generator
 *
 * Generates Zillow search and property URLs from property addresses.
 * Used to find property photos for vision analysis.
 */

import type { ZillowUrlParams, ZillowUrl } from './types'

// ─── URL Generation ───────────────────────────────────────────────────────────

/**
 * Format address for Zillow URL
 * Zillow uses dashes between words and underscores for address components
 */
function formatAddressForUrl(address: string): string {
  return address
    .toLowerCase()
    .replace(/[#,.']/g, '') // Remove special chars
    .replace(/\s+/g, '-') // Replace spaces with dashes
    .replace(/-+/g, '-') // Dedupe dashes
    .replace(/^-|-$/g, '') // Trim dashes
}

/**
 * Format city for Zillow URL
 */
function formatCityForUrl(city: string): string {
  return city
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
}

/**
 * Generate Zillow URLs for a property
 *
 * @example
 * generateZillowUrl({
 *   address: '123 Main St',
 *   city: 'Tampa',
 *   state: 'FL',
 *   zipCode: '33601'
 * })
 * // Returns:
 * // {
 * //   searchUrl: 'https://www.zillow.com/homes/123-main-st-tampa-fl-33601_rb/',
 * //   estimatedPropertyUrl: 'https://www.zillow.com/homedetails/123-Main-St-Tampa-FL-33601/...'
 * // }
 */
export function generateZillowUrl(params: ZillowUrlParams): ZillowUrl {
  const { address, city, state, zipCode } = params

  // Format components
  const formattedAddress = formatAddressForUrl(address)
  const formattedCity = formatCityForUrl(city)
  const formattedState = state.toLowerCase()

  // Build search URL (most reliable for finding property)
  const searchPath = `${formattedAddress}-${formattedCity}-${formattedState}-${zipCode}`
  const searchUrl = `https://www.zillow.com/homes/${searchPath}_rb/`

  // Build estimated property detail URL
  // Note: This is a guess format - actual URL includes Zillow's internal ID
  const titleCaseAddress = address
    .split(' ')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join('-')
  const titleCaseCity = city
    .split(' ')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join('-')

  const estimatedPropertyUrl = `https://www.zillow.com/homedetails/${titleCaseAddress}-${titleCaseCity}-${state.toUpperCase()}-${zipCode}`

  return {
    searchUrl,
    estimatedPropertyUrl,
  }
}

/**
 * Generate Zillow URLs for multiple properties
 */
export function generateZillowUrls(
  properties: ZillowUrlParams[]
): Map<string, ZillowUrl> {
  const urlMap = new Map<string, ZillowUrl>()

  for (const property of properties) {
    const key = `${property.address}|${property.city}|${property.state}|${property.zipCode}`
    urlMap.set(key, generateZillowUrl(property))
  }

  return urlMap
}

/**
 * Generate Google Maps Street View URL as fallback for property photos
 */
export function generateStreetViewUrl(
  latitude: number,
  longitude: number
): string {
  return `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${latitude},${longitude}`
}

/**
 * Generate Google Maps satellite URL
 */
export function generateSatelliteUrl(
  latitude: number,
  longitude: number,
  zoom: number = 19
): string {
  return `https://www.google.com/maps/@${latitude},${longitude},${zoom}z/data=!3m1!1e3`
}
