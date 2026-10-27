/**
 * Subject tier reader chain — a dead decision model must not leave the
 * subject at the default rehab tier while Clef is up. Seen on the
 * 7462 Watersilk Dr e2e (2026-10-26): Decisions 401, no reasoning key,
 * Clef never asked → status 'unavailable' on 16 photos.
 */
import assert from 'node:assert/strict'
import { assessRenovationFromPhotos } from '../src/services/vision/renovation'

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = String(input)
  if (url.includes('openai.com')) return new Response('{"error":{"message":"Incorrect API key"}}', { status: 401 })
  return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), { headers: { 'content-type': 'image/jpeg' } })
}) as typeof fetch

let clefCalls = 0
const env = {
  CONDITION_READER: 'decisions',
  OPENAI_API_KEY: 'bad',
  REASONING_PROVIDER: 'off',
  AI: {
    run: async () => {
      clefCalls++
      return { answers: { renovation_level: { choice: 'Light Cosmetic', probabilities: { 'Light Cosmetic': 0.8, 'Full Cosmetic': 0.2 } } } }
    },
  },
} as never

const read = await assessRenovationFromPhotos(env, ['https://p/1.jpg', 'https://p/2.jpg', 'https://p/3.jpg', 'https://p/4.jpg', 'https://p/5.jpg'], { address: '7462 Watersilk Dr N' })
assert.ok(clefCalls > 0, 'Clef is asked when the decision model fails')
assert.notEqual(read.status, 'unavailable')
assert.equal(read.renovationLevel, 'Light Cosmetic')

console.log('renovation reader fallback: passed')
