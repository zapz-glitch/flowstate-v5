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
}

interface ClefStyleQuestion {
  type: 'noul' | 'choice' | 'score'
  instructions: string
  /** choice → {value: description} map; score → ordered level descriptions */
  criteria?: Record<string, string> | string[]
}

const DECISIONS_URL = 'https://api.openai.com/v1/decisions'

export function isDecisionsAvailable(env: DecisionsEnv): boolean {
  return !!env.OPENAI_API_KEY
}

export async function decisionsRun(
  env: DecisionsEnv,
  params: {
    state: unknown
    questions: Record<string, ClefStyleQuestion>
    images?: Array<{ content_type?: string; base64: string }>
  },
): Promise<{ answers?: Record<string, unknown> }> {
  if (!env.OPENAI_API_KEY) throw new Error('DECISIONS: no OPENAI_API_KEY')

  const content: Array<Record<string, unknown>> = [
    { type: 'input_text', text: typeof params.state === 'string' ? params.state : JSON.stringify(params.state) },
  ]
  for (const img of params.images ?? []) {
    content.push({
      type: 'input_image',
      image_url: `data:${img.content_type || 'image/jpeg'};base64,${img.base64}`,
    })
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

  const resp = await fetch(DECISIONS_URL, {
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
