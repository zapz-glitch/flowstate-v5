/**
 * OpenAI Decisions API client — drop-in for the Workers-AI Clef reads.
 *
 * Decisions is the same question-types API shape the pipeline already
 * uses (noul → predicate, choice → choice, score → score) backed by
 * gpt-6-luna on a dedicated low-latency endpoint. One request evaluates
 * every question against shared context + images (up to 128, inline
 * data URLs only), replacing N Clef chunk calls with a single call.
 *
 * The returned `answers` map mirrors the Clef answer shape so every
 * downstream reader (prob/choicePick/scoreIdx/zone merges) works
 * unchanged: predicate → {probability}, choice → {choice, probabilities,
 * confidence}, score → {score, probabilities, confidence}.
 */

export interface DecisionsEnv {
  OPENAI_API_KEY?: string
  /** Decisions model — default gpt-6-luna (the only supported model today) */
  DECISIONS_MODEL?: string
  /** Evidence lane backend: 'decisions' (default) or 'jev' (TypeSafe JEV).
   *  'jev' sends text-only and map-tile (imageLane:'map') reads to JEV;
   *  photo-bearing reads stay on Decisions (JEV's ~280px image floor). */
  EVIDENCE_BACKEND?: string
  JEV_API_KEY?: string
  /** JEV endpoint — default TypeSafe systemone */
  TYPESAFE_URL?: string
  /** JEV model — default jev-latest */
  JEV_MODEL?: string
}

interface ClefStyleQuestion {
  type: 'noul' | 'choice' | 'score'
  instructions: string
  /** choice → {value: description} map; score → ordered level descriptions */
  criteria?: Record<string, string> | string[]
}

const DECISIONS_URL = 'https://api.openai.com/v1/decisions'

/** True when the run's evidence backend can answer — Decisions by default,
 *  JEV when the run is pinned to the JEV lane. */
export function isDecisionsAvailable(env: DecisionsEnv): boolean {
  return env.EVIDENCE_BACKEND === 'jev' ? !!env.JEV_API_KEY : !!env.OPENAI_API_KEY
}

export async function decisionsRun(
  env: DecisionsEnv,
  params: {
    state: unknown
    questions: Record<string, ClefStyleQuestion>
    images?: Array<{ content_type?: string; base64: string }>
    /** Interleaved sections — a text part followed by its images, in order.
     *  Batch mode uses this so each comp's photos group under its own
     *  header instead of pooling anonymously. Total image cap 128. */
    sections?: Array<{ text?: string; images?: Array<{ content_type?: string; base64: string }> }>
    /** 'map' marks satellite/streetview tiles (all >=640px, JEV-safe).
     *  Anything else — listing photos, comp covers — is 'photo': JEV
     *  rejects images under ~280px, so photo calls stay on Decisions
     *  even when the run is pinned to the JEV backend. Text-only calls
     *  always take the pinned backend. */
    imageLane?: 'map' | 'photo'
  },
): Promise<{ answers?: Record<string, unknown> }> {
  if (env.EVIDENCE_BACKEND === 'jev') {
    const hasImages = (params.images?.length ?? 0) > 0 ||
      (params.sections ?? []).some((s) => (s.images?.length ?? 0) > 0)
    if (!hasImages || params.imageLane === 'map') return jevRun(env, params)
    // photo-lane call → fall through to the Decisions lane
  }
  if (!env.OPENAI_API_KEY) throw new Error('DECISIONS: no OPENAI_API_KEY')

  const content: Array<Record<string, unknown>> = [
    { type: 'input_text', text: typeof params.state === 'string' ? params.state : JSON.stringify(params.state) },
  ]
  const pushImg = (img: { content_type?: string; base64: string }) => {
    content.push({
      type: 'input_image',
      image_url: `data:${img.content_type || 'image/jpeg'};base64,${img.base64}`,
    })
  }
  let imgBudget = 128
  for (const s of params.sections ?? []) {
    if (s.text) content.push({ type: 'input_text', text: s.text })
    for (const img of s.images ?? []) {
      if (imgBudget <= 0) break
      pushImg(img); imgBudget--
    }
  }
  for (const img of params.images ?? []) {
    if (imgBudget <= 0) break
    pushImg(img); imgBudget--
  }

  const questions = Object.entries(params.questions).map(([name, q]) => {
    if (q.type === 'choice') {
      const criteria = (q.criteria ?? {}) as Record<string, string>
      return {
        type: 'choice',
        name,
        instructions: q.instructions,
        choices: Object.entries(criteria).map(([value, description]) => ({ value, description })),
      }
    }
    if (q.type === 'score') {
      const criteria = Array.isArray(q.criteria) ? q.criteria : []
      return {
        type: 'score',
        name,
        instructions: q.instructions,
        levels: criteria.map((label) => ({ label })),
      }
    }
    return { type: 'predicate', name, instructions: q.instructions }
  })

  const call = async (): Promise<Response> =>
    fetch(DECISIONS_URL, {
      method: 'POST',
      signal: AbortSignal.timeout(60_000),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: env.DECISIONS_MODEL || 'gpt-6-luna',
        input: [{ role: 'user', content }],
        questions,
      }),
    })

  // One retry on transient failure (timeout / network / 5xx). A hung or
  // flapping call gets refired once before the caller's fallback takes over.
  let resp: Response
  try {
    resp = await call()
  } catch (first) {
    console.warn('DECISIONS: call failed, retrying once —', first)
    resp = await call()
  }
  if (!resp.ok && resp.status >= 500) {
    const retry = await call().catch(() => null)
    if (retry) resp = retry
  }
  if (!resp.ok) {
    const body = await resp.text().catch(() => '')
    throw new Error(`DECISIONS: HTTP ${resp.status} — ${body.slice(0, 300)}`)
  }

  const data = (await resp.json()) as {
    answers?: Array<{
      type: string
      name?: string | null
      probability?: number
      choice?: string | boolean
      score?: number
      confidence?: number
      probabilities?: Array<{ value: string | number | boolean; label?: string; probability: number }>
    }>
  }

  // Re-key the answers array into the Clef map shape downstream readers
  // already consume: predicate → {probability}, choice/score →
  // {choice|score, probabilities: {key: p}, confidence}.
  const answers: Record<string, unknown> = {}
  for (const a of data.answers ?? []) {
    if (!a?.name) continue
    const probMap: Record<string, number> = {}
    for (const p of a.probabilities ?? []) {
      if (typeof p.probability === 'number') probMap[String(p.value)] = p.probability
    }
    if (a.type === 'predicate') {
      answers[a.name] = { probability: a.probability ?? 0 }
    } else if (a.type === 'choice') {
      answers[a.name] = { choice: a.choice, probabilities: probMap, confidence: a.confidence }
    } else if (a.type === 'score') {
      answers[a.name] = { score: a.score ?? 0, probabilities: probMap, confidence: a.confidence }
    }
  }
  return { answers }
}

