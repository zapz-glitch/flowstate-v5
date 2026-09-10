/**
 * Computer-Vision Renovation Assessment Tests
 *
 * Deterministic coverage via an injected mock provider — verifies level
 * mapping, structured evidence capture, and that bad/missing vision output
 * NEVER becomes an invented renovation level.
 */

import { describe, it, expect } from 'vitest'
import {
  assessRenovationFromPhotos,
  renovationLevelToIndex,
  RENOVATION_LEVEL_DEFINITIONS,
} from './renovation'

const photos = (n: number) => Array.from({ length: n }, (_, i) => `https://img.example.com/p${i}.jpg`)

const mockProvider = (response: object | string) => ({
  name: 'openrouter',
  model: 'test-model',
  execute: async () => ({
    success: true,
    data: { content: typeof response === 'string' ? response : JSON.stringify(response) },
    usage: { totalTokens: 100 },
    timing: { durationMs: 50 },
  }),
})

const failProvider = (code: string, message: string) => ({
  name: 'openrouter',
  model: 'test-model',
  execute: async () => ({
    success: false,
    error: { code, message },
  }),
})

const visionResponse = (level: string, confidence = 85, extra?: object) => ({
  renovation_level: level,
  confidence,
  major_observations: ['dated kitchen', 'worn carpet'],
  kitchen_condition: 'dated',
  bathroom_condition: 'good',
  flooring_condition: 'poor',
  wall_ceiling_condition: 'fair',
  exterior_condition: 'fair',
  visible_major_system_concerns: [],
  structural_concerns: [],
  evidence_for_classification: ['whole-property cosmetic wear'],
  evidence_against_more_severe_level: ['no structural damage visible'],
  evidence_against_less_severe_level: ['more than paint needed'],
  limitations: ['no attic photos'],
  ...extra,
})

// ─── Level mapping ────────────────────────────────────────────────────────────

describe('renovationLevelToIndex', () => {
  it('maps all five approved levels', () => {
    expect(renovationLevelToIndex('Lipstick')).toBe(0)
    expect(renovationLevelToIndex('Light Cosmetic')).toBe(1)
    expect(renovationLevelToIndex('Full Cosmetic')).toBe(2)
    expect(renovationLevelToIndex('Heavy Rehab')).toBe(3)
    expect(renovationLevelToIndex('Full Gut')).toBe(4)
    expect(renovationLevelToIndex('Down to Stud')).toBe(4)
  })

  it('returns null for unrecognized levels — never invented', () => {
    expect(renovationLevelToIndex('Moderate')).toBeNull()
    expect(renovationLevelToIndex(null)).toBeNull()
    expect(renovationLevelToIndex('')).toBeNull()
  })
})

// ─── Fixture photo-set classifications ───────────────────────────────────────

describe('renovation level classification', () => {
  const cases: Array<[string, number]> = [
    ['Lipstick', 0],
    ['Light Cosmetic', 1],
    ['Full Cosmetic', 2],
    ['Heavy Rehab', 3],
    ['Full Gut', 4],
  ]

  for (const [level, idx] of cases) {
    it(`classifies a ${level} photo set`, async () => {
      const r = await assessRenovationFromPhotos({}, photos(8), undefined, mockProvider(visionResponse(level)))
      expect(r.status).toBe('ok')
      expect(r.renovationLevelIndex).toBe(idx)
      expect(r.renovationLevel).toBe(REHAB_LEVEL_NAME(idx))
    })
  }

  it('mixed condition → the level the model gives, with both-side evidence preserved', async () => {
    const r = await assessRenovationFromPhotos({}, photos(8), undefined,
      mockProvider(visionResponse('Full Cosmetic', 70, {
        evidence_against_less_severe_level: ['rear rooms distressed'],
        evidence_against_more_severe_level: ['front rooms renovated'],
      })))
    expect(r.status).toBe('ok')
    expect(r.renovationLevelIndex).toBe(2)
    expect(r.evidenceAgainstLessSevereLevel).toContain('rear rooms distressed')
    expect(r.evidenceAgainstMoreSevereLevel).toContain('front rooms renovated')
  })

  it('renovated front + distressed rear still resolves to a whole-property level', async () => {
    const r = await assessRenovationFromPhotos({}, photos(8), undefined,
      mockProvider(visionResponse('Heavy Rehab', 78)))
    expect(r.renovationLevelIndex).toBe(3)
  })

  it('updated interior + severely distressed exterior', async () => {
    const r = await assessRenovationFromPhotos({}, photos(8), undefined,
      mockProvider(visionResponse('Heavy Rehab', 75, {
        exterior_condition: 'failed',
        visible_major_system_concerns: ['roof at end of life'],
      })))
    expect(r.renovationLevelIndex).toBe(3)
    expect(r.exteriorCondition).toBe('failed')
    expect(r.visibleMajorSystemConcerns).toContain('roof at end of life')
  })
})

