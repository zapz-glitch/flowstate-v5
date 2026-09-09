export type ListingSource = 'zillow' | 'redfin' | 'realtor'
export type ListingAddress = { address: string; city: string; state: string; zipCode: string }
const aliases: Record<string, string> = { street: 'st', court: 'ct', road: 'rd', drive: 'dr', avenue: 'ave', boulevard: 'blvd', lane: 'ln', place: 'pl', circle: 'cir', parkway: 'pkwy', pky: 'pkwy', terrace: 'ter', trail: 'trl', highway: 'hwy', expressway: 'expy', freeway: 'fwy', turnpike: 'tpke', north: 'n', south: 's', east: 'e', west: 'w', florida: 'fl' }
const stateNames: Record<string, string> = {
  alabama: 'al', alaska: 'ak', arizona: 'az', arkansas: 'ar', california: 'ca', colorado: 'co', connecticut: 'ct', delaware: 'de', florida: 'fl', georgia: 'ga', hawaii: 'hi', idaho: 'id', illinois: 'il', indiana: 'in', iowa: 'ia', kansas: 'ks', kentucky: 'ky', louisiana: 'la', maine: 'me', maryland: 'md', massachusetts: 'ma', michigan: 'mi', minnesota: 'mn', mississippi: 'ms', missouri: 'mo', montana: 'mt', nebraska: 'ne', nevada: 'nv', 'new hampshire': 'nh', 'new jersey': 'nj', 'new mexico': 'nm', 'new york': 'ny', 'north carolina': 'nc', 'north dakota': 'nd', ohio: 'oh', oklahoma: 'ok', oregon: 'or', pennsylvania: 'pa', 'rhode island': 'ri', 'south carolina': 'sc', 'south dakota': 'sd', tennessee: 'tn', texas: 'tx', utah: 'ut', vermont: 'vt', virginia: 'va', washington: 'wa', 'west virginia': 'wv', wisconsin: 'wi', wyoming: 'wy', 'district of columbia': 'dc', 'puerto rico': 'pr', 'us virgin islands': 'vi', 'virgin islands': 'vi', guam: 'gu', 'american samoa': 'as', 'northern mariana islands': 'mp',
}
export const normalizeListingText = (v: unknown): string => typeof v === 'string' ? v.toLowerCase().replace(/\./g, '').replace(/,/g, ' ').trim().replace(/\s+/g, ' ').split(/\s+/).map(w => aliases[w] ?? w).join(' ') : ''
export function normalizeListingState(value: unknown): string {
  const state = typeof value === 'string' ? value.toLowerCase().replace(/\./g, '').trim().replace(/\s+/g, ' ') : ''
  return stateNames[state] ?? state
}
const domains: Record<ListingSource, string[]> = { zillow: ['zillow.com', 'www.zillow.com'], redfin: ['redfin.com', 'www.redfin.com'], realtor: ['realtor.com', 'www.realtor.com'] }
export function safeListingUrl(value: unknown, source: ListingSource): string | null {
  try { const u = new URL(String(value)); return u.protocol === 'https:' && !u.username && !u.password && !u.port && domains[source].includes(u.hostname) ? u.href : null } catch { return null }
}
export function isListingPropertyUrl(value: unknown, source: ListingSource): boolean {
  const safe = safeListingUrl(value, source)
  if (!safe) return false
  const path = new URL(safe).pathname
  return source === 'redfin' ? /\/home\/\d+\/?$/.test(path) : source === 'realtor' ? /^\/realestateandhomes-detail\//.test(path) : /\/(?:homedetails|homes)\//.test(path)
}
export function safeListingPhoto(value: unknown, source: ListingSource): value is string {
  try {
    const u = new URL(String(value))
    if (u.protocol !== 'https:' || u.username || u.password || u.port) return false
    if (/logo|agent|avatar|profile|map|floorplan|icon/i.test(u.pathname)) return false
    return source === 'zillow' ? u.hostname === 'photos.zillowstatic.com' && u.pathname.startsWith('/fp/')
      : source === 'redfin' ? u.hostname === 'ssl.cdn-redfin.com' && u.pathname.startsWith('/photo/')
      : u.hostname === 'ap.rdcpix.com' && /\.(?:jpg|jpeg|webp|png)$/i.test(u.pathname)
  } catch { return false }
}
export function safeListingScreenshot(value: unknown): value is string {
  try {
    const u = new URL(String(value))
    return u.protocol === 'https:' && !u.username && !u.password && !u.port && u.hostname === 'storage.googleapis.com' && /^\/firecrawl-scrape-media\/screenshot-[\w-]+\.(?:png|jpg|webp)$/.test(u.pathname)
  } catch { return false }
}
export function hasListingHeading(property: ListingAddress, markdown: string): boolean {
  const lines = markdown.split('\n'), start = lines.findIndex(line => /^#\s+/.test(line))
  if (start < 0) return false
  const heading = normalizeListingText(lines[start].replace(/^#\s+/, ''))
  const street = normalizeListingText(property.address)
  const state = normalizeListingState(property.state)
  const stateVariants = [state, ...Object.entries(stateNames).filter(([, code]) => code === state).map(([name]) => name)]
  const localities = stateVariants.map(variant => normalizeListingText(`${property.city} ${variant} ${property.zipCode.slice(0, 5)}`))
  if (localities.some(locality => heading === `${street} ${locality}`)) return true
  // Some listing pages split street and locality over adjacent heading lines.
  return heading === street && lines.slice(start + 1, start + 5).some(line => localities.includes(normalizeListingText(line.replace(/^#+\s*/, ''))))
}
export function blockedListingPage(markdown: string): boolean {
  return /(?:press (?:and|&) hold|verify (?:you are|you're) human|access denied|captcha|unusual traffic|request blocked|pardon our interruption)/i.test(markdown.slice(0, 3000))
}
export function primaryListingPhotoUrls(markdown: string): Set<string> {
  // Related-home carousels can reuse the same image host as the primary listing.
  const boundary = /(?:^|\n)\s*(?:#{1,6}\s+)?(?:Nearby homes|Comparable homes|Similar homes|Recently sold(?: homes)?|Recommended homes|You may also like|Price history|Property history|Sale and tax history)(?:\s|$)/i.exec(markdown)?.index
  const main = boundary === undefined ? markdown : markdown.slice(0, boundary)
  return new Set([...main.matchAll(/!\[[^\]]*\]\((https:\/\/[^\s)]+)(?:\s+"[^"]*")?\)/g)].map(match => match[1]))
}
export function isCompletedListingEvent(value: unknown): boolean {
  if (typeof value !== 'string') return false
  return /^sold(?:\s+(?:public records?|stellar\s?mls))?$/i.test(value.replace(/\s*\((?:MLS|Closed)\)/gi, '').trim())
}
export function corroborateListingSale(property: ListingAddress, sale: { date: string; price: number }, markdown: string): string | null {
  if (!hasListingHeading(property, markdown) || blockedListingPage(markdown)) return null
  const history = /(?:^|\n)#{2,3}\s+(?:(?:Price|Sale|Sales|Property) history|Sale and tax history(?: for [^\n]+)?)\s*\n([\s\S]*?)(?=\n#{1,2} |$)/i.exec(markdown)?.[1]
  if (!history) return null
  const [year, month, day] = sale.date.split('-')
  const datePatterns = [new RegExp(`\\b${year}-${month}-${day}\\b`), new RegExp(`\\b0?${Number(month)}/0?${Number(day)}/${year}\\b`), new RegExp(`\\b${['Jan(?:uary)?', 'Feb(?:ruary)?', 'Mar(?:ch)?', 'Apr(?:il)?', 'May', 'Jun(?:e)?', 'Jul(?:y)?', 'Aug(?:ust)?', 'Sep(?:tember)?', 'Oct(?:ober)?', 'Nov(?:ember)?', 'Dec(?:ember)?'][Number(month) - 1]}\\s+0?${Number(day)},?\\s+${year}\\b`, 'i')]
  const lines = history.split('\n').map(line => line.trim()).filter(Boolean)
  for (let i = 0; i < lines.length; i++) {
    const row = lines[i]
    // Redfin renders date, event and amount on consecutive lines rather than a table.
    if (datePatterns.some(pattern => pattern.test(row)) && isCompletedListingEvent(lines[i + 1]) && /^\$[\d,]+(?:\.\d{2})?$/.test(lines[i + 2] ?? '')) {
      if (Number(lines[i + 2].slice(1).replace(/,/g, '')) === sale.price) return lines.slice(i, i + 3).join('\n')
    }
    if (!row.split('|').some(cell => isCompletedListingEvent(cell.trim())) || !datePatterns.some(pattern => pattern.test(row))) continue
    const prices = [...row.matchAll(/\$([\d,]+(?:\.\d{2})?)/g)].map(match => Number(match[1].replace(/,/g, '')))
    if (prices[0] === sale.price) return row.slice(0, 300)
  }
  return null
}