/**
 * TypeSafe JEV backend — same question contract ({state, questions} →
 * {answers}) as the Decisions lane, different vendor. Images ride along as
 * `assets` reference strings in the state text (TypeSafe-Danger-Zone-Images
 * opt-in header on image-bearing calls).
 *
 * JEV answers come back keyed by question name:
 *   noul   → { noul: 0-1 }            → { probability }
 *   choice → { choice: "<value>" }    → { choice, probabilities?, confidence }
 *   score  → { score: number }        → { score, probabilities?, confidence }
 * Any extra fields (a `probabilities` map, confidence) pass through so
 * downstream readers degrade the same way they do on a sparse Decisions
 * answer.
 */
async function jevRun(
  env: DecisionsEnv,
  params: Parameters<typeof decisionsRun>[1],
): Promise<{ answers?: Record<string, unknown> }> {
  if (!env.JEV_API_KEY) throw new Error('JEV: no JEV_API_KEY')
  const url = env.TYPESAFE_URL || 'https://api.typesafe.ai/v1/systemone'
  // The bearer key goes in every request — never forward it to a scheme or
  // host that isn't the API it belongs to.
  const u = new URL(url)
  if (u.protocol !== 'https:' || !(u.hostname === 'typesafe.ai' || u.hostname.endsWith('.typesafe.ai')))
    throw new Error('JEV: TYPESAFE_URL must be https on typesafe.ai')

  // JEV images: each is an `assets` entry keyed by a reference string placed
  // anywhere in the request text (state/instructions/criteria). Rebuild the
  // state so sections keep their text-then-photos order: base state, then
  // each section's text followed by its image refs, then flat images.
  const assets: Record<string, { type: 'image'; format: string; data_base64: string }> = {}
  let n = 0
  const img = (i: { content_type?: string; base64: string }): string => {
    const ref = `jev-img-${n++}-${Math.random().toString(36).slice(2, 10)}`
    const format = (i.content_type || 'image/jpeg').split('/')[1]?.toLowerCase() || 'jpg'
    assets[ref] = { type: 'image', format, data_base64: i.base64 }
    return ref
  }
  let state = typeof params.state === 'string' ? params.state : JSON.stringify(params.state)
  for (const s of params.sections ?? []) {
    state += `\n\n${s.text ?? ''}\n${(s.images ?? []).map(img).join('\n')}`
  }
  const flat = (params.images ?? []).map(img).join('\n')
  if (flat) state += `\n\n${flat}`

  const hasImages = Object.keys(assets).length > 0
  const call = async (): Promise<Response> =>
    fetch(url, {
      method: 'POST',
      signal: AbortSignal.timeout(60_000),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.JEV_API_KEY}`,
        // Opt-in required for any request containing images or Box questions
        ...(hasImages ? { 'TypeSafe-Danger-Zone-Images': 'true' } : {}),
      },
      body: JSON.stringify({
        state,
        model: env.JEV_MODEL || 'jev-latest',
        questions: params.questions,
        ...(hasImages ? { assets } : {}),
      }),
    })
  let resp: Response
  try {
    resp = await call()
  } catch (first) {
    console.warn('JEV: call failed, retrying once —', first)
    resp = await call()
  }
  if (!resp.ok && resp.status >= 500) {
    const retry = await call().catch(() => null)
    if (retry) resp = retry
  }
  if (!resp.ok) {
    // Upstream error bodies can carry request internals — log them, don't
    // put them in the exception the job streams back to the caller.
    console.warn('JEV: HTTP', resp.status, await resp.text().catch(() => ''))
    throw new Error(`JEV: HTTP ${resp.status}`)
  }

  const data = (await resp.json()) as {
    answers?: Record<string, {
      noul?: number
      probability?: number
      choice?: string
      score?: number
      confidence?: number
      probabilities?: Record<string, number>
    }>
  }
  const answers: Record<string, unknown> = {}
  for (const [name, a] of Object.entries(data.answers ?? {})) {
    if (!a) continue
    const q = params.questions[name]
    if (q?.type === 'choice') {
      answers[name] = { choice: a.choice, probabilities: a.probabilities ?? {}, confidence: a.confidence }
    } else if (q?.type === 'score') {
      answers[name] = { score: a.score ?? a.noul ?? 0, probabilities: a.probabilities ?? {}, confidence: a.confidence }
    } else {
      answers[name] = { probability: a.noul ?? a.probability ?? 0 }
    }
  }
  return { answers }
}
