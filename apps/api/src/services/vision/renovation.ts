/**
 * Computer-Vision Renovation Assessment
 *
 * Inspects the SUBJECT PROPERTY's listing photos and classifies the
 * renovation level into one of the five approved levels. Reasons across
 * the ENTIRE photo set as one property — never averages per-image
 * classifications.
 *
 * Roles: computer vision determines CONDITION LEVEL; Evaluation Settings
 * determines COST. This module never produces dollar estimates.
 *
 * Failure semantics:
 * - INSUFFICIENT_PHOTO_EVIDENCE — too few unique usable photos
 * - NEEDS_REVIEW — assessment returned but with low confidence
 * - unavailable — provider error/missing credentials; the pipeline
 *   continues without an invented level
 */

import { createReasoningProvider, isReasoningProviderAvailable } from '../llm'
import { fetchImageAsBase64, type FetchedImage } from '../llm/image-utils'
import { REHAB_LEVELS } from '../valuation/types'

// ─── Renovation Level Definitions (Evaluation Settings criteria) ──────────────

/**
 * Approved renovation levels (REHAB_LEVELS indices 0-4; indices 5-6 are
 * market-cost variants and are never auto-selected by vision).
 *
 * These definitions are the configurable criteria the vision model is
 * given — refine them here or surface them in Evaluation Settings.
 */
export const RENOVATION_LEVEL_DEFINITIONS: Array<{ index: number; name: string; criteria: string }> = [
  {
    index: 0,
    name: 'Lipstick',
    criteria:
      'Very minor refresh: paint, touch-ups, cleaning, small fixture/hardware changes, and basic curb appeal.',
  },
  {
    index: 1,
    name: 'Light Cosmetic',
    criteria:
      'Light interior updating such as paint, flooring, fixtures, minor kitchen/bath updates, and small repairs with no major systems work.',
  },
  {
    index: 2,
    name: 'Full Cosmetic',
    criteria:
      'Full visual renovation of the house: flooring, paint, kitchen, bathrooms, fixtures, doors/trim, exterior touch-ups, but generally no major structural reconstruction.',
  },
  {
    index: 3,
    name: 'Heavy Rehab',
    criteria:
      'Cosmetic renovation plus meaningful mechanical or building-system work such as roof, HVAC, plumbing, electrical, windows, foundation repairs, or significant damage remediation.',
  },
  {
    index: 4,
    name: 'Full Gut',
    criteria:
      'Entire property stripped to the studs with no drywall up anywhere — total interior reconstruction (owner-calibrated boundary 2026-10-02: partial demo or exposed studs in some areas is still Heavy Rehab, not Full Gut).',
  },
]

/** Map a free-form level string to a REHAB_LEVELS index (0-4), else null */
/**
 * Extract a JSON object from model output: strips markdown fences, then
 * scans for the outermost balanced `{...}` block (trailing prose is common).
 */
