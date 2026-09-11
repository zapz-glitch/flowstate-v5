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

import { createLLMProvider } from '../llm'
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
      'Mostly paint, cleaning, carpet/flooring, fixtures, and very minor cosmetic work. Kitchen and baths are dated or worn but functional; no system or structural work needed.',
  },
  {
    index: 1,
    name: 'Light Cosmetic',
    criteria:
      'Light cosmetic refresh — paint, flooring, fixtures, minor repairs, curb appeal. Kitchen/baths may need light updates (paint, hardware, counters) but no full replacement.',
  },
  {
    index: 2,
    name: 'Full Cosmetic',
    criteria:
      'Material cosmetic renovation including kitchen and bathroom refresh, flooring throughout, paint, fixtures, and finishes. No mechanical, roof, foundation, or layout work.',
  },
  {
    index: 3,
    name: 'Heavy Rehab',
    criteria:
      'Significant work potentially involving mechanical systems (HVAC, electrical, plumbing), roof, foundation, substantial repairs, or layout changes. Major systems visibly failed or end-of-life.',
  },
  {
    index: 4,
    name: 'Down to Stud',
    criteria:
      'Major/down-to-studs ("Full Gut") renovation where essentially the entire property requires renovation — gutted interiors, fire/water/structural damage, or unfinished construction throughout.',
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
}

const MIN_UNIQUE_PHOTOS = 2
const MAX_PHOTOS = 12
const LOW_CONFIDENCE = 40

// ─── Prompt ───────────────────────────────────────────────────────────────────

const RENOVATION_PROMPT = `You are a real-estate renovation assessor for a fix-and-flip investor. Examine ALL of the provided photos TOGETHER as one property and determine the single renovation level that best describes the work required across the whole property.

Approved renovation levels (choose exactly one):
${RENOVATION_LEVEL_DEFINITIONS.map((d) => `- ${d.name}: ${d.criteria}`).join('\n')}

Reason about the property AS A WHOLE:
- A dated kitchen alone does NOT make the property Heavy Rehab.
- Fresh paint in one room does NOT make a distressed property Lipstick.
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
  "evidence_for_classification": ["why this level fits the whole property"],
  "evidence_against_more_severe_level": ["why NOT the next heavier level"],
  "evidence_against_less_severe_level": ["why NOT the next lighter level"],
  "limitations": ["what photos did not show"],
  "curb_appeal_condition": "renovated|dated|distressed|unknown",
  "curb_appeal_confidence": 0-100,
  "curb_appeal_summary": "one sentence describing visible condition"
}

For curb_appeal_condition: renovated = modern finishes/move-in ready, dated = livable but visibly dated finishes, distressed = obvious disrepair or heavy wear, unknown = photos insufficient to judge. Never guess — use "unknown".`

