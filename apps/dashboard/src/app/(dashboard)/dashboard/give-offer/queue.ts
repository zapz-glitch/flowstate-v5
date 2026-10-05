import { getOffersView, type PipelineItem, type ServerDisposition } from './actions'
import type { OfferWorkflow } from '@/lib/client-api'

export type { OfferWorkflow }
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

/** All queued items — report or not — filtered + ordered by wait.
 *  A lead whose eval failed or never ran still shows (needs-eval state)
 *  rather than silently vanishing from the queue. */
export function sortedQueue(items: PipelineItem[], mode: WaitFilter): PipelineItem[] {
  const now = Date.now()
  const minWait = MIN_WAIT_SECONDS[mode] ?? 0
  const filtered = items.filter((i) => (now - parseQueuedAt(i.queuedAt)) / 1000 >= minWait)
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
  workflow: OfferWorkflow
  /** false = dispatch failed — surfaces under the Failed category and
   *  does NOT remove the item from the queue (retry stays possible). */
  ok: boolean
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
      // Entries written before the `ok` flag existed are successful.
      if (raw) loaded = (JSON.parse(raw) as DecidedEntry[]).map((d) => ({ ...d, ok: d.ok ?? true }))
    } catch { /* corrupt storage — start clean */ }
    for (const d of loaded) if (d.ok) decidedIds.add(d.leadId)
  }
  decidedItems = loaded
  return decidedItems
}

export function recordDecision(
  item: { leadId: string; address?: string | null; displayName?: string | null },
  workflow: OfferWorkflow,
  jobId: string | null,
  ok = true,
): void {
  const list = loadDecided()
  if (ok) decidedIds.add(item.leadId)
  const entry: DecidedEntry = {
    leadId: item.leadId,
    jobId,
    address: item.address ?? item.displayName ?? item.leadId,
    workflow,
    ok,
    at: Date.now(),
  }
  // Latest disposition wins per lead — a retry after a failed dispatch
  // replaces the failure row rather than stacking duplicates.
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

/** Recorded disposition for a report — matches by jobId first (decided
 *  items drop out of the queue, so leadId lookup alone misses them),
 *  falling back to leadId. */
export function decisionFor(jobId: string, leadId?: string | null): DecidedEntry | null {
  const list = loadDecided().filter((d) => d.ok)
  return list.find((d) => d.jobId === jobId)
    ?? (leadId ? list.find((d) => d.leadId === leadId) : undefined)
    ?? null
}

/** Merge server dispositions with the session log into one decided list.
 *  Session entries win (they carry jobId + failures); server rows fill the
 *  gaps — including decisions made in earlier sessions. `jobIdForLead`
 *  maps a still-queued lead to its report. */
export function mergeDispositions(
  server: ServerDisposition[],
  jobIdForLead: Map<string, string | null>,
): DecidedEntry[] {
  const merged = new Map<string, DecidedEntry>()
  for (const s of server) {
    const key = s.leadId ?? `addr:${(s.propertyAddress ?? '').toLowerCase()}`
    merged.set(key, {
      leadId: s.leadId ?? '',
      jobId: s.jobId ?? (s.leadId ? jobIdForLead.get(s.leadId) : null) ?? null,
      address: s.propertyAddress ?? s.leadId ?? 'Unknown',
      workflow: s.workflow,
      ok: s.ok,
      at: s.at ? Date.parse(s.at) : 0,
    })
  }
  for (const d of loadDecided()) {
    const key = d.leadId || `addr:${d.address.toLowerCase()}`
    const existing = merged.get(key)
    merged.set(key, existing ? { ...d, jobId: d.jobId ?? existing.jobId } : d)
  }
  return [...merged.values()].sort((a, b) => b.at - a.at)
}

/** LeadIds that are dispositioned anywhere (session log + server markers)
 *  — the Waiting category excludes all of them. */
export function decidedLeadSet(server: ServerDisposition[]): Set<string> {
  loadDecided() // hydrates decidedIds
  const set = new Set(decidedIds)
  for (const d of server) if (d.leadId && d.ok) set.add(d.leadId)
  return set
}

/** One-shot nav veil — armed when the dashboard opens a report so the
 *  route swap happens under the same covered crossfade as auto-advance.
 *  Module state survives the SPA navigation; consumed once on mount. */
let navVeilPending = false
export function armNavVeil(): void { navVeilPending = true }
export function consumeNavVeil(): boolean {
  const v = navVeilPending
  navVeilPending = false
  return v
}

// ─── Shared remote fetches (module-cached, inflight-deduped) ────────────────
// The landing page and item view both need disposition history + the hot-lead
// set — navigating between them shouldn't refetch what just arrived.


export type { ServerDisposition }

const REMOTE_CACHE_TTL = 30_000

export interface OffersView {
  items: PipelineItem[]
  dispositions: ServerDisposition[]
  hotIds: Set<string>
}

let viewCache: { at: number; data: OffersView } | null = null
let viewInflight: Promise<OffersView> | null = null

/** Module-scoped cache of the composite offers view — one server action
 *  feeds queue + history + hot-leads; TTL 30s, shared in-flight promise so
 *  concurrent mounts can't fan out. After a disposition dispatch the caller
 *  should invalidate via clearOffersViewCache() so the next mount refetches. */
export function getOffersViewCached(): Promise<OffersView> {
  if (viewCache && Date.now() - viewCache.at < REMOTE_CACHE_TTL) {
    return Promise.resolve(viewCache.data)
  }
  if (viewInflight) return viewInflight
  const p: Promise<OffersView> = getOffersView()
    .then((r) => {
      const data: OffersView = { items: r.items, dispositions: r.dispositions, hotIds: new Set(r.hotIds) }
      if (r.ok) viewCache = { at: Date.now(), data }
      return viewCache?.data ?? data
    })
    .catch(() => viewCache?.data ?? { items: [], dispositions: [], hotIds: new Set<string>() })
  viewInflight = p
  void p.finally(() => { if (viewInflight === p) viewInflight = null })
  return p
}

/** Invalidate the composite view cache — call after a disposition dispatch
 *  so the next mount/report picks up the new history row. */
export function clearOffersViewCache(): void {
  viewCache = null
}
