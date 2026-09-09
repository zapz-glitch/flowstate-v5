import { normalizeListingState, normalizeListingText } from '../evaluation/listing-source'
import type { NormalizedProperty, PropertySearchParams } from './types'

type PropertyIdentity = Pick<NormalizedProperty, 'id' | 'address' | 'city' | 'state' | 'zipCode'>
const states = new Set('AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC PR VI GU AS MP'.toLowerCase().split(' '))
const street = (value: string) => normalizeListingText(value.replace(/\b(?:apartment|apt|suite|ste|unit)\.?(?=\s|[0-9#]|$)\s*|#\s*/gi, ' unit '))
const zip = (value: string) => /^\d{5}(?:-?\d{4})?$/.test(value.trim()) ? value.trim().slice(0, 5) : ''

function fullAddress(value: string): string {
  const match = /(?:\s|,)(\d{5})(?:-\d{4})?\s*$/.exec(value)
  const zipCode = match?.[1] ?? ''
  const prefix = match ? value.slice(0, match.index).trim() : value.trim()
  const words = prefix.split(/[\s,]+/).filter(Boolean)
  for (let length = Math.min(4, words.length); length >= 1; length--) {
    const state = normalizeListingState(words.slice(-length).join(' '))
    if (states.has(state)) return street([...words.slice(0, -length), state, zipCode].filter(Boolean).join(' '))
  }
  return street([prefix, zipCode].filter(Boolean).join(' '))
}

export function verifyPropertyIdentity(request: PropertySearchParams, candidate: PropertyIdentity, expectedId?: string): { matched: boolean; reason: string } {
  const fail = (reason: string) => ({ matched: false, reason })
  if (!candidate.id?.trim() || !candidate.address?.trim()) return fail('Provider property identity is incomplete')
  if (expectedId !== undefined && candidate.id !== expectedId) return fail('Provider property ID differs from the selected property')
  if (request.streetAddress) {
    if (street(request.streetAddress) !== street(candidate.address)) return fail('Provider street address or unit differs from the requested property')
    const requestedZip = request.zipCode ? zip(request.zipCode) : ''
    const requestedState = request.state ? normalizeListingState(request.state) : ''
    if (request.zipCode && (!requestedZip || requestedZip !== zip(candidate.zipCode))) return fail('Provider ZIP differs from the requested property')
    if (request.city && normalizeListingText(request.city) !== normalizeListingText(candidate.city)) return fail('Provider city differs from the requested property')
    if (request.state && (!states.has(requestedState) || requestedState !== normalizeListingState(candidate.state))) return fail('Provider state differs from the requested property')
    if (!requestedZip && !(request.city?.trim() && states.has(requestedState))) return fail('A ZIP or city and state are required to confirm property identity')
  } else if (request.address) {
    const requested = fullAddress(request.address)
    const candidateZip = zip(candidate.zipCode), candidateState = normalizeListingState(candidate.state)
    const forms: string[] = []
    if (candidateZip) forms.push(fullAddress(`${candidate.address} ${candidateZip}`))
    if (candidate.city?.trim() && states.has(candidateState)) {
      forms.push(fullAddress(`${candidate.address} ${candidate.city} ${candidateState}`))
      if (candidateZip) forms.push(fullAddress(`${candidate.address} ${candidate.city} ${candidateState} ${candidateZip}`))
    }
    if (!forms.includes(requested)) return fail('Provider street, unit or locality does not exactly match the requested address')
    if (request.zipCode && (!zip(request.zipCode) || zip(request.zipCode) !== candidateZip)) return fail('Provider ZIP differs from the requested property')
    if (request.city && normalizeListingText(request.city) !== normalizeListingText(candidate.city)) return fail('Provider city differs from the requested property')
    if (request.state && normalizeListingState(request.state) !== candidateState) return fail('Provider state differs from the requested property')
  } else if (expectedId !== undefined) {
    return { matched: true, reason: 'Selected provider property ID matches the returned property' }
  } else return fail('A requested property address is required')
  return { matched: true, reason: 'Requested street, unit and locality match the provider property' }
}