function parseVisionJson(content: string): Record<string, unknown> | null {
  const text = content.replace(/```(?:json)?/gi, '')
  const start = text.indexOf('{')
  if (start === -1) return null

  // Find the largest balanced brace span from the first '{'
  let depth = 0
  let end = -1
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (escaped) { escaped = false; continue }
    if (ch === '\\') { escaped = true; continue }
    if (ch === '"') { inString = !inString; continue }
    if (inString) continue
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) { end = i; break }
    }
  }
  if (end === -1) return null

  try {
    const parsed = JSON.parse(text.slice(start, end + 1))
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

export function renovationLevelToIndex(level: string | null | undefined): number | null {
  if (!level) return null
  const v = level.toLowerCase().replace(/[^a-z]/g, '')
  if (/lipstick/.test(v)) return 0
  if (/lightcosmetic/.test(v)) return 1
  if (/fullcosmetic/.test(v)) return 2
  if (/heavyrehab|heavy/.test(v)) return 3
  if (/fullgut|downtostud|gut/.test(v)) return 4
  return null
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RenovationAssessment {
  status: 'ok' | 'insufficient_photo_evidence' | 'needs_review' | 'unavailable'
  /** REHAB_LEVELS index (0-4) when status resolves to a level */
  renovationLevelIndex: number | null
  /** Level name, or 'NA' when the interior condition cannot be verified */
  renovationLevel: string
  confidence: number | null
  photosExamined: number
  majorObservations: string[]
  /** 'NA' when the condition cannot be verified from photo evidence */
  kitchenCondition: string
  bathroomCondition: string
  flooringCondition: string
  wallCeilingCondition: string
  exteriorCondition: string
  visibleMajorSystemConcerns: string[]
  structuralConcerns: string[]
  /** One sentence — why this renovation level fits the property best */
  rationale: string | null
  evidenceForClassification: string[]
  evidenceAgainstMoreSevereLevel: string[]
  evidenceAgainstLessSevereLevel: string[]
  limitations: string[]
  provider: string | null
  model: string | null
  /** Curb-appeal condition assessed in the same vision pass */
  curbAppeal?: CurbAppealCheck | null
  error?: string
}

export interface RenovationEnv {
  OPENROUTER_API_KEY?: string
  OPENROUTER_MODEL?: string
  /** Scoped override for vision-only calls — keeps OPENROUTER_MODEL free for non-vision services (listing extraction, seller notes). */
  VISION_MODEL?: string
  /** Reasoning effort for the vision call (low|medium|high|xhigh|max) — default medium. */
  VISION_REASONING_EFFORT?: string
  /** Anthropic direct — the reasoning lane (tier verdicts) when configured. */
  ANTHROPIC_API_KEY?: string
  REASONING_PROVIDER?: string
  REASONING_MODEL?: string
  /** Workers AI binding — Clef is the subject's primary reader. */
  AI?: import('../../types').Env['AI']
}

const ROOM_CONDITIONS = ['excellent', 'good', 'dated', 'poor', 'failed', 'not_visible']

/** Strict Structured Outputs schema — kills the malformed-JSON retry path. */
const RENOVATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'renovation_level', 'confidence', 'major_observations',
    'kitchen_condition', 'bathroom_condition', 'flooring_condition',
    'wall_ceiling_condition', 'exterior_condition',
    'visible_major_system_concerns', 'structural_concerns',
    'rationale', 'evidence_for_classification',
    'evidence_against_more_severe_level', 'evidence_against_less_severe_level',
    'limitations', 'curb_appeal_condition', 'curb_appeal_confidence', 'curb_appeal_summary',
  ],
  properties: {
    renovation_level: { type: 'string', enum: RENOVATION_LEVEL_DEFINITIONS.map((d) => d.name) },
    confidence: { type: 'integer', minimum: 0, maximum: 100 },
    major_observations: { type: 'array', items: { type: 'string' } },
    kitchen_condition: { type: 'string', enum: ROOM_CONDITIONS },
    bathroom_condition: { type: 'string', enum: ROOM_CONDITIONS },
    flooring_condition: { type: 'string', enum: ROOM_CONDITIONS },
    wall_ceiling_condition: { type: 'string', enum: ROOM_CONDITIONS },
    exterior_condition: { type: 'string', enum: ROOM_CONDITIONS },
    visible_major_system_concerns: { type: 'array', items: { type: 'string' } },
    structural_concerns: { type: 'array', items: { type: 'string' } },
    rationale: { type: 'string' },
    evidence_for_classification: { type: 'array', items: { type: 'string' } },
    evidence_against_more_severe_level: { type: 'array', items: { type: 'string' } },
    evidence_against_less_severe_level: { type: 'array', items: { type: 'string' } },
    limitations: { type: 'array', items: { type: 'string' } },
    curb_appeal_condition: { type: 'string', enum: ['renovated', 'dated', 'distressed', 'unknown'] },
    curb_appeal_confidence: { type: 'integer', minimum: 0, maximum: 100 },
    curb_appeal_summary: { type: 'string' },
  },
}

const MIN_UNIQUE_PHOTOS = 1
const MAX_PHOTOS = 30
// The LLM fallback reads in one call — cap its image payload. Clef reads
// every photo via 4-image chunks instead, so nothing is skipped.
const LLM_MAX_IMAGES = 12
const LOW_CONFIDENCE = 40
/** Clef's image budget is 4 — the comp lane uses the same cap. */
const CLEF_MAX_PHOTOS = 4

// ─── Clef subject read ──────────────────────────────────────────────────────
// The subject reads through the same chain as comps: Clef (Workers AI)
// primary, Luna (gpt-6-luna via OpenRouter) fallback. Clef answers a level
// choice + a curb-appeal choice — level granularity only, so room
// conditions stay 'NA' rather than invented at photo-4 depth.

interface ClefAnswerMap {
  renovation_level?: { choice?: string; probabilities?: Record<string, number> }
  curb_appeal?: { choice?: string; probabilities?: Record<string, number> }
  kitchen_condition?: { choice?: string; probabilities?: Record<string, number> }
  bathroom_condition?: { choice?: string; probabilities?: Record<string, number> }
  flooring_condition?: { choice?: string; probabilities?: Record<string, number> }
  wall_ceiling_condition?: { choice?: string; probabilities?: Record<string, number> }
  exterior_condition?: { choice?: string; probabilities?: Record<string, number> }
  major_system_concern?: { noul?: number; probability?: number }
  structural_concern?: { noul?: number; probability?: number }
}

const ZONE_CRITERIA: Record<string, Record<string, string>> = {
  kitchen_condition: {
    excellent: 'recently remodeled — new cabinets, counters, appliances',
    good: 'updated and clean, no obvious work needed',
    dated: 'functional but visibly dated finishes',
    poor: 'heavy wear or damage — needs renovation',
    failed: 'unusable, gutted, or stripped',
    not_visible: 'no kitchen visible in these photos',
  },
  bathroom_condition: {
    excellent: 'recently remodeled — new vanity, tile, fixtures',
    good: 'updated and clean',
    dated: 'functional but visibly dated finishes',
    poor: 'heavy wear or damage — needs renovation',
    failed: 'unusable, gutted, or stripped',
    not_visible: 'no bathroom visible in these photos',
  },
  flooring_condition: {
    excellent: 'new or like-new flooring throughout visible areas',
    good: 'clean flooring, minor wear',
    dated: 'functional but dated — old carpet, worn vinyl, dated tile',
    poor: 'damaged, stained, or heavily worn flooring',
    failed: 'missing, stripped, or subfloor exposed',
    not_visible: 'no interior flooring visible in these photos',
  },
  wall_ceiling_condition: {
    excellent: 'fresh paint/finishes, no visible damage',
    good: 'clean walls and ceilings, minor wear',
    dated: 'dated finishes, wallpaper, or old paint',
    poor: 'damage, staining, cracks, or heavy wear',
    failed: 'open studs, missing drywall, water damage',
    not_visible: 'no interior walls/ceilings visible in these photos',
  },
  exterior_condition: {
    excellent: 'new roof/siding, fresh exterior finishes',
    good: 'maintained exterior, minor wear',
    dated: 'dated siding/roof/paint, functional',
    poor: 'visible exterior damage or deferred maintenance',
    failed: 'roof failure, siding missing, structural exterior damage',
    not_visible: 'no exterior visible in these photos',
  },
}

/**
 * Clef's role is evidence collection, not the verdict — it reads every
 * photo in 4-image chunks (as many calls as the photo set needs) and the
 * raw per-chunk answers go to Luna as the evidence block. The merged
 * assessment below is the fallback when Luna can't be reached.
 */
interface ClefChunkRead {
  answers: ClefAnswerMap[]
  chunksRead: number
}

async function runClefChunkReads(
  env: RenovationEnv,
  live: FetchedImage[],
  propertyContext: { address?: string; squareFeet?: number | null; yearBuilt?: number | null },
): Promise<ClefChunkRead> {
  const ai = env.AI
  if (!ai) return { answers: [], chunksRead: 0 }
  const model = '@cf/cloudflare/clef-flash'
  const questions = {
    renovation_level: {
      type: 'choice',
      instructions:
        'Examine ALL photos together as one property and choose the single ' +
        'renovation level that best describes the work required across the ' +
        'whole property. Weight majority-condition and the most expensive ' +
        'required work — a dated kitchen alone is not Heavy Rehab; partial ' +
        'demo is not Full Gut.',
      criteria: Object.fromEntries(RENOVATION_LEVEL_DEFINITIONS.map((d) => [d.name, d.criteria])),
    },
    curb_appeal: {
      type: 'choice',
      instructions: 'Describe the property\'s visible exterior/curb condition.',
      criteria: {
        renovated: 'modern finishes, updated, move-in ready',
        dated: 'livable but visibly dated finishes',
        distressed: 'obvious disrepair, damage, heavy wear',
        unknown: 'photos insufficient to judge',
      },
    },
    // Zone reads — each 4-photo chunk answers every zone; chunks that don't
    // show a zone answer not_visible and drop out of the merge, so the
    // verdict per zone comes only from chunks that actually saw it.
    kitchen_condition: {
      type: 'choice',
      instructions: 'Rate the condition of any kitchen visible in THESE photos. If none is visible, answer not_visible.',
      criteria: ZONE_CRITERIA.kitchen_condition,
    },
    bathroom_condition: {
      type: 'choice',
      instructions: 'Rate the condition of any bathroom visible in THESE photos. If none is visible, answer not_visible.',
      criteria: ZONE_CRITERIA.bathroom_condition,
    },
    flooring_condition: {
      type: 'choice',
      instructions: 'Rate the condition of interior flooring visible in THESE photos. If none is visible, answer not_visible.',
      criteria: ZONE_CRITERIA.flooring_condition,
    },
    wall_ceiling_condition: {
      type: 'choice',
      instructions: 'Rate the condition of interior walls and ceilings visible in THESE photos. If none are visible, answer not_visible.',
      criteria: ZONE_CRITERIA.wall_ceiling_condition,
    },
    exterior_condition: {
      type: 'choice',
      instructions: 'Rate the condition of the exterior — roof, siding, paint, yard — visible in THESE photos. If none is visible, answer not_visible.',
      criteria: ZONE_CRITERIA.exterior_condition,
    },
    major_system_concern: {
      type: 'noul',
      instructions:
        'Do THESE photos show a visible major-system concern — aged or rusty ' +
        'HVAC unit, water heater corrosion, old/damaged electrical panel, ' +
        'knob-and-tube or exposed wiring, plumbing leaks, missing fixtures?',
    },
    structural_concern: {
      type: 'noul',
      instructions:
        'Do THESE photos show structural distress — foundation cracks, roof ' +
        'sag, wall bowing, floor slope, fire or severe water damage?',
    },
  }
  // One Clef call per photo chunk — Clef's image budget is 4, so a
  // 12-photo subject reads through 3 calls. Level/curb probabilities are
  // averaged across chunks into one verdict.
  const chunks: FetchedImage[][] = []
  for (let i = 0; i < live.length; i += CLEF_MAX_PHOTOS) chunks.push(live.slice(i, i + CLEF_MAX_PHOTOS))
  const calls = await Promise.all(chunks.map((chunk) =>
    ai.run(model, {
      state: {
        subject: 'Subject-property renovation assessment for a fix-and-flip appraisal.',
        property: {
          address: propertyContext.address ?? null,
          squareFeet: propertyContext.squareFeet ?? null,
          yearBuilt: propertyContext.yearBuilt ?? null,
        },
      },
      questions,
      images: chunk.map((f) => ({ content_type: f.mimeType, base64: f.base64 })),
    }).then((r) => r as { answers?: ClefAnswerMap }).catch(() => null),
  ))
  const answers = calls.map((c) => c?.answers).filter((a): a is ClefAnswerMap => !!a)
  return { answers, chunksRead: chunks.length }
}

/** Serialize the Clef chunk reads into the evidence block Luna reasons over. */
function clefEvidenceBlock(clef: ClefChunkRead): string {
  const zoneKeys = [
    'kitchen_condition', 'bathroom_condition', 'flooring_condition',
    'wall_ceiling_condition', 'exterior_condition',
  ] as const
  const perChunk = clef.answers.map((a, i) => {
    const zones: Record<string, unknown> = {}
    for (const zk of zoneKeys) {
      const q = a[zk]
      if (q?.choice) zones[zk] = { choice: q.choice, probability: q.probabilities?.[q.choice] ?? null }
    }
    return {
      chunk: i + 1,
      renovation_level: a.renovation_level?.choice ?? null,
      renovation_level_probabilities: a.renovation_level?.probabilities ?? null,
      curb_appeal: a.curb_appeal?.choice ?? null,
      zones,
      major_system_concern_probability: a.major_system_concern?.noul ?? a.major_system_concern?.probability ?? null,
      structural_concern_probability: a.structural_concern?.noul ?? a.structural_concern?.probability ?? null,
    }
  })
  return JSON.stringify({
    photo_chunks_read: clef.chunksRead,
    chunks_answered: clef.answers.length,
    per_chunk_reads: perChunk,
  }, null, 2)
}

function mergedClefAssessment(
  answers: ClefAnswerMap[],
  live: FetchedImage[],
): RenovationAssessment | null {
  if (!answers.length) return null

  // Merge chunk probabilities — majority vote weighted by confidence.
  const mergeProbs = (key: 'renovation_level' | 'curb_appeal') => {
    const agg = new Map<string, { sum: number; n: number }>()
    for (const a of answers) {
      const probs = a[key]?.probabilities
      if (!probs) continue
      for (const [k, v] of Object.entries(probs)) {
        const e = agg.get(k) ?? { sum: 0, n: 0 }
        e.sum += v; e.n += 1; agg.set(k, e)
      }
    }
    let best: string | null = null; let bestAvg = 0
    for (const [k, { sum, n }] of agg) {
      const avg = sum / n
      if (avg > bestAvg) { bestAvg = avg; best = k }
    }
    return { pick: best, prob: bestAvg }
  }

  const { pick, prob: pickProb } = mergeProbs('renovation_level')
  const levelIndex = renovationLevelToIndex(pick)
  if (levelIndex === null) return null
  const confidence = Math.round(Math.min(1, Math.max(0, pickProb)) * 100)
  const { pick: curbPick, prob: curbProb } = mergeProbs('curb_appeal')

  // Zone merge — a zone verdict comes only from chunks that saw it:
  // not_visible picks drop out; remaining picks majority-vote weighted by
  // their probability. No chunk saw the zone → 'not_visible' (never NA —
  // the gate counts real reads, and a zone no camera reached is a data
  // gap, not an unread zone).
  const zoneKeys = [
    'kitchen_condition', 'bathroom_condition', 'flooring_condition',
    'wall_ceiling_condition', 'exterior_condition',
  ] as const
  const zones: Record<(typeof zoneKeys)[number], string> = {
    kitchen_condition: 'not_visible', bathroom_condition: 'not_visible',
    flooring_condition: 'not_visible', wall_ceiling_condition: 'not_visible',
    exterior_condition: 'not_visible',
  }
  for (const zk of zoneKeys) {
    const votes = new Map<string, number>()
    for (const a of answers) {
      const q = a[zk]
      const ch = q?.choice
      if (!ch || ch === 'not_visible') continue
      const p = q?.probabilities?.[ch] ?? 0.5
      votes.set(ch, (votes.get(ch) ?? 0) + p)
    }
    let bestZone: string | null = null
    let bestV = 0
    for (const [z, v] of votes) if (v > bestV) { bestV = v; bestZone = z }
    if (bestZone) zones[zk] = bestZone
  }
  const noulAvg = (key: 'major_system_concern' | 'structural_concern') => {
    const vals = answers
      .map((a) => a[key]?.noul ?? a[key]?.probability)
      .filter((v): v is number => typeof v === 'number')
    return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : 0
  }
  const systemConcerns = noulAvg('major_system_concern') >= 0.5
    ? ['Clef zone read: visible major-system concern in photo set']
    : []
  const structuralConcerns = noulAvg('structural_concern') >= 0.5
    ? ['Clef zone read: possible structural distress in photo set']
    : []

  return {
    status: confidence !== null && confidence < LOW_CONFIDENCE ? 'needs_review' : 'ok',
    renovationLevelIndex: levelIndex,
    renovationLevel: REHAB_LEVELS[levelIndex],
    confidence,
    photosExamined: live.length,
    majorObservations: [],
    kitchenCondition: zones.kitchen_condition,
    bathroomCondition: zones.bathroom_condition,
    flooringCondition: zones.flooring_condition,
    wallCeilingCondition: zones.wall_ceiling_condition,
    exteriorCondition: zones.exterior_condition,
    visibleMajorSystemConcerns: systemConcerns,
    structuralConcerns,
    rationale: null,
    evidenceForClassification: [],
    evidenceAgainstMoreSevereLevel: [],
    evidenceAgainstLessSevereLevel: [],
    limitations: [`Clef chunked zone read — ${answers.length} call(s), zones not photographed report not_visible`],
    provider: 'workers-ai',
    model: 'clef-flash',
    curbAppeal: curbPick && curbPick !== 'unknown'
      ? {
          condition: curbPick as CurbAppealCheck['condition'],
          source: 'vision' as const,
          confidence: Math.round(curbProb * 100),
          summary: null,
          photosExamined: live.length,
        }
      : null,
  }
}

const LUNA_EVIDENCE_PREAMBLE = `You are the final renovation assessor for a fix-and-flip investor.

A fast vision evidence reader has already examined EVERY listing photo of this property in 4-image chunks and produced the structured reads below — zone conditions per chunk, per-chunk renovation-level votes with probabilities, and major-system/structural concern probabilities. The photos themselves are also attached where the image budget allowed (the evidence covers photos you may not see).

Your job is to reason over that evidence and make the FINAL call on the property's condition tier. The evidence reader's level votes are input, not verdict — you may land on a different level when the zone evidence supports it (e.g. votes split across levels, or a single chunk's 'failed' zone read that changes the whole-property call). Explain any divergence in the rationale.

CLEF CHUNKED ZONE EVIDENCE:
`

/**
 * Luna's verdict call — reasons over the Clef chunk evidence (plus the
 * photos that fit the image budget) and returns the final tier call.
 * Returns null when the provider call can't produce a parseable verdict;
 * the caller then ships the merged Clef assessment instead.
 */
async function assessViaLunaEvidence(
  provider: { name: string; model: string; execute: (req: any) => Promise<any> },
  clef: ClefChunkRead,
  live: FetchedImage[],
  propertyContext: { address?: string; squareFeet?: number | null; yearBuilt?: number | null },
): Promise<RenovationAssessment | null> {
  let prompt = ''
  if (propertyContext.address) prompt += `Address: ${propertyContext.address}\n`
  if (propertyContext.squareFeet) prompt += `Square Feet: ${propertyContext.squareFeet}\n`
  if (propertyContext.yearBuilt) prompt += `Year Built: ${propertyContext.yearBuilt}\n`
  prompt += '\n'
  prompt += LUNA_EVIDENCE_PREAMBLE + clefEvidenceBlock(clef) + '\n\n' + RENOVATION_PROMPT

  const imagePayload = live.slice(0, LLM_MAX_IMAGES).map((f) => ({ base64: f.base64, mimeType: f.mimeType }))

  let parsed: Record<string, unknown> | null = null
  for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
    const result = await provider.execute({
      prompt,
      images: imagePayload,
      responseFormat: 'json',
      jsonSchema: { name: 'renovation_assessment', schema: RENOVATION_SCHEMA },
      reasoning: { enabled: true, effort: 'medium' as const },
      maxTokens: 8192,
    }).catch(() => null)
    if (!result?.success || !result.data?.content) continue
    parsed = parseVisionJson(result.data.content)
  }
  if (!parsed) return null

  const assessment = assessmentFromParsed(parsed, provider.name, provider.model, live.length)
  assessment.limitations = [
    ...assessment.limitations,
    `Tier call reasoned over Clef chunk evidence — ${clef.chunksRead} chunk read(s) covering ${live.length} photo(s)`,
  ]
  return assessment
}

// ─── Prompt ───────────────────────────────────────────────────────────────────

const RENOVATION_PROMPT = `You are a real-estate renovation assessor for a fix-and-flip investor. Examine ALL of the provided photos TOGETHER as one property and determine the single renovation level that best describes the work required across the whole property.

Approved renovation levels (choose exactly one):
${RENOVATION_LEVEL_DEFINITIONS.map((d) => `- ${d.name}: ${d.criteria}`).join('\n')}

Reason about the property AS A WHOLE:
- A dated kitchen alone does NOT make the property Heavy Rehab.
- Fresh paint in one room does NOT make a distressed property Lipstick.
- Exposed studs or demo in some rooms does NOT make it Full Gut — Full Gut means the ENTIRE interior is down to studs with no drywall remaining.
- Weight the majority-condition and the most expensive required work.

Evaluate, where observable: kitchen, bathrooms, cabinets, counters, appliances, flooring, walls, ceilings, paint, doors, windows, fixtures, visible electrical/plumbing/HVAC condition, roof/exterior, siding/stucco/brick, landscaping (where renovation-relevant), water damage, fire damage, structural distress, outdated finishes, unfinished construction, layout/demo evidence, and overall condition.

Return ONLY a JSON object:
{
  "renovation_level": "one of the approved level names exactly",
  "confidence": 0-100,
  "major_observations": ["top observations driving the classification"],
  "kitchen_condition": "excellent|good|dated|poor|failed|not_visible",
  "bathroom_condition": "same scale",
  "flooring_condition": "same scale",
  "wall_ceiling_condition": "same scale",
  "exterior_condition": "same scale",
  "visible_major_system_concerns": ["e.g. aged HVAC, knob-and-tube wiring"],
  "structural_concerns": ["e.g. foundation crack, roof sag"],
  "rationale": "one sentence — why this renovation level fits the property best",
  "evidence_for_classification": ["why this level fits the whole property"],
  "evidence_against_more_severe_level": ["why NOT the next heavier level"],
  "evidence_against_less_severe_level": ["why NOT the next lighter level"],
  "limitations": ["what photos did not show"],
  "curb_appeal_condition": "renovated|dated|distressed|unknown",
  "curb_appeal_confidence": 0-100,
  "curb_appeal_summary": "one sentence describing visible condition"
}

For curb_appeal_condition: renovated = modern finishes/move-in ready, dated = livable but visibly dated finishes, distressed = obvious disrepair or heavy wear, unknown = photos insufficient to judge. Never guess — use "unknown".

With a single photo (usually exterior): classify what is visible — a clean exterior can support Light Cosmetic or below, but never claim Heavy Rehab or Full Gut from curb appeal alone. Interior rooms not visible = "not_visible". Keep confidence ≤ 60 and list the missing interior evidence in limitations.`

// ─── Assessment ───────────────────────────────────────────────────────────────

/**
 * The 'unavailable' baseline — every non-ok outcome shares this shape so the
 * evaluation pipeline always resolves a full assessment object (the subject
 * condition fetch is required for eval completion; a thrown provider error
 * still surfaces as an explicit 'unavailable' verdict, never silent null).
 */
export function unavailableAssessment(overrides?: Partial<RenovationAssessment>): RenovationAssessment {
  return {
    status: 'unavailable',
    renovationLevelIndex: null,
    renovationLevel: 'NA',
    confidence: null,
    photosExamined: 0,
    majorObservations: [],
    kitchenCondition: 'NA',
    bathroomCondition: 'NA',
    flooringCondition: 'NA',
    wallCeilingCondition: 'NA',
    exteriorCondition: 'NA',
    visibleMajorSystemConcerns: [],
    structuralConcerns: [],
    rationale: null,
    evidenceForClassification: [],
    evidenceAgainstMoreSevereLevel: [],
    evidenceAgainstLessSevereLevel: [],
    limitations: [],
    provider: null,
    model: null,
    ...overrides,
  }
}

/**
 * Assess the subject property's renovation level from listing photos.
 * Never invents a level on bad/missing evidence.
 */
export async function assessRenovationFromPhotos(
  env: RenovationEnv,
  photoUrls: string[],
  propertyContext?: { address?: string; squareFeet?: number | null; yearBuilt?: number | null },
  providerOverride?: { name: string; model: string; execute: (req: any) => Promise<any> }
): Promise<RenovationAssessment> {
  // Interior condition is 'NA' whenever it cannot be verified — never null,
  // never invented
  const base = unavailableAssessment()

  // Deduplicate identical listing photos — duplicates carry no evidence
  const uniquePhotos = [...new Set(photoUrls.filter(Boolean))]

  if (uniquePhotos.length < MIN_UNIQUE_PHOTOS) {
    return {
      ...base,
      status: 'insufficient_photo_evidence',
      photosExamined: uniquePhotos.length,
      limitations: [`Only ${uniquePhotos.length} unique photo(s) available`],
    }
  }

  if (!isReasoningProviderAvailable(env) && !env.AI && !providerOverride) {
    return {
      ...base,
      status: 'unavailable',
      photosExamined: uniquePhotos.length,
      error: 'No vision provider credentials configured',
      limitations: ['Vision provider not configured'],
    }
  }

  // Reasoning lane — Anthropic Haiku when configured, otherwise the
  // OpenRouter model this call site has always used (gpt-6-luna).
  const provider =
    providerOverride ??
    createReasoningProvider(env, env.VISION_MODEL || env.OPENROUTER_MODEL || 'openai/gpt-6-luna')

  const photos = uniquePhotos.slice(0, MAX_PHOTOS)

  // Fetch photos server-side — a single dead/expired CDN link fails the
  // whole provider call when passed as a URL (Observed: Redfin genMid
  // links 404 to Google). Base64 payloads skip provider-side fetching and
  // silently drop rotten links; if too few survive, it's honest
  // insufficient evidence — not an unparseable-provider failure.
  const fetched = await Promise.all(photos.map((u) => fetchImageAsBase64(u).catch(() => null)))
  const live = fetched.filter((f): f is FetchedImage => f != null && f.size > 0)
  if (live.length < MIN_UNIQUE_PHOTOS) {
    return {
      ...base,
      status: 'insufficient_photo_evidence',
      photosExamined: live.length,
      limitations: [live.length === 0 ? 'No photos fetchable' : `Only ${live.length} of ${photos.length} photo URL(s) were fetchable`],
    }
  }

  // Clef reads every photo in 4-image chunks — its answers are evidence,
  // not the verdict. Luna reasons over that evidence (plus the photos that
  // fit its image budget) for the final tier call; the merged Clef verdict
  // is the fallback when Luna can't answer. No Clef answers → the legacy
  // Luna photo read below.
  const clef = await runClefChunkReads(env, live, propertyContext ?? {})
    .catch(() => ({ answers: [], chunksRead: 0 }) as ClefChunkRead)
  const mergedClef = mergedClefAssessment(clef.answers, live)
  if (mergedClef) {
    const luna = provider
      ? await assessViaLunaEvidence(provider, clef, live, propertyContext ?? {}).catch(() => null)
      : null
    if (luna) {
      if (!luna.curbAppeal && mergedClef.curbAppeal) luna.curbAppeal = mergedClef.curbAppeal
      return luna
    }
    return mergedClef
  }

  if (!provider) {
    return {
      ...base,
      status: 'unavailable',
      photosExamined: live.length,
      error: 'No reasoning provider configured',
      limitations: ['Reasoning provider not configured'],
    }
  }

  let prompt = ''
  if (propertyContext) {
    prompt = 'Property context:\n'
    if (propertyContext.address) prompt += `Address: ${propertyContext.address}\n`
    if (propertyContext.squareFeet) prompt += `Square Feet: ${propertyContext.squareFeet}\n`
    if (propertyContext.yearBuilt) prompt += `Year Built: ${propertyContext.yearBuilt}\n`
    prompt += '\n'
  }
  prompt += RENOVATION_PROMPT

  const imagePayload = live.slice(0, LLM_MAX_IMAGES).map((f) => ({ base64: f.base64, mimeType: f.mimeType }))

  // Retry once on unparseable output — LLM formatting is nondeterministic
  let parsed: Record<string, unknown> | null = null
  let lastProviderError: string | null = null
  for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
    const result = await provider.execute({
      prompt,
      images: imagePayload,
      responseFormat: 'json',
      jsonSchema: { name: 'renovation_assessment', schema: RENOVATION_SCHEMA },
      reasoning: {
        enabled: true,
        effort: (env.VISION_REASONING_EFFORT ?? 'medium') as 'low' | 'medium' | 'high' | 'xhigh',
      },
      // The assessment JSON (per-room conditions + evidence arrays +
      // rationale) runs past the 1024 default — truncation mid-object was
      // the "malformed response" failure.
      maxTokens: 8192,
    })

    if (!result.success || !result.data?.content) {
      lastProviderError = result.error?.message ?? 'Vision analysis failed'
      continue
    }

    parsed = parseVisionJson(result.data.content)
    if (!parsed) {
      lastProviderError = 'Malformed vision response — could not parse assessment JSON'
    }
  }

  if (!parsed) {
    return {
      ...base,
      status: 'unavailable',
      photosExamined: photos.length,
      provider: provider.name,
      model: provider.model,
      error: lastProviderError ?? 'Vision analysis failed',
      limitations: ['Provider call failed or returned unparseable output — no level invented'],
    }
  }

  return assessmentFromParsed(parsed, provider.name, provider.model, photos.length)
}

/**
 * Map the strict-schema JSON (either from the photo-reading call or the
 * Clef-evidence reasoning call) into a RenovationAssessment.
 */
function assessmentFromParsed(
  parsed: Record<string, unknown>,
  providerName: string,
  modelName: string,
  photosExamined: number,
): RenovationAssessment {
  const levelIndex = renovationLevelToIndex(parsed.renovation_level as string)
  const confidence =
    typeof parsed.confidence === 'number'
      ? Math.min(100, Math.max(0, parsed.confidence))
      : null

  const str = (v: unknown): string => (typeof v === 'string' && v.trim() ? v : 'NA')
  const list = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []

  return {
    status:
      levelIndex === null
        ? 'needs_review'
        : confidence !== null && confidence < LOW_CONFIDENCE
          ? 'needs_review'
          : 'ok',
    renovationLevelIndex: levelIndex,
    renovationLevel: levelIndex !== null ? REHAB_LEVELS[levelIndex] : 'NA',
    confidence,
    photosExamined,
    majorObservations: list(parsed.major_observations),
    kitchenCondition: str(parsed.kitchen_condition),
    bathroomCondition: str(parsed.bathroom_condition),
    flooringCondition: str(parsed.flooring_condition),
    wallCeilingCondition: str(parsed.wall_ceiling_condition),
    exteriorCondition: str(parsed.exterior_condition),
    visibleMajorSystemConcerns: list(parsed.visible_major_system_concerns),
    structuralConcerns: list(parsed.structural_concerns),
    rationale: typeof parsed.rationale === 'string' && parsed.rationale.trim() ? parsed.rationale.trim() : null,
    evidenceForClassification: list(parsed.evidence_for_classification),
    evidenceAgainstMoreSevereLevel: list(parsed.evidence_against_more_severe_level),
    evidenceAgainstLessSevereLevel: list(parsed.evidence_against_less_severe_level),
    limitations: list(parsed.limitations),
    provider: providerName,
    model: modelName,
    curbAppeal: (() => {
      const raw = String(parsed.curb_appeal_condition ?? '').toLowerCase()
      const condition = raw === 'renovated' || raw === 'dated' || raw === 'distressed' ? raw : 'unknown'
      const caConf = typeof parsed.curb_appeal_confidence === 'number' ? Math.min(100, Math.max(0, parsed.curb_appeal_confidence)) : null
      const summary = typeof parsed.curb_appeal_summary === 'string' ? parsed.curb_appeal_summary : null
      return condition !== 'unknown' || summary
        ? { condition: condition as CurbAppealCheck['condition'], source: 'vision' as const, confidence: caConf, summary, photosExamined }
        : null
    })(),
  }
}

// ─── Comp curb-appeal check ──────────────────────────────────────────────────

export interface CurbAppealCheck {
  /** renovated | dated | distressed | unknown — ARV candidacy signal */
  condition: 'renovated' | 'dated' | 'distressed' | 'unknown'
  /** REHAB_LEVELS index (0-4) for the comp's visible condition — ARV gate uses this vs the subject's level */
  rehabLevelIndex?: number | null
  /** vision = verified from photos; price = inferred from top-of-market sale */
  source: 'vision' | 'price'
  confidence: number | null
  summary: string | null
  photosExamined: number
}

const CURB_APPEAL_PROMPT = `You are reviewing listing photos of a recently SOLD comparable property. Determine whether the sale price plausibly represents an AFTER-REPAIR (renovated/turnkey) value — i.e., whether this comp is a valid ARV candidate visually.

Also estimate the rehab scope this comp would need to reach renovated condition, using these levels:
${RENOVATION_LEVEL_DEFINITIONS.map((d) => `- ${d.name}: ${d.criteria}`).join('\n')}

Return ONLY JSON:
{
  "condition": "renovated" | "dated" | "distressed" | "unknown",
  "rehab_level": "one of the level names above, or null if unknown",
  "confidence": 0-100,
  "summary": "one sentence describing visible condition"
}

- renovated: modern finishes, updated kitchen/baths, new flooring, move-in ready — an "AR" (after-repair) sale
- dated: livable but visibly dated finishes/original surfaces
- distressed: obvious disrepair, damage, heavy wear
- unknown: photos insufficient (exteriors only, low detail)

Never guess a condition the photos don't show — use "unknown".`

const CURB_APPEAL_PHOTOS = 4
const CURB_APPEAL_MIN_PHOTOS = 2

/**
 * Lightweight per-comp visual check: is this comp's sale price plausibly
 * an ARV (post-renovation) candidate? Returns 'unknown' when photo evidence
 * can't support a judgment — never invents a condition.
 */
export async function assessCompCurbAppeal(
  env: RenovationEnv,
  photoUrls: string[]
): Promise<CurbAppealCheck> {
  const photos = [...new Set(photoUrls.filter(Boolean))].slice(0, CURB_APPEAL_PHOTOS)
  const base: CurbAppealCheck = { condition: 'unknown', source: 'vision', confidence: null, summary: null, photosExamined: photos.length }

  if (photos.length < CURB_APPEAL_MIN_PHOTOS) return { ...base, summary: 'Insufficient photos' }

  const provider = createReasoningProvider(env, env.VISION_MODEL || env.OPENROUTER_MODEL || 'google/gemini-2.5-flash')
  if (!provider) return { ...base, summary: 'Vision provider not configured' }

  const fetched = await Promise.all(photos.map((u) => fetchImageAsBase64(u).catch(() => null)))
  const live = fetched.filter((f): f is FetchedImage => f != null && f.size > 0)
  if (live.length < CURB_APPEAL_MIN_PHOTOS) return { ...base, summary: 'Insufficient fetchable photos', photosExamined: live.length }

  const result = await provider.execute({
    prompt: CURB_APPEAL_PROMPT,
    images: live.map((f) => ({ base64: f.base64, mimeType: f.mimeType })),
    responseFormat: 'json',
    maxTokens: 2048,
  })
  if (!result.success || !result.data?.content) return { ...base, summary: 'Vision call failed', photosExamined: live.length }

  const parsed = parseVisionJson(result.data.content)
  if (!parsed) return { ...base, summary: 'Unparseable vision response' }

  const raw = String(parsed.condition ?? '').toLowerCase()
  const condition =
    raw === 'renovated' || raw === 'dated' || raw === 'distressed' ? (raw as CurbAppealCheck['condition']) : 'unknown'
  const confidence =
    typeof parsed.confidence === 'number' ? Math.min(100, Math.max(0, parsed.confidence)) : null
  return {
    condition,
    rehabLevelIndex: renovationLevelToIndex(parsed.rehab_level as string | null),
    source: 'vision',
    confidence,
    summary: typeof parsed.summary === 'string' ? parsed.summary : null,
    photosExamined: photos.length,
  }
}
