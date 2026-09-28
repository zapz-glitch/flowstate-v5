'use server'

import { getSession } from '@/lib/api'
import type { OfferWorkflow } from '@/lib/client-api'
import { getCloudflareEnv } from '@/lib/cloudflare'

async function getDashboardSecret(): Promise<string> {
  const env = await getCloudflareEnv()
  return env.DASHBOARD_INTERNAL_SECRET || ''
}

async function internalFetch(path: string): Promise<Response | null> {
  const session = await getSession()
  if (!session?.user) return null
  const secret = await getDashboardSecret()
  if (!secret) return null
  return fetch(`${process.env.NEXT_PUBLIC_API_URL}${path}`, {
    headers: {
      'X-Dashboard-User-Id': session.user.id,
      'X-Dashboard-Secret': secret,
    },
  })
}

/** Give Offer queue item — engine shape (proxied via /v1/pipeline/queue). */
export interface PipelineItem {
  leadId: string
  opportunityId: string | null
  displayName: string | null
  address: string | null
  wholesalePrice: number | null
  /** Asking price — enriched server-side from the saved report */
  listPrice?: number | null
  evalReportUrl: string | null
  draft: unknown
  /** Realtor conversation-log notes shipped by the engine (latest entries first) */
  conditionNotes?: string[]
  /** SQLite timestamp "YYYY-MM-DD HH:MM:SS" (UTC) */
  queuedAt: string
}

export interface PipelineMetrics {
  newReachouts: number
  responses: number
  responseRatePct: number | null
  reactivations: number
  sentToUnderwriting: number
  offersPrepped: number
  offersSent: number
  hotLeads: number
  evalsFailed: number
  avgPrepMinutes: number | null
}

export async function getOfferQueue(): Promise<{
  ok: boolean
  items: PipelineItem[]
  count: number
  avgPrepMinutes: number | null
}> {
  const res = await internalFetch('/v1/pipeline/queue')
  if (!res?.ok) return { ok: false, items: [], count: 0, avgPrepMinutes: null }
  const data = (await res.json()) as {
    count?: number
    avgPrepMinutes?: number | null
    items?: PipelineItem[]
    queue?: { count?: number; avgPrepMinutes?: number | null; items?: PipelineItem[] }
  }
  // Engine returns the queue under `queue` when called via /dashboard, or
  // top-level via /queue — handle both.
  const q = data.queue ?? data
  return {
    ok: true,
    items: q.items ?? [],
    count: q.count ?? q.items?.length ?? 0,
    avgPrepMinutes: q.avgPrepMinutes ?? null,
  }
}

export async function getPipelineMetrics(): Promise<{ ok: boolean; metrics: PipelineMetrics | null }> {
  const res = await internalFetch('/v1/pipeline/metrics')
  if (!res?.ok) return { ok: false, metrics: null }
  const data = (await res.json()) as {
    metrics?: Partial<PipelineMetrics>
    queue?: { avgPrepMinutes?: number | null }
  }
  const m = data.metrics
  if (!m) return { ok: true, metrics: null }
  return {
    ok: true,
    metrics: {
      newReachouts: m.newReachouts ?? 0,
      responses: m.responses ?? 0,
      responseRatePct: m.responseRatePct ?? null,
      reactivations: m.reactivations ?? 0,
      sentToUnderwriting: m.sentToUnderwriting ?? 0,
      offersPrepped: m.offersPrepped ?? 0,
      offersSent: m.offersSent ?? 0,
      hotLeads: m.hotLeads ?? 0,
      evalsFailed: m.evalsFailed ?? 0,
      avgPrepMinutes: data.queue?.avgPrepMinutes ?? null,
    },
  }
}

export interface ServerDisposition {
  leadId: string | null
  propertyAddress: string | null
  /** Report jobId persisted at dispatch time — revisit links survive
   *  even after the lead leaves the queue. */
  jobId: string | null
  workflow: OfferWorkflow
  /** false = the dispatch attempt failed (durable Failed bucket). */
  ok: boolean
  at: string | null
}

/** Durable disposition history — server-side dispatch/decline markers.
 *  Recovers decisions made in prior sessions/devices. */
export async function getOfferHistory(): Promise<{ ok: boolean; dispositions: ServerDisposition[] }> {
  const res = await internalFetch('/v1/offers/history')
  if (!res?.ok) return { ok: false, dispositions: [] }
  const data = (await res.json()) as { dispositions?: ServerDisposition[] }
  return { ok: true, dispositions: data.dispositions ?? [] }
}

export interface ActivityRowLite {
  leadId: string | null
}

/** One authenticated view request for the Offers surface — session + secret
 *  resolved once, then queue + disposition history + hot-lead activity read
 *  concurrently. Replaces three separate server-action POSTs on every
 *  landing/item mount. */
export async function getOffersView(): Promise<{
  ok: boolean
  items: PipelineItem[]
  dispositions: ServerDisposition[]
  hotIds: string[]
  _perf: { authMs: number; readsMs: number; totalMs: number }
}> {
  const t0 = Date.now()
  const session = await getSession()
  const secret = session?.user ? await getDashboardSecret() : null
  const authMs = Date.now() - t0
  if (!session?.user || !secret) {
    return { ok: false, items: [], dispositions: [], hotIds: [], _perf: { authMs, readsMs: 0, totalMs: authMs } }
  }
  const headers = { 'X-Dashboard-User-Id': session.user.id, 'X-Dashboard-Secret': secret }
  const api = process.env.NEXT_PUBLIC_API_URL!
  const t1 = Date.now()
  const [queueRes, histRes, hotRes] = await Promise.all([
    fetch(`${api}/v1/pipeline/queue`, { headers }).catch(() => null),
    fetch(`${api}/v1/offers/history`, { headers }).catch(() => null),
    fetch(`${api}/v1/activity?kind=hot_lead&limit=500`, { headers }).catch(() => null),
  ])
  const readsMs = Date.now() - t1
  const [queueData, histData, hotData] = await Promise.all([
    queueRes?.ok ? queueRes.json() as Promise<{ items?: PipelineItem[]; queue?: { items?: PipelineItem[] } }> : null,
    histRes?.ok ? histRes.json() as Promise<{ dispositions?: ServerDisposition[] }> : null,
    hotRes?.ok ? hotRes.json() as Promise<{ rows?: ActivityRowLite[] }> : null,
  ])
  const q = queueData?.queue ?? queueData
  return {
    ok: !!queueRes?.ok,
    items: q?.items ?? [],
    dispositions: histData?.dispositions ?? [],
    hotIds: (hotData?.rows ?? []).map((r) => r.leadId).filter((l): l is string => !!l),
    _perf: { authMs, readsMs, totalMs: Date.now() - t0 },
  }
}