function REHAB_LEVEL_NAME(idx: number): string {
  return ['Lipstick', 'Light Cosmetic', 'Full Cosmetic', 'Heavy Rehab', 'Down to Stud'][idx]
}

// ─── Photo sufficiency / failure handling ────────────────────────────────────

describe('photo evidence sufficiency', () => {
  it('very few photos → INSUFFICIENT_PHOTO_EVIDENCE, no level invented', async () => {
    const r = await assessRenovationFromPhotos({}, photos(1), undefined, mockProvider(visionResponse('Lipstick')))
    expect(r.status).toBe('insufficient_photo_evidence')
    expect(r.renovationLevelIndex).toBeNull()
  })

  it('zero photos → INSUFFICIENT_PHOTO_EVIDENCE', async () => {
    const r = await assessRenovationFromPhotos({}, [], undefined, mockProvider(visionResponse('Lipstick')))
    expect(r.status).toBe('insufficient_photo_evidence')
    expect(r.photosExamined).toBe(0)
  })

  it('duplicate listing photos collapse — duplicates carry no evidence', async () => {
    const r = await assessRenovationFromPhotos(
      {},
      ['https://img.example.com/same.jpg', 'https://img.example.com/same.jpg'],
      undefined,
      mockProvider(visionResponse('Lipstick'))
    )
    expect(r.status).toBe('insufficient_photo_evidence')
    expect(r.photosExamined).toBe(1)
  })

  it('low-confidence result → NEEDS_REVIEW with the level still recorded', async () => {
    const r = await assessRenovationFromPhotos({}, photos(5), undefined, mockProvider(visionResponse('Full Cosmetic', 30)))
    expect(r.status).toBe('needs_review')
    expect(r.renovationLevelIndex).toBe(2)
    expect(r.confidence).toBe(30)
  })
})

// ─── Provider failure modes ──────────────────────────────────────────────────

describe('provider failure modes — no invented levels', () => {
  it('provider timeout → unavailable, no level', async () => {
    const r = await assessRenovationFromPhotos({}, photos(6), undefined, failProvider('TIMEOUT', 'Request timed out'))
    expect(r.status).toBe('unavailable')
    expect(r.renovationLevelIndex).toBeNull()
    expect(r.error).toBe('Request timed out')
  })

  it('provider malformed response → unavailable, no level', async () => {
    const r = await assessRenovationFromPhotos({}, photos(6), undefined, mockProvider('this is not json at all'))
    expect(r.status).toBe('unavailable')
    expect(r.renovationLevelIndex).toBeNull()
    expect(r.error).toContain('Malformed')
  })

  it('provider rate-limit → unavailable, no level', async () => {
    const r = await assessRenovationFromPhotos({}, photos(6), undefined, failProvider('RATE_LIMITED', 'Too many requests'))
    expect(r.status).toBe('unavailable')
    expect(r.renovationLevelIndex).toBeNull()
  })

  it('missing vision credentials → unavailable, no level', async () => {
    const r = await assessRenovationFromPhotos({}, photos(6))
    expect(r.status).toBe('unavailable')
    expect(r.error).toContain('credentials')
    expect(r.renovationLevelIndex).toBeNull()
  })

  it('unrecognized level in a well-formed response → NEEDS_REVIEW, no invented level', async () => {
    const r = await assessRenovationFromPhotos({}, photos(6), undefined, mockProvider(visionResponse('Moderate Refresh', 80)))
    expect(r.status).toBe('needs_review')
    expect(r.renovationLevelIndex).toBeNull()
  })
})

// ─── Structured output integrity ─────────────────────────────────────────────

describe('structured assessment fields', () => {
  it('stored reasoning/evidence corresponds to the returned level', async () => {
    const r = await assessRenovationFromPhotos({}, photos(6), undefined, mockProvider(visionResponse('Heavy Rehab', 88)))
    expect(r.status).toBe('ok')
    expect(r.renovationLevel).toBe('Heavy Rehab')
    expect(r.evidenceForClassification.length).toBeGreaterThan(0)
    expect(r.majorObservations.length).toBeGreaterThan(0)
    expect(r.provider).toBe('openrouter')
    expect(r.model).toBe('test-model')
  })

  it('level definitions cover the five approved levels', () => {
    expect(RENOVATION_LEVEL_DEFINITIONS).toHaveLength(5)
    expect(RENOVATION_LEVEL_DEFINITIONS.map((d) => d.index)).toEqual([0, 1, 2, 3, 4])
  })
})
