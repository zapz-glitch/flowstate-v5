'use server'

import { getSession } from '@/lib/api'
import { getCloudflareEnv } from '@/lib/cloudflare'

async function getApiUrl(): Promise<string> {
  return process.env.NEXT_PUBLIC_API_URL!
}

async function getDashboardSecret(): Promise<string> {
  const env = await getCloudflareEnv()
  return env.DASHBOARD_INTERNAL_SECRET || ''
}

async function internalFetch(path: string): Promise<Response | null> {
  const session = await getSession()
  if (!session?.user) return null
  const secret = await getDashboardSecret()
  if (!secret) return null
  const apiUrl = await getApiUrl()
  return fetch(`${apiUrl}${path}`, {
    headers: {
      'X-Dashboard-User-Id': session.user.id,
      'X-Dashboard-Secret': secret,
    },
  })
}

export interface PipelineItem {
  id: string
  address: string
  stage: string
  stageEnteredAt: string
  leadId: string | null
  opportunityId: string | null
  jobId: string | null
  wholesalePrice: number | null
}

export interface PipelineMetrics {
  date: string
  reachOuts: number
  responses: number
  reachToResponseRate: number | null
  reactivations: number
  sentToUnderwriting: number
  underwritingComplete: number
  offersPrepared: number
  offersSent: number
  noMargin: number
  giveOfferQueueDepth: number
  avgDecisionSeconds: number | null
  decisionsToday: number
}

export async function getOfferQueue(): Promise<{ ok: boolean; items: PipelineItem[] }> {
  const res = await internalFetch('/v1/pipeline/queue?stage=give_offer')
  if (!res?.ok) return { ok: false, items: [] }
  const data = (await res.json()) as { items?: PipelineItem[] }
  return { ok: true, items: data.items ?? [] }
}

export async function getPipelineMetrics(): Promise<{ ok: boolean; metrics: PipelineMetrics | null }> {
  const res = await internalFetch('/v1/pipeline/metrics')
  if (!res?.ok) return { ok: false, metrics: null }
  const data = (await res.json()) as { metrics?: PipelineMetrics }
  return { ok: true, metrics: data.metrics ?? null }
}
