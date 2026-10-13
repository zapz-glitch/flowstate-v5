/**
 * Per-report call log — every outbound API call a run makes, kept 90 days.
 *
 * One log per job: the property provider, listing scrapes, satellite and
 * street imagery, every decision-model call, and every reasoning-model
 * call (backup reader, assist sub-agent, appraiser), each with its request,
 * its response, timing and status. Stored in KV under the job id with a
 * 90-day expiry; under `wrangler dev` that is local disk.
 *
 * Layout: one index value per job (the entries, with small bodies inline)
 * plus one value per large body, written the moment the call finishes. A
 * run with a hundred comps scrapes tens of megabytes of listing pages —
 * writing each body out as it arrives keeps the run's memory flat and
 * means no body is ever dropped for size.
 *
 * How it captures "every call" without threading a recorder through every
 * service: the run executes inside an AsyncLocalStorage scope, and a thin
 * wrapper around the global `fetch` records any call made inside one.
 * Calls made outside a scope pass straight through, untouched.
 *
 * Replay: a run can be handed an earlier run's log. A call whose request
 * is byte-for-byte the same as a logged one is answered from the log
 * instead of the network. That is what makes the assist-model A/B fair —
 * arm B sees the same provider data, the same listing pages and the same
 * decision-model answers as arm A; only calls that genuinely differ (the
 * assist model's own, and anything downstream of a different answer) go out.
 *
 * Never stored: API keys (redacted from URLs; headers are not recorded) and
 * image bytes (a request's inline images are replaced by a short digest,
 * binary responses keep only their type and size).
 */

import { AsyncLocalStorage } from 'node:async_hooks'

export const CALL_LOG_TTL_SECONDS = 90 * 24 * 60 * 60
/** Bodies up to this size live inline in the index; larger ones get their own value. */
const INLINE_BODY_CHARS = 4_000
/** A single body larger than this is not stored (KV values cap at 25 MiB). */
const MAX_BODY_CHARS = 12_000_000
/** A failed call's response is kept only this far — error pages repeat. */
const ERROR_BODY_CHARS = 2_000

export type CallKind = 'provider' | 'scrape' | 'imagery' | 'decisions' | 'reasoning' | 'photo' | 'other'

export interface CallEntry {
  seq: number
  at: string
  ms: number
  kind: CallKind
  method: string
  /** Request URL with credentials redacted */
  url: string
  /** The model a decision/reasoning call was sent to */
  model?: string
  status: number | null
  /** sha-256 of method + redacted URL + request body — the replay key */
  requestHash: string
  /** Request body, inline images replaced by a digest. Null when not text
   *  or when it is stored separately (see requestKey). */
  request: string | null
  /** Response body when it is text/JSON and small; null for binary, or
   *  when it is stored separately (see responseKey). */
  response: string | null
  /** Store keys of bodies too large to keep inline */
  requestKey?: string
  responseKey?: string
  responseType: string | null
  responseBytes: number | null
  /** A body was cut (error page) or could not be stored */
  truncated: boolean
  /** Answered from an earlier run's log instead of the network */
  replayed: boolean
  error?: string
}

export interface CallLog {
  version: 1
  jobId: string
  userId: string | null
  address: string | null
  /** Free-form run labels — harness, A/B arm, models */
  meta: Record<string, unknown>
  startedAt: string
  finishedAt: string | null
  /** Job whose log this run replayed from, if any */
  replayedFrom: string | null
  entries: CallEntry[]
}

interface CallLogStore {
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>
  get(key: string): Promise<string | null>
}

interface Scope {
  log: CallLog
  store: CallLogStore | null
  /** In-flight writes of large bodies — awaited before the index is saved */
  pending: Promise<void>[]
  replay: Map<string, CallEntry> | null
}

/** Set on a response answered from an earlier run's log. A caller that
 *  backs off before retrying can skip the wait — nothing is rate limiting. */
export const REPLAYED_HEADER = 'x-call-log-replayed'

const scopes = new AsyncLocalStorage<Scope>()
const SECRET_PARAMS = /^(key|api_key|apikey|token|access_token|client_secret|signature|sig)$/i

export function callLogKey(jobId: string): string {
  return `call-log:v1:${jobId}`
}

