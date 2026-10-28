/**
 * Clef is the condition reader (owner, 2026-10-28): with
 * CONDITION_READER=clef the subject tier comes from Clef first, even when a
 * reasoning key (Haiku) is configured — Haiku is only the backup for a split
 * Clef read. Comps classify per comp inside the listing gather, never
 * deferred to a Haiku pool read.
 */
import assert from 'node:assert/strict'
import { assessRenovationFromPhotos } from '../src/services/vision/renovation'
import { compClassifyDeferred } from '../src/services/clef'

let anthropicCalls = 0
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = String(input)
  if (url.includes('anthropic.com') || url.includes('openrouter.ai')) { anthropicCalls++; return new Response('{}', { status: 500 }) }
  return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), { headers: { 'content-type': 'image/jpeg' } })
}) as typeof fetch

let clefCalls = 0
const env = {
  CONDITION_READER: 'clef',
  ANTHROPIC_API_KEY: 'present',
  AI: {
    run: async () => {
      clefCalls++
      return { answers: { renovation_level: { choice: 'Light Cosmetic', probabilities: { 'Light Cosmetic': 0.8, 'Full Cosmetic': 0.2 } } } }
    },
  },
} as never

const read = await assessRenovationFromPhotos(env, ['https://p/1.jpg', 'https://p/2.jpg', 'https://p/3.jpg', 'https://p/4.jpg', 'https://p/5.jpg'], { address: '1715 1st St, Ruskin, FL' })
assert.ok(clefCalls > 0, 'Clef reads the subject')
assert.equal(anthropicCalls, 0, 'Haiku is not asked when Clef answers clearly')
assert.equal(read.renovationLevel, 'Light Cosmetic')

// Comps: Clef classifies inside the gather; Decisions/Haiku defer to a pool read.
assert.equal(compClassifyDeferred({ CONDITION_READER: 'clef', ANTHROPIC_API_KEY: 'k', AI: { run: async () => ({}) } } as never), false)
assert.equal(compClassifyDeferred({ CONDITION_READER: 'decisions', OPENAI_API_KEY: 'k' } as never), true)
assert.equal(compClassifyDeferred({ ANTHROPIC_API_KEY: 'k' } as never), true)
assert.equal(compClassifyDeferred({ CONDITION_READER: 'clef', ANTHROPIC_API_KEY: 'k' } as never), true, 'no Workers AI binding → Clef cannot read; keep the old path')

console.log('condition reader clef: passed')
