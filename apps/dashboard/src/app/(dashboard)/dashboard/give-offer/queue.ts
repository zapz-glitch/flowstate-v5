import type { PipelineItem } from './actions'
import { getSavedReport } from '@/lib/client-api'

/** Engine timestamps arrive as "YYYY-MM-DD HH:MM:SS" UTC. */
export function parseQueuedAt(s: string | null | undefined): number {
  if (!s) return 0
  return Date.parse(s.includes('T') ? s : s.replace(' ', 'T') + 'Z')
}

/** Report jobId from the engine's evalReportUrl (`.../dashboard/reports/<jobId>`). */
export function jobIdForItem(item: PipelineItem): string | null {
  const url = item.evalReportUrl
  if (!url) return null
  const m = url.match(/\/reports\/(job_[^/?#]+)/)
  return m?.[1] ?? null
}

export type WaitFilter = 'longest' | 'newest' | '1h' | '4h' | '24h'

export const WAIT_FILTER_LABELS: Record<WaitFilter, string> = {
  longest: 'Longest waiting',
  newest: 'Newest first',
  '1h': 'Waiting 1h+',
  '4h': 'Waiting 4h+',
  '24h': 'Waiting 24h+',
}

const MIN_WAIT_SECONDS: Partial<Record<WaitFilter, number>> = {
  '1h': 3600,
  '4h': 4 * 3600,
  '24h': 24 * 3600,
}

/** Items that have a report to land on, filtered + ordered by wait. */
export function sortedQueue(items: PipelineItem[], mode: WaitFilter): PipelineItem[] {
  const now = Date.now()
  const minWait = MIN_WAIT_SECONDS[mode] ?? 0
  const filtered = items.filter((i) => jobIdForItem(i) && (now - parseQueuedAt(i.queuedAt)) / 1000 >= minWait)
  return filtered.sort((a, b) =>
    mode === 'newest'
      ? parseQueuedAt(b.queuedAt) - parseQueuedAt(a.queuedAt)
      : parseQueuedAt(a.queuedAt) - parseQueuedAt(b.queuedAt),
  )
}

export function formatWait(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const m = Math.floor(seconds / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

/** Items dispositioned this SPA session — stays out of the queue on the
 *  landing list and item pages even if the engine hasn't dequeued yet. */
export const decidedIds = new Set<string>()

/** Shared queue cache — landing redirect and report pages read it
 *  instantly instead of re-fetching the engine on every navigation. */
let queueCache: { items: PipelineItem[]; fetchedAt: number } | null = null
const QUEUE_CACHE_TTL = 30_000

export function getCachedQueue(): PipelineItem[] | null {
  if (!queueCache || Date.now() - queueCache.fetchedAt > QUEUE_CACHE_TTL) return null
  return queueCache.items
}

export function setCachedQueue(items: PipelineItem[]): void {
  queueCache = { items, fetchedAt: Date.now() }
}

/** Prefetch cache — the item page warms the *next* report during the
 *  outcome-chip window so navigation lands on content instead of a
 *  skeleton flash. Entries are consumed once and capped to keep the
 *  map from growing unbounded over a long queue session. */
const reportPrefetch = new Map<string, Promise<unknown>>()
const PREFETCH_CAP = 10

export function prefetchReport(jobId: string | null | undefined): void {
  if (!jobId || reportPrefetch.has(jobId)) return
  if (reportPrefetch.size >= PREFETCH_CAP) {
    const oldest = reportPrefetch.keys().next().value
    if (oldest) reportPrefetch.delete(oldest)
  }
  // Swallow errors — the real fetchReport retry owns error reporting.
  reportPrefetch.set(jobId, getSavedReport(jobId).catch(() => null))
}

export function takeReportPrefetch(
  jobId: string,
): Promise<{ jobId: string; address: string; createdAt: string; analysis: unknown } | null> | null {
  const p = reportPrefetch.get(jobId)
  if (!p) return null
  reportPrefetch.delete(jobId)
  return p as Promise<{ jobId: string; address: string; createdAt: string; analysis: unknown } | null>
}

// ─── Offers session bookkeeping ─────────────────────────────────────────────
// Dispositions + last-viewed report, persisted to sessionStorage so they
// survive reloads within the tab session and vanish with it.

export interface DecidedEntry {
  leadId: string
  jobId: string | null
  address: string
  workflow: 'prep_offer' | 'no_margin'
  at: number
}

const DECIDED_KEY = 'giveOffer.decided'
const LAST_VIEWED_KEY = 'giveOffer.lastViewed'
let decidedItems: DecidedEntry[] | null = null

function loadDecided(): DecidedEntry[] {
  if (decidedItems) return decidedItems
  let loaded: DecidedEntry[] = []
  if (typeof window !== 'undefined') {
    try {
      const raw = window.sessionStorage.getItem(DECIDED_KEY)
      if (raw) loaded = JSON.parse(raw)
    } catch { /* corrupt storage — start clean */ }
    for (const d of loaded) decidedIds.add(d.leadId)
  }
  decidedItems = loaded
  return decidedItems
}

export function recordDecision(
  item: { leadId: string; address?: string | null; displayName?: string | null },
  workflow: 'prep_offer' | 'no_margin',
  jobId: string | null,
): void {
  const list = loadDecided()
  decidedIds.add(item.leadId)
  const entry: DecidedEntry = {
    leadId: item.leadId,
    jobId,
    address: item.address ?? item.displayName ?? item.leadId,
    workflow,
    at: Date.now(),
  }
  decidedItems = [entry, ...list.filter((d) => d.leadId !== item.leadId)]
  try { window.sessionStorage.setItem(DECIDED_KEY, JSON.stringify(decidedItems)) } catch { /* quota — session list degrades */ }
}

export function getDecidedToday(): DecidedEntry[] {
  const midnight = new Date()
  midnight.setHours(0, 0, 0, 0)
  return loadDecided().filter((d) => d.at >= midnight.getTime())
}

export function setLastViewed(jobId: string, address?: string | null): void {
  if (typeof window === 'undefined') return
  try {
    window.sessionStorage.setItem(LAST_VIEWED_KEY, JSON.stringify({ jobId, address: address ?? null }))
  } catch { /* best-effort */ }
}

export function getLastViewed(): { jobId: string; address: string | null } | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.sessionStorage.getItem(LAST_VIEWED_KEY)
    return raw ? JSON.parse(raw) : null
  } catch { return null }
}
