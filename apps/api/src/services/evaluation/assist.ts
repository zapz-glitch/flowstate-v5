/**
 * Assist sub-agent — the reasoning model the appraiser may consult.
 *
 * The appraiser owns the comp selection and the ARV. When it wants a
 * second read — "does this comp's evidence really support a renovated
 * tier?", "look over the satellite findings for the picks", "why might the
 * gate be rejecting this?" — it posts a reasoning request and this module
 * answers it from the frozen evidence bundle. The assist model has no
 * decision authority: it returns an answer, its confidence, and the
 * evidence it relied on, and the appraiser decides what to do with it.
 *
 * The model is the reasoning lane's model, so the assist-model A/B arm
 * (services/llm/assist-arms) decides which one answers.
 */

import { createReasoningProvider } from '../llm'
import type { HarnessEvidence } from './index'

export interface AssistFinding {
  compId: string | null
  question: string
  answer: string
  confidence: number
  /** Evidence fields the answer rests on, as the model cited them */
  evidence: string[]
  source: 'assist'
  model: string
  durationMs: number
}

type AssistEnv = Parameters<typeof createReasoningProvider>[0]

const ASSIST_SCHEMA = {
  type: 'object',
  properties: {
    answer: { type: 'string' },
    confidence: { type: 'number' },
    evidence: { type: 'array', items: { type: 'string' } },
  },
  required: ['answer', 'confidence', 'evidence'],
  additionalProperties: false,
} as const

const ASSIST_PROMPT = `You are a research assistant to a real-estate appraiser who is choosing comparable sales and an after-repair value. The appraiser asked you one question. You do not choose comps and you do not set the value — you answer the question so the appraiser can decide.

Answer ONLY from the supplied evidence. If the evidence cannot settle the question, say so plainly and give a low confidence — never guess, and never fill a gap with what is typical.

Return STRICT JSON:
{
  "answer": "<2-5 sentences that answer the question directly, with your reasoning>",
  "confidence": <0.0-1.0 — how well the supplied evidence supports your answer>,
  "evidence": ["<the specific fields or findings you relied on>"]
}`

/** Whether a reasoning model is configured to act as the assist sub-agent. */
export function assistModel(env: AssistEnv): string | null {
  return createReasoningProvider(env, 'openai/gpt-6-luna')?.model ?? null
}

/**
 * Answer one appraiser question from the evidence bundle. `comps` is what
 * the appraiser itself sees for each comp; a question about one comp gets
 * that comp's row, a general question gets the whole pool. Null when no
 * reasoning model is configured or the call fails — the appraiser simply
 * proceeds without the answer.
 */
export async function assistReason(
  env: AssistEnv,
  input: {
    evidence: HarnessEvidence
    /** The appraiser's own comp rows, in pool order */
    comps: Array<{ compId: string } & Record<string, unknown>>
    request: { compId: string | null; question: string }
    /** Gate feedback on the appraiser's last selection, when it was rejected */
    gateFeedback?: { failures: string[]; feedback: string[] } | null
  },
): Promise<AssistFinding | null> {
  const provider = createReasoningProvider(env, 'openai/gpt-6-luna')
  if (!provider) return null
  const started = Date.now()
  const { evidence, request } = input
  const comp = request.compId ? input.comps.find((c) => c.compId === request.compId) ?? null : null
  const state = {
    question: request.question,
    subject: evidence.subject,
    subjectCondition: evidence.renovationEvidence ?? null,
    subjectObservables: evidence.subjectObservables ?? null,
    marketBenchmark: evidence.marketBenchmark ?? null,
    ...(comp ? { comp } : { comps: input.comps }),
    ...(input.gateFeedback ? { gateRejection: input.gateFeedback } : {}),
  }
  const res = await provider.execute({
    prompt: `${ASSIST_PROMPT}\n\nSTATE:\n${JSON.stringify(state)}`,
    responseFormat: 'json',
    jsonSchema: { name: 'assist_answer', schema: ASSIST_SCHEMA },
    maxTokens: 4096,
  }).catch((err) => {
    console.warn(`[assist] ${provider.model} call failed: ${err instanceof Error ? err.message : String(err)}`)
    return null
  })
  const content = res?.success ? res.data?.content : null
  if (!content) return null
  let parsed: { answer?: unknown; confidence?: unknown; evidence?: unknown }
  try {
    parsed = JSON.parse(String(content).replace(/^```(?:json)?\s*|\s*```$/g, '').trim())
  } catch {
    return null
  }
  if (typeof parsed.answer !== 'string' || !parsed.answer.trim()) return null
  return {
    compId: comp ? request.compId : null,
    question: request.question,
    answer: parsed.answer.trim().slice(0, 2000),
    confidence: typeof parsed.confidence === 'number' && Number.isFinite(parsed.confidence)
      ? Math.max(0, Math.min(1, parsed.confidence))
      : 0,
    evidence: Array.isArray(parsed.evidence)
      ? parsed.evidence.filter((e): e is string => typeof e === 'string').slice(0, 12)
      : [],
    source: 'assist',
    model: provider.model,
    durationMs: Date.now() - started,
  }
}
