/**
 * Exterior match — does a comp's house look like the subject's house?
 *
 * One small decision-model call per comp with exactly two images: the
 * subject's listing cover photo and the comp's listing cover photo. It
 * answers three probabilities:
 *   - the subject cover photo shows the front of the house
 *   - the comp cover photo shows the front of the house
 *   - the two exteriors match (style, stories, roofline, garage, materials)
 *
 * Kept as its own call so the comp's other observable questions (condition,
 * price support, site exposure) never see a second property's photo.
 * Evidence only — the appraiser weighs it, it removes no comp by itself.
 */

import type { Env } from '../../types'
import { decisionsRun, isDecisionsAvailable } from '../decisions'
import { fetchImageAsBase64 } from '../llm/image-utils'

export interface CoverImage {
  base64: string
  content_type?: string
  /** Source URL, when the image came from a listing photo */
  url?: string | null
}

export interface ExteriorMatch {
  /** P(the comp's exterior matches the subject's). Null when not asked. */
  matchP: number | null
  /** P(the subject cover photo shows the front of the house) */
  subjectCoverIsFrontP: number | null
  /** P(the comp cover photo shows the front of the house) */
  compCoverIsFrontP: number | null
  model: string
  durationMs: number
}

/** How many leading listing photos are considered for the cover. */
const COVER_CANDIDATES = 8

const FRONT_OF_HOUSE =
  'the front exterior of a house — the street-facing facade, taken from outside. ' +
  'Score low for interior rooms, backyards, aerial or drone shots from far above, maps, floor plans, logos, or a blank image.'

export const EXTERIOR_MATCH_QUESTIONS = {
  subject_cover_is_front: {
    type: 'noul' as const,
    instructions: `Does the FIRST image (the SUBJECT listing cover photo) show ${FRONT_OF_HOUSE}`,
  },
  comp_cover_is_front: {
    type: 'noul' as const,
    instructions: `Does the SECOND image (the COMP listing cover photo) show ${FRONT_OF_HOUSE}`,
  },
  exterior_match: {
    type: 'noul' as const,
    instructions:
      'Compare the house in the FIRST image (SUBJECT) with the house in the SECOND image (COMP). ' +
      'Score the probability that the two exteriors match: same architectural style, same number of stories, ' +
      'similar roofline, similar garage or carport layout, similar exterior material, and a similar overall size. ' +
      'Judge the building only — ignore condition, paint color, landscaping, season, and photo quality. ' +
      'Score low when either image does not show the front of a house.',
  },
}

/**
 * The first listing photos that actually load, in listing order. Listing
 * photo lists can lead with dead links, so the first URL is not always usable.
 */
async function fetchCoverCandidates(photoUrls: string[]): Promise<CoverImage[]> {
  const urls = [...new Set(photoUrls.filter(Boolean))].slice(0, COVER_CANDIDATES)
  // No retries — a dead listing link stays dead; move to the next photo.
  const fetched = await Promise.all(urls.map((url) => fetchImageAsBase64(url, { maxRetries: 0 }).catch(() => null)))
  return fetched.flatMap((f, i) => (f && f.size > 0 ? [{ base64: f.base64, content_type: f.mimeType, url: urls[i] }] : []))
}

/** The first listing photo that loads — the cover when no model picks one. */
export async function fetchCoverImage(photoUrls: string[]): Promise<CoverImage | null> {
  return (await fetchCoverCandidates(photoUrls))[0] ?? null
}

/**
 * Pick the subject's cover photo: of the first few listing photos, the one
 * that best shows the front of the house. The listing's own first photo is
 * often the front but can be an aerial, a pool, or a tree-covered angle, and
 * every comp's exterior match is only as good as this reference image.
 * Falls back to the first photo that loads when the decision model is not
 * configured, cannot choose, or says none of them shows the front.
 */
export async function pickFrontCoverImage(env: Env, photoUrls: string[]): Promise<CoverImage | null> {
  const candidates = await fetchCoverCandidates(photoUrls)
  if (candidates.length <= 1 || !isDecisionsAvailable(env)) return candidates[0] ?? null
  const res = await decisionsRun(env, {
    state: {
      task: 'Choose the listing photo that best shows the front of the house.',
      imageOrder: candidates.map((_, i) => `photo_${i + 1}`),
    },
    questions: {
      front_photo: {
        type: 'choice',
        instructions:
          'Which photo gives the clearest view of the FRONT of the house — the street-facing facade, taken from outside, ' +
          'with the building itself visible and not hidden behind trees or vehicles? Prefer a ground-level front view ' +
          'over an aerial shot. Choose none when no photo shows the front of the house.',
        criteria: {
          ...Object.fromEntries(candidates.map((_, i) => [`photo_${i + 1}`, `Photo ${i + 1} in the order supplied`])),
          none: 'No photo shows the front of the house',
        },
      },
    },
    images: candidates.map((img) => ({ content_type: img.content_type, base64: img.base64 })),
  }).catch((err) => {
    console.warn(`[exterior-match] front-photo pick failed: ${err instanceof Error ? err.message : String(err)}`)
    return null
  })
  const choice = (res?.answers?.front_photo as { choice?: unknown } | undefined)?.choice
  const index = typeof choice === 'string' && /^photo_\d+$/.test(choice) ? Number(choice.slice(6)) - 1 : -1
  return candidates[index] ?? candidates[0]
}

/** Compare a comp's cover photo with the subject's. Null when either photo
 *  is missing, the decision model is not configured, or the call fails. */
export async function decisionsExteriorMatch(
  env: Env,
  input: {
    subjectCover: CoverImage | null | undefined
    compCover: CoverImage | null | undefined
    subjectAddress?: string | null
    compAddress?: string | null
  },
): Promise<ExteriorMatch | null> {
  if (!isDecisionsAvailable(env) || !input.subjectCover || !input.compCover) return null
  const started = Date.now()
  const res = await decisionsRun(env, {
    state: {
      task: 'Exterior comparison of two houses from their listing cover photos.',
      imageOrder: ['SUBJECT listing cover photo', 'COMP listing cover photo'],
      subjectAddress: input.subjectAddress ?? null,
      compAddress: input.compAddress ?? null,
    },
    questions: EXTERIOR_MATCH_QUESTIONS,
    images: [input.subjectCover, input.compCover].map((img) => ({ content_type: img.content_type, base64: img.base64 })),
  }).catch((err) => {
    console.warn(`[exterior-match] call failed: ${err instanceof Error ? err.message : String(err)}`)
    return null
  })
  const answers = (res?.answers ?? {}) as Record<string, { probability?: number }>
  const p = (name: keyof typeof EXTERIOR_MATCH_QUESTIONS) =>
    typeof answers[name]?.probability === 'number' ? answers[name]!.probability! : null
  if (p('exterior_match') === null) return null
  return {
    matchP: p('exterior_match'),
    subjectCoverIsFrontP: p('subject_cover_is_front'),
    compCoverIsFrontP: p('comp_cover_is_front'),
    model: env.DECISIONS_MODEL || 'gpt-6-luna',
    durationMs: Date.now() - started,
  }
}
