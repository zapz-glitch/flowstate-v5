import { cleanAddress } from './flowstate-url.js'

// Finds the property address for a page. `page` is what the probe in
// background.js collects: { selection, jsonLd: string[], headings: string[] }.
export function pickAddress(page) {
  const selection = cleanAddress(page?.selection)
  if (selection) return { address: selection, source: 'selection' }
  for (const raw of page?.jsonLd ?? []) {
    const address = fromStructuredData(raw)
    if (address) return { address, source: 'listing data' }
  }
  for (const text of page?.headings ?? []) {
    const match = US_ADDRESS.exec(cleanAddress(text))
    if (match) return { address: match[0], source: 'page title' }
  }
  return null
}

// "910 E Eskimo Ave, Tampa, FL 33604" inside a longer title.
const US_ADDRESS = /\b\d{1,6}[A-Za-z]?\s[^,|]{2,60},\s?[^,|\d]{2,40},\s?[A-Z]{2}\s\d{5}(?:-\d{4})?\b/

// Listing sites publish schema.org data; the property is the node whose
// street line starts with a house number (an agent's office may be a PO box).
function fromStructuredData(raw) {
  let data
  try {
    data = JSON.parse(raw)
  } catch {
    return null
  }
  const queue = [data]
  for (let seen = 0; queue.length && seen < 2000; seen++) {
    const node = queue.shift()
    if (!node || typeof node !== 'object') continue
    const a = node.address
    if (a && typeof a === 'object' && /^\d/.test(String(a.streetAddress ?? '').trim()) && a.addressLocality && a.addressRegion) {
      return cleanAddress(`${a.streetAddress}, ${a.addressLocality}, ${a.addressRegion} ${a.postalCode ?? ''}`)
    }
    queue.push(...Object.values(node))
  }
  return null
}
