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