// ─── Assessment ───────────────────────────────────────────────────────────────

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
  const base: RenovationAssessment = {
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
    evidenceForClassification: [],
    evidenceAgainstMoreSevereLevel: [],
    evidenceAgainstLessSevereLevel: [],
    limitations: [],
    provider: null,
    model: null,
  }

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

  if (!env.OPENROUTER_API_KEY && !providerOverride) {
    return {
      ...base,
      status: 'unavailable',
      photosExamined: uniquePhotos.length,
      error: 'No vision provider credentials configured',
      limitations: ['Vision provider not configured'],
    }
  }

  const provider =
    providerOverride ??
    createLLMProvider({
      provider: 'openrouter',
      apiKey: env.OPENROUTER_API_KEY as string,
      model: env.OPENROUTER_MODEL || 'google/gemini-2.5-flash',
    })

  const photos = uniquePhotos.slice(0, MAX_PHOTOS)
  let prompt = ''
  if (propertyContext) {
    prompt = 'Property context:\n'
    if (propertyContext.address) prompt += `Address: ${propertyContext.address}\n`
    if (propertyContext.squareFeet) prompt += `Square Feet: ${propertyContext.squareFeet}\n`
    if (propertyContext.yearBuilt) prompt += `Year Built: ${propertyContext.yearBuilt}\n`
    prompt += '\n'
  }
  prompt += RENOVATION_PROMPT

  const imagePayload = photos.map((url) => ({ url }))

  // Retry once on unparseable output — LLM formatting is nondeterministic
  let parsed: Record<string, unknown> | null = null
  let lastProviderError: string | null = null
  for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
    const result = await provider.execute({
      prompt,
      images: imagePayload,
      responseFormat: 'json',
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
    photosExamined: photos.length,
    majorObservations: list(parsed.major_observations),
    kitchenCondition: str(parsed.kitchen_condition),
    bathroomCondition: str(parsed.bathroom_condition),
    flooringCondition: str(parsed.flooring_condition),
    wallCeilingCondition: str(parsed.wall_ceiling_condition),
    exteriorCondition: str(parsed.exterior_condition),
    visibleMajorSystemConcerns: list(parsed.visible_major_system_concerns),
    structuralConcerns: list(parsed.structural_concerns),
    evidenceForClassification: list(parsed.evidence_for_classification),
    evidenceAgainstMoreSevereLevel: list(parsed.evidence_against_more_severe_level),
    evidenceAgainstLessSevereLevel: list(parsed.evidence_against_less_severe_level),
    limitations: list(parsed.limitations),
    provider: provider.name,
    model: provider.model,
    curbAppeal: (() => {
      const raw = String(parsed.curb_appeal_condition ?? '').toLowerCase()
      const condition = raw === 'renovated' || raw === 'dated' || raw === 'distressed' ? raw : 'unknown'
      const caConf = typeof parsed.curb_appeal_confidence === 'number' ? Math.min(100, Math.max(0, parsed.curb_appeal_confidence)) : null
      const summary = typeof parsed.curb_appeal_summary === 'string' ? parsed.curb_appeal_summary : null
      return condition !== 'unknown' || summary
        ? { condition: condition as CurbAppealCheck['condition'], source: 'vision' as const, confidence: caConf, summary, photosExamined: photos.length }
        : null
    })(),
  }
}

// ─── Comp curb-appeal check ──────────────────────────────────────────────────

export interface CurbAppealCheck {
  /** renovated | dated | distressed | unknown — ARV candidacy signal */
  condition: 'renovated' | 'dated' | 'distressed' | 'unknown'
  /** vision = verified from photos; price = inferred from top-of-market sale */
  source: 'vision' | 'price'
  confidence: number | null
  summary: string | null
  photosExamined: number
}

const CURB_APPEAL_PROMPT = `You are reviewing listing photos of a recently SOLD comparable property. Determine whether the sale price plausibly represents an AFTER-REPAIR (renovated/turnkey) value — i.e., whether this comp is a valid ARV candidate visually.

Return ONLY JSON:
{
  "condition": "renovated" | "dated" | "distressed" | "unknown",
  "confidence": 0-100,
  "summary": "one sentence describing visible condition"
}

- renovated: modern finishes, updated kitchen/baths, new flooring, move-in ready
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
  if (!env.OPENROUTER_API_KEY) return { ...base, summary: 'Vision provider not configured' }

  const provider = createLLMProvider({
    provider: 'openrouter',
    apiKey: env.OPENROUTER_API_KEY as string,
    model: env.OPENROUTER_MODEL || 'google/gemini-2.5-flash',
  })

  const result = await provider.execute({
    prompt: CURB_APPEAL_PROMPT,
    images: photos.map((url) => ({ url })),
    responseFormat: 'json',
  })
  if (!result.success || !result.data?.content) return { ...base, summary: 'Vision call failed' }

  const parsed = parseVisionJson(result.data.content)
  if (!parsed) return { ...base, summary: 'Unparseable vision response' }

  const raw = String(parsed.condition ?? '').toLowerCase()
  const condition =
    raw === 'renovated' || raw === 'dated' || raw === 'distressed' ? (raw as CurbAppealCheck['condition']) : 'unknown'
  const confidence =
    typeof parsed.confidence === 'number' ? Math.min(100, Math.max(0, parsed.confidence)) : null
  return {
    condition,
    source: 'vision',
    confidence,
    summary: typeof parsed.summary === 'string' ? parsed.summary : null,
    photosExamined: photos.length,
  }
}
