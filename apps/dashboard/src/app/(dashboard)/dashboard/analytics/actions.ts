'use server'

import { getSession } from '@/lib/api'
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

/** Engine dashboard payload (via /v1/pipeline/metrics proxy). */
export interface EngineMetrics {
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
  queueDepth: number
}

/** Activity-event row from our D1 store (drill-down source). */
export interface ActivityRow {
  id: string
  kind: string
  value: string | null
  leadId: string | null
  propertyAddress: string | null
  ts: string
  meta: string | null
}

export async function getEngineMetrics(since?: string): Promise<{ ok: boolean; metrics: EngineMetrics | null }> {
  const path = `/v1/pipeline/metrics${since ? `?since=${encodeURIComponent(since)}` : ''}`
  const res = await internalFetch(path)
  if (!res?.ok) return { ok: false, metrics: null }
  const data = (await res.json()) as {
    metrics?: Partial<EngineMetrics>
    queue?: { avgPrepMinutes?: number | null; count?: number; items?: unknown[] }
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
      queueDepth: data.queue?.count ?? data.queue?.items?.length ?? 0,
    },
  }
}

/** Per-kind counts over the window — powers the metric tiles. */
export async function getActivitySummary(since?: string, until?: string): Promise<{ ok: boolean; counts: Record<string, number> }> {
  const qs = new URLSearchParams()
  if (since) qs.set('since', since)
  if (until) qs.set('until', until)
  const res = await internalFetch(`/v1/activity/summary?${qs}`)
  if (!res?.ok) return { ok: false, counts: {} }
  const data = (await res.json()) as { counts?: Record<string, number> }
  return { ok: true, counts: data.counts ?? {} }
}

/** Rows for a tile drill-down — one or more kinds, newest first. */
export async function getActivityRows(kinds: string[], since?: string, until?: string): Promise<{ ok: boolean; rows: ActivityRow[] }> {
  const qs = new URLSearchParams()
  if (kinds.length) qs.set('kind', kinds.join(','))
  if (since) qs.set('since', since)
  if (until) qs.set('until', until)
  qs.set('limit', '1000')
  const res = await internalFetch(`/v1/activity?${qs}`)
  if (!res?.ok) return { ok: false, rows: [] }
  const data = (await res.json()) as { rows?: ActivityRow[] }
  return { ok: true, rows: data.rows ?? [] }
}