function bodyKey(jobId: string, seq: number, part: 'req' | 'res'): string {
  return `${callLogKey(jobId)}:${part}:${seq}`
}

export function newCallLog(init: { jobId: string; userId?: string | null; address?: string | null; meta?: Record<string, unknown>; replayedFrom?: string | null }): CallLog {
  return {
    version: 1,
    jobId: init.jobId,
    userId: init.userId ?? null,
    address: init.address ?? null,
    meta: init.meta ?? {},
    startedAt: new Date().toISOString(),
    finishedAt: null,
    replayedFrom: init.replayedFrom ?? null,
    entries: [],
  }
}

/** Strip credentials from a URL so it is safe to store and stable to hash. */
export function redactUrl(raw: string): string {
  try {
    const url = new URL(raw)
    for (const name of [...url.searchParams.keys()]) {
      if (SECRET_PARAMS.test(name)) url.searchParams.set(name, 'REDACTED')
    }
    url.username = ''
    url.password = ''
    return url.toString()
  } catch {
    return raw
  }
}

export function classifyCall(url: string): CallKind {
  let host = ''
  let path = ''
  try { const u = new URL(url); host = u.hostname; path = u.pathname } catch { return 'other' }
  if (host === 'api.openai.com' && path.includes('/decisions')) return 'decisions'
  if (host === 'api.anthropic.com' || host === 'openrouter.ai' || host === 'api.openai.com' || host.endsWith('generativelanguage.googleapis.com')) return 'reasoning'
  if (host.endsWith('scrapfly.io') || host.endsWith('firecrawl.dev') || host === 'www.redfin.com' || host.endsWith('duckduckgo.com')) return 'scrape'
  if (host === 'maps.googleapis.com' || host.endsWith('arcgisonline.com') || host.endsWith('nationalmap.gov')) return 'imagery'
  if (/corelogic|cotality|attomdata|attom\./.test(host)) return 'provider'
  if (/cdn-redfin|rdcpix|zillowstatic|photos\./.test(host)) return 'photo'
  return 'other'
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Replace inline base64 images with a short digest — the log keeps what
 *  was sent without storing megabytes of pixels. */
function stripInlineImages(body: string): string {
  return body.replace(/(data:image\/[a-z0-9.+-]+;base64,)([A-Za-z0-9+/=]{200,})/g, (_m, prefix: string, data: string) =>
    `${prefix}[${data.length} chars ${data.slice(0, 12)}…${data.slice(-12)}]`)
    .replace(/("(?:base64|data)"\s*:\s*")([A-Za-z0-9+/=]{2000,})(")/g, (_m, a: string, data: string, z: string) =>
      `${a}[${data.length} chars ${data.slice(0, 12)}…${data.slice(-12)}]${z}`)
}

/** Credential fields redacted before any request/response body lands in the
 *  call log — a 90-day observability record must never retain secrets. */
const CREDENTIAL_KEYS = /("(?:access[_-]?token|refresh[_-]?token|client[_-]?secret|api[_-]?key|apikey|password|secret|token|authorization)"\s*:\s*")((?:[^"\\]|\\.)*)(")/gi

const REDACTED = '[REDACTED]'

function redactCredentials(body: string): string {
  return body
    .replace(CREDENTIAL_KEYS, `$1${REDACTED}$3`)
    .replace(/((?:access[_-]?token|refresh[_-]?token|client[_-]?secret|api[_-]?key|apikey|key|sig|signature|password|secret|token)=)([^&\s"']+)/gi, `$1${REDACTED}`)
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/g, `$1${REDACTED}`)
}

function sanitizeLoggedBody(body: string): string {
  return redactCredentials(stripInlineImages(body))
}

const isTextual = (type: string | null) =>
  !!type && /json|text|xml|javascript|html|event-stream|x-www-form-urlencoded/i.test(type)

function requestParts(input: RequestInfo | URL, init?: RequestInit): { url: string; method: string; body: string | null } {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
  const method = (init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET')).toUpperCase()
  const body = typeof init?.body === 'string' ? init.body : null
  return { url, method, body }
}

type FetchFn = typeof fetch

/**
 * Wrap a fetch so calls made inside a call-log scope are recorded (and
 * replayed when the scope carries an earlier log). Outside a scope it is
 * the original fetch.
 */
export function recordingFetch(original: FetchFn): FetchFn {
  const wrapped = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const scope = scopes.getStore()
    if (!scope) return original(input, init)

    const { url, method, body } = requestParts(input, init)
    const safeUrl = redactUrl(url)
    const started = Date.now()
    const entry: CallEntry = {
      // Numbered and appended before anything is awaited: calls start in
      // bursts, and two that shared a number would share (and overwrite)
      // each other's stored bodies.
      seq: scope.log.entries.length + 1,
      at: new Date(started).toISOString(),
      ms: 0,
      kind: classifyCall(url),
      method,
      url: safeUrl,
      status: null,
      requestHash: '',
      request: null,
      response: null,
      responseType: null,
      responseBytes: null,
      truncated: false,
      replayed: false,
    }
    scope.log.entries.push(entry)
    entry.requestHash = await sha256(`${method}\n${safeUrl}\n${body ?? ''}`)
    // Small bodies ride in the index; large ones are written out now under
    // their own key. A body that cannot be stored marks the entry truncated.
    const keep = (part: 'req' | 'res', text: string): void => {
      if (text.length <= INLINE_BODY_CHARS) {
        if (part === 'req') entry.request = text; else entry.response = text
        return
      }
      if (!scope.store || text.length > MAX_BODY_CHARS) { entry.truncated = true; return }
      const key = bodyKey(scope.log.jobId, entry.seq, part)
      if (part === 'req') entry.requestKey = key; else entry.responseKey = key
      scope.pending.push(
        scope.store.put(key, text, { expirationTtl: CALL_LOG_TTL_SECONDS }).catch(() => {
          entry.truncated = true
          if (part === 'req') delete entry.requestKey; else delete entry.responseKey
        }),
      )
    }
    if (body != null) {
      const model = (entry.kind === 'reasoning' || entry.kind === 'decisions') ? /"model"\s*:\s*"([^"]{1,120})"/.exec(body)?.[1] : undefined
      if (model) entry.model = model
      keep('req', sanitizeLoggedBody(body))
    }

    const logged = scope.replay?.get(entry.requestHash)
    if (logged && logged.status != null) {
      const text = logged.response
        ?? (logged.responseKey && scope.store ? await scope.store.get(logged.responseKey).catch(() => null) : null)
      // A sanitized body can't drive a live caller — a replayed
      // "access_token":"[REDACTED]" would break downstream auth. Refetch.
      if (text != null && !text.includes(REDACTED)) {
        entry.replayed = true
        entry.status = logged.status
        entry.responseType = logged.responseType
        entry.responseBytes = logged.responseBytes
        keep('res', sanitizeLoggedBody(text))
        entry.ms = Date.now() - started
        return new Response(text, {
          status: logged.status,
          headers: { ...(logged.responseType ? { 'content-type': logged.responseType } : {}), [REPLAYED_HEADER]: '1' },
        })
      }
    }

    try {
      const response = await original(input, init)
      entry.ms = Date.now() - started
      entry.status = response.status
      entry.responseType = response.headers.get('content-type')
      if (isTextual(entry.responseType)) {
        // Read a clone so the caller still gets an untouched body.
        const text = await response.clone().text().catch(() => null)
        if (text != null) {
          entry.responseBytes = text.length
          if (response.ok || text.length <= ERROR_BODY_CHARS) keep('res', sanitizeLoggedBody(text))
          else { entry.response = sanitizeLoggedBody(text.slice(0, ERROR_BODY_CHARS)); entry.truncated = true }
        }
      } else {
        const length = Number(response.headers.get('content-length'))
        entry.responseBytes = Number.isFinite(length) && length > 0 ? length : null
      }
      return response
    } catch (err) {
      entry.ms = Date.now() - started
      entry.error = err instanceof Error ? err.message : String(err)
      throw err
    }
  }
  return wrapped as FetchFn
}

let installed = false
/** Install the recording wrapper on the global fetch. Idempotent. */
export function installCallRecorder(): void {
  if (installed) return
  installed = true
  globalThis.fetch = recordingFetch(globalThis.fetch.bind(globalThis))
}

/**
 * Run `fn` with every outbound call recorded into `log`. `store` receives
 * large bodies as they arrive; `replayFrom` is an earlier run's log whose
 * identical calls are answered without touching the network.
 */
export async function runWithCallLog<T>(
  log: CallLog,
  opts: { store?: CallLogStore | null; replayFrom?: CallLog | null },
  fn: () => Promise<T>,
): Promise<T> {
  installCallRecorder()
  // A call is replayable when its response was kept whole — inline or by
  // key. A failed call replays too (from the kept head of its error page):
  // the next run must see the same failures to be judging the same evidence.
  const failed = (e: CallEntry) => e.status != null && e.status >= 400
  const replay = opts.replayFrom
    ? new Map(opts.replayFrom.entries
        .filter((e) => (failed(e) && e.response != null) || (!e.truncated && (e.response != null || e.responseKey)))
        .map((e) => [e.requestHash, e]))
    : null
  const scope: Scope = { log, store: opts.store ?? null, pending: [], replay }
  pendingWrites.set(log, scope.pending)
  return scopes.run(scope, fn)
}

/** Large-body writes still in flight for a log — saveCallLog waits on them. */
const pendingWrites = new WeakMap<CallLog, Promise<void>[]>()

/** Persist a finished log's index for 90 days, after its large bodies have
 *  landed. Never throws — the log is an audit trail, not part of the
 *  evaluation. */
export async function saveCallLog(store: CallLogStore | undefined | null, log: CallLog): Promise<boolean> {
  if (!store) return false
  log.finishedAt = new Date().toISOString()
  try {
    await Promise.allSettled(pendingWrites.get(log) ?? [])
    await store.put(callLogKey(log.jobId), JSON.stringify(log), { expirationTtl: CALL_LOG_TTL_SECONDS })
    return true
  } catch (err) {
    console.warn(`[call-log] save failed for ${log.jobId}: ${err instanceof Error ? err.message : String(err)}`)
    return false
  }
}

export async function loadCallLog(store: CallLogStore | undefined | null, jobId: string): Promise<CallLog | null> {
  if (!store) return null
  try {
    const raw = await store.get(callLogKey(jobId))
    const log = raw ? (JSON.parse(raw) as CallLog) : null
    return log?.version === 1 && Array.isArray(log.entries) ? log : null
  } catch {
    return null
  }
}

/** One call with its full request and response, large bodies resolved. */
export async function loadCallBodies(store: CallLogStore | undefined | null, entry: CallEntry): Promise<{ request: string | null; response: string | null }> {
  const read = async (inline: string | null, key?: string) =>
    inline ?? (key && store ? await store.get(key).catch(() => null) : null)
  return { request: await read(entry.request, entry.requestKey), response: await read(entry.response, entry.responseKey) }
}

export interface CallSummaryRow { calls: number; replayed: number; failed: number; ms: number }

/** Counts and timing per kind of call — the at-a-glance view of a log. */
export function summarizeCallLog(log: CallLog): Record<string, CallSummaryRow> {
  const out: Record<string, CallSummaryRow> = {}
  for (const e of log.entries) {
    const row = (out[e.kind] ??= { calls: 0, replayed: 0, failed: 0, ms: 0 })
    row.calls++
    if (e.replayed) row.replayed++
    if (e.error || (e.status != null && e.status >= 400)) row.failed++
    row.ms += e.ms
  }
  return out
}

/** Live (not replayed) model calls, grouped by model — latency per model. */
export function summarizeModelCalls(log: CallLog): Record<string, CallSummaryRow & { avgMs: number; maxMs: number }> {
  const out: Record<string, CallSummaryRow & { avgMs: number; maxMs: number }> = {}
  for (const e of log.entries) {
    if (!e.model) continue
    const row = (out[e.model] ??= { calls: 0, replayed: 0, failed: 0, ms: 0, avgMs: 0, maxMs: 0 })
    if (e.replayed) { row.replayed++; continue }
    row.calls++
    if (e.error || (e.status != null && e.status >= 400)) row.failed++
    row.ms += e.ms
    row.maxMs = Math.max(row.maxMs, e.ms)
    row.avgMs = Math.round(row.ms / row.calls)
  }
  return out
}
