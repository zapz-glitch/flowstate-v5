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
