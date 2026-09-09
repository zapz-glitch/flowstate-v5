import type { Env } from '../../types'
import type { PythonRequest, PythonResult } from './python'

export interface PythonExecutionContext { jobId: string; userId?: string }

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
  return JSON.stringify(value)
}

export async function evaluateHostedPython(request: PythonRequest, env: Env, context?: PythonExecutionContext): Promise<PythonResult> {
  if (env.ENVIRONMENT !== 'staging' || env.EVALUATION_ENGINE !== 'python-v4') throw new Error('Hosted Python requires explicit staging configuration')
  if (!context?.jobId || !context.userId) throw new Error('Hosted Python requires authenticated job ownership')
  const url = new URL(env.V4_HOSTED_API_URL || '')
  if (url.protocol !== 'https:' || !/^[a-z0-9-]+\.onrender\.com$/.test(url.hostname) || url.port || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Hosted Python requires a Render HTTPS origin')
  let credentials: Record<string, { token: string; tenantId: string }>
  try { credentials = JSON.parse(env.V4_HOSTED_USER_CREDENTIALS || '{}') } catch { throw new Error('Hosted Python credentials are invalid') }
  const credential = credentials && Object.hasOwn(credentials, context.userId) ? credentials[context.userId] : undefined
  if (!credential || typeof credential.token !== 'string' || credential.token.length < 32 || typeof credential.tenantId !== 'string' || !credential.tenantId) throw new Error('Hosted Python is not configured for this user')
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical({ jobId: context.jobId, userId: context.userId, request })))
  const key = `v4-${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`
  const signal = AbortSignal.timeout(20000)
  const send = async (path: string, body?: unknown): Promise<Record<string, unknown>> => {
    const response = await fetch(new URL(path, url), {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal,
      headers: { Authorization: `Bearer ${credential.token}`, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'Idempotency-Key': key }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    if (!response.ok) throw new Error(`Hosted Python ${body === undefined ? 'read' : 'submission'} failed (${response.status})`)
    const data: unknown = await response.json()
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid hosted Python response')
    return data as Record<string, unknown>
  }
  const { settings, methodology_version, ...evidence } = request
  if (methodology_version !== 'evaluation-v4' || !request.evaluation_date || request.comps.length > 500) throw new Error('Invalid hosted Python evidence')
  const submitted = await send('/v1/evaluations', { settings, candidate_evidence_mode: 'preloaded', evaluations: [{ ...evidence, idempotency_key: key }] })
  const entries = submitted.evaluations
  if (!Array.isArray(entries) || entries.length !== 1 || entries[0]?.idempotency_key !== key || typeof submitted.batch_id !== 'string' || !/^[a-f0-9-]{36}$/i.test(entries[0]?.evaluation_id ?? '')) throw new Error('Invalid hosted Python submission')
  const id = entries[0].evaluation_id as string
  for (;;) {
    signal.throwIfAborted()
    const data = await send(`/v1/evaluations/${id}`)
    if (data.evaluation_id !== id || data.batch_id !== submitted.batch_id || data.tenant_id !== credential.tenantId || data.requested_by_user_id !== context.userId) throw new Error('Hosted Python ownership or job mismatch')
    if (['COMPLETED', 'REVIEW_REQUIRED', 'INSUFFICIENT_COMPS', 'INSUFFICIENT_INVESTOR_DATA', 'INCOMPLETE'].includes(String(data.status))) {
      const result = data.result as PythonResult | null
      if (!result || result.methodology_version !== 'evaluation-v4' || !Array.isArray(result.decisions)) throw new Error('Invalid hosted Python result')
      return result
    }
    if (!['QUEUED', 'RUNNING', 'RETRY_WAIT'].includes(String(data.status))) throw new Error('Hosted Python evaluation did not complete')
    await new Promise<void>((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(new Error('Hosted Python evaluation timed out')) }
      const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, 500)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })
  }
}
