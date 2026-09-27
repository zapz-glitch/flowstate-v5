/**
 * Seller notes — Close conversation-log fetch + rehab classification.
 *
 * The note fetch must never break an eval (errors → empty), must filter to
 * FLOWSTATE CONVERSATION LOG notes only, and must split each note body into
 * dated entries. Classification is strictly asymmetric: additions are gated
 * to known major-item ids not already charged; removal signals surface only
 * as advisories — notes can never silently shrink the rehab ledger.
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  fetchSellerNotes,
  classifyRehabIntel,
  additionToMajorItem,
} from '../src/services/seller-notes'
import type { Env } from '../src/types'

const realFetch = globalThis.fetch

function stubFetch(handler: (url: string) => { status: number; body: unknown }) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const { status, body } = handler(url)
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
}

const closeNote = (note: string, id = 'acti_x') => ({
  id,
  _type: 'Note',
  date_created: '2026-09-25T21:46:55.928000+00:00',
  title: null,
  note,
})

describe('fetchSellerNotes', () => {
  beforeEach(() => {})
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  it('returns [] without an API key or leadId', async () => {
    assert.deepEqual(await fetchSellerNotes(undefined, 'lead_1'), [])
    assert.deepEqual(await fetchSellerNotes('key', undefined), [])
  })

  it('keeps only conversation-log notes and splits dated entries', async () => {
    stubFetch(() => ({
      status: 200,
      body: {
        data: [
          closeNote('FLOWSTATE CONVERSATION LOG\n -2026-09-25 move-in ready, no known issues\n -2026-09-24 seller holding firm'),
          closeNote('unrelated note — no marker', 'acti_other'),
          closeNote('[flowstate-conversation-log:v1]\n -2026-09-23 roof 2009, no leaks', 'acti_tag'),
        ],
      },
    }))
    const notes = await fetchSellerNotes('k', 'lead_1')
    assert.equal(notes.length, 3)
    assert.equal(notes[0].text, '2026-09-25 move-in ready, no known issues')
    assert.equal(notes[1].text, '2026-09-24 seller holding firm')
    assert.equal(notes[2].text, '2026-09-23 roof 2009, no leaks')
    assert.equal(notes[0].id, 'acti_x')
  })

  it('returns [] on HTTP errors and malformed bodies', async () => {
    stubFetch(() => ({ status: 500, body: { error: 'down' } }))
    assert.deepEqual(await fetchSellerNotes('k', 'lead_1'), [])

    globalThis.fetch = (async () => { throw new Error('network') }) as typeof fetch
    assert.deepEqual(await fetchSellerNotes('k', 'lead_1'), [])
  })
})

describe('classifyRehabIntel', () => {
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  const env = { OPENROUTER_API_KEY: 'test-key' } as Env
  const chargedRoof = [{ id: 'roof', name: 'Roof', cost: 10000, reason: 'permit' }]

  it('returns empty without an OpenRouter key or notes', async () => {
    assert.deepEqual(await classifyRehabIntel({} as Env, [{ id: 'a', createdAt: '', text: 'x' }], []), { additions: [], advisories: [] })
    assert.deepEqual(await classifyRehabIntel(env, [], []), { additions: [], advisories: [] })
  })

  it('accepts additions only for known, uncharged items', async () => {
    stubFetch(() => ({
      status: 200,
      body: {
        choices: [{
          message: {
            role: 'assistant',
            content: JSON.stringify({
              additions: [
                { itemId: 'hvac', estimatedCost: 8000, evidence: 'AC is dead' },
                { itemId: 'roof', estimatedCost: 10000, evidence: 'dup — already charged' },
                { itemId: 'bogus_id', estimatedCost: 1, evidence: 'not a real item' },
              ],
              advisories: [
                { itemId: 'roof', suggestion: 'consider_removing', note: 'roof replaced 2019', evidence: 'roof 2019, no leaks' },
                { itemId: 'hvac', suggestion: 'consider_removing', note: 'not charged', evidence: 'x' },
              ],
            }),
          },
        }],
      },
    }))
    const r = await classifyRehabIntel(
      env,
      [{ id: 'n1', createdAt: '', text: 'roof 2019, no leaks; AC is dead' }],
      chargedRoof,
    )
    assert.equal(r.additions.length, 1)
    assert.equal(r.additions[0].itemId, 'hvac')
    assert.equal(r.additions[0].estimatedCost, 8000)
    assert.equal(r.advisories.length, 1)
    assert.equal(r.advisories[0].itemId, 'roof')
    assert.equal(r.advisories[0].suggestion, 'consider_removing')
  })

  it('returns empty on a malformed LLM response', async () => {
    stubFetch(() => ({
      status: 200,
      body: { choices: [{ message: { role: 'assistant', content: 'not json at all' } }] },
    }))
    const r = await classifyRehabIntel(env, [{ id: 'n1', createdAt: '', text: 'x' }], chargedRoof)
    assert.deepEqual(r, { additions: [], advisories: [] })
  })

  it('maps a classified addition onto a valuation major item', () => {
    const item = additionToMajorItem({
      itemId: 'hvac',
      item: 'HVAC',
      estimatedCost: 8000,
      evidence: 'AC is dead',
    })
    assert.equal(item?.id, 'hvac')
    assert.equal(item?.enabled, true)
    assert.equal(item?.cost, 8000)
    assert.match(item!.reason, /Realtor note: AC is dead/)
    assert.equal(additionToMajorItem({ itemId: null, item: 'X', estimatedCost: 1, evidence: 'e' }), null)
  })
})
