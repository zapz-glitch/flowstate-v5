'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  Ban,
  FileSignature, Inbox, ListChecks, Flame, Play, RotateCcw, CircleSlash,
  ChevronRight, Copy, Check, Search, AlertTriangle, Trash2,
} from 'lucide-react'
import { getOfferQueue, hideQueueItem, type PipelineItem } from './actions'
import {
  getCachedQueue,
  getDecidedToday,
  getLastViewed,
  jobIdForItem,
  parseQueuedAt,
  setCachedQueue,
  sortedQueue,
  formatWait,
  prefetchReport,
  armNavVeil,
  mergeDispositions,
  decidedLeadSet,
  getOffersViewCached,
  type ServerDisposition,
  type WaitFilter,
  type DecidedEntry,
} from './queue'

const SORT_PREF_KEY = 'giveOffer.waitFilter'
const POLL_MS = 10000

type Cat = 'waiting' | 'hot' | 'prep_offer' | 'no_margin' | 'no_offer' | 'failed'

const CAT_LABELS: Record<Cat, string> = {
  waiting: 'Waiting',
  hot: 'Hot leads',
  prep_offer: 'Prep offers',
  no_margin: 'No margin',
  no_offer: 'No offer',
  failed: 'Failed',
}

function useNow(): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30000)
    return () => clearInterval(t)
  }, [])
  return now
}

const fmtTime = (ts: number) =>
  new Date(ts).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })

const fmtPrice = (v: number | null | undefined) =>
  v != null && v > 0 ? `$${v.toLocaleString('en-US')}` : null

function CopyAddr({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      aria-label="Copy address"
      title="Copy address"
      className="p-1 rounded text-foreground-tertiary hover:text-emerald-600 dark:hover:text-emerald-400 hover:bg-emerald-500/10 transition-colors"
      onClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        navigator.clipboard.writeText(text).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        }).catch(() => {})
      }}
    >
      {copied ? <Check size={12} className="text-emerald-500" /> : <Copy size={12} />}
    </button>
  )
}

interface RowData {
  key: string
  address: string
  meta: string
  jobId: string | null
  icon: React.ReactNode
  oppId?: string | null
  needsEval?: boolean
}

export default function GiveOfferPage() {
  const router = useRouter()
  const [raw, setRaw] = useState<PipelineItem[]>(getCachedQueue() ?? [])
  const [loaded, setLoaded] = useState(getCachedQueue() != null)
  const [failedFetch, setFailedFetch] = useState(false)
  const [sessionDecided, setSessionDecided] = useState<DecidedEntry[]>([])
  const [serverDisp, setServerDisp] = useState<ServerDisposition[]>([])
  const [hotIds, setHotIds] = useState<Set<string>>(new Set())
  const [lastViewed, setLastViewedState] = useState<{ jobId: string; address: string | null } | null>(null)
  const [cat, setCat] = useState<Cat>('waiting')
  const [query, setQuery] = useState('')
  const [filterPref, setFilterPref] = useState<WaitFilter>('longest')
  const now = useNow()

  useEffect(() => {
    const saved = window.localStorage.getItem(SORT_PREF_KEY)
    if (saved && saved in CAT_SAFE_FILTERS) setFilterPref(saved as WaitFilter)
    setSessionDecided(getDecidedToday())
    setLastViewedState(getLastViewed())
    // One composite action: durable dispositions + hot-lead ids (and a
    // warm queue snapshot) in a single server-action POST.
    getOffersViewCached().then((v) => {
      setServerDisp(v.dispositions)
      setHotIds(v.hotIds)
      if (v.items.length) {
        setCachedQueue(v.items)
        // Seed the queue from the composite so mount doesn't fire a second
        // POST just for items — the interval below keeps it fresh.
        setRaw((prev) => prev.length ? prev : v.items)
        setLoaded(true)
      }
    }).catch(() => {})
  }, [])

  useEffect(() => {
    let cancelled = false
    const load = () =>
      getOfferQueue().then((q) => {
        if (cancelled) return
        if (q.ok) {
          setCachedQueue(q.items)
          setRaw((prev) => (JSON.stringify(prev.map((i) => i.leadId)) === JSON.stringify(q.items.map((i) => i.leadId)) ? prev : q.items))
          setFailedFetch(false)
        } else {
          setFailedFetch(true)
        }
        setLoaded(true)
      })
    load()
    const t = setInterval(load, POLL_MS)
    return () => { cancelled = true; clearInterval(t) }
  }, [])

  const jobIdByLead = useMemo(
    () => new Map(raw.map((i) => [i.leadId, jobIdForItem(i)] as const)),
    [raw],
  )
  // Merged decided list — server markers + this session's log, deduped.
  const decided = useMemo(() => mergeDispositions(serverDisp, jobIdByLead), [serverDisp, jobIdByLead, sessionDecided])
  const queueItems = useMemo(() => {
    const excluded = decidedLeadSet(serverDisp)
    return sortedQueue(raw, filterPref).filter((i) => !excluded.has(i.leadId))
  }, [raw, filterPref, serverDisp])

  const hotItems = useMemo(() => queueItems.filter((i) => hotIds.has(i.leadId)), [queueItems, hotIds])
  const prepDecided = useMemo(() => decided.filter((d) => d.ok && d.workflow === 'prep_offer'), [decided])
  const marginDecided = useMemo(() => decided.filter((d) => d.ok && d.workflow === 'no_margin'), [decided])
  const noOfferDecided = useMemo(() => decided.filter((d) => d.ok && d.workflow === 'no_offer'), [decided])
  const failedDecided = useMemo(() => decided.filter((d) => !d.ok), [decided])

  const counts: Record<Cat, number> = {
    waiting: queueItems.length,
    hot: hotItems.length,
    prep_offer: prepDecided.length,
    no_margin: marginDecided.length,
    no_offer: noOfferDecided.length,
    failed: failedDecided.length,
  }

  // Rows for the selected category (or the global search results).
  const rows = useMemo<RowData[]>(() => {
    const q = query.trim().toLowerCase()
    const match = (addr: string) => !q || addr.toLowerCase().includes(q)
    const queueRow = (item: PipelineItem, tag?: string): RowData => {
      const jobId = jobIdForItem(item)
      return {
        key: `q:${item.leadId}`,
        address: item.fullAddress ?? item.address ?? item.displayName ?? item.leadId,
        meta: [
          tag,
          jobId ? null : 'needs evaluation',
          `waiting ${formatWait(Math.floor((now - parseQueuedAt(item.queuedAt)) / 1000))}`,
          fmtPrice(item.listPrice ?? item.wholesalePrice),
        ].filter(Boolean).join(' · '),
        jobId,
        oppId: item.opportunityId,
        needsEval: !jobId,
        icon: jobId
          ? <ChevronRight size={13} className="text-foreground-tertiary flex-shrink-0" />
          : <AlertTriangle size={13} className="text-amber-500 flex-shrink-0" />,
      }
    }
    const decidedRow = (d: DecidedEntry): RowData => ({
      key: `d:${d.leadId}:${d.at}`,
      address: d.address,
      meta: `${d.ok ? CAT_LABELS[d.workflow] : `${CAT_LABELS[d.workflow]} failed`} · ${fmtTime(d.at)}`,
      jobId: d.jobId ?? jobIdByLead.get(d.leadId) ?? null,
      icon: d.workflow === 'prep_offer'
        ? <FileSignature size={13} className={d.ok ? 'text-emerald-500' : 'text-red-500'} />
        : d.workflow === 'no_offer'
          ? <Ban size={13} className={d.ok ? 'text-foreground-tertiary' : 'text-red-500'} />
          : <CircleSlash size={13} className={d.ok ? 'text-foreground-tertiary' : 'text-red-500'} />,
    })

    if (q) {
      return [
        ...queueItems.filter((i) => match(i.fullAddress ?? i.address ?? i.displayName ?? i.leadId)).map((i) => queueRow(i, 'in queue')),
        ...hotItems.filter((i) => match(i.fullAddress ?? i.address ?? i.displayName ?? i.leadId)).filter((i) => !queueItems.includes(i)).map((i) => queueRow(i, 'hot lead')),
        ...decided.filter((d) => match(d.address)).map(decidedRow),
      ]
    }

    switch (cat) {
      case 'waiting': return queueItems.map((i) => queueRow(i))
      case 'hot': return hotItems.map((i) => queueRow(i, 'hot lead'))
      case 'prep_offer': return prepDecided.map(decidedRow)
      case 'no_margin': return marginDecided.map(decidedRow)
      case 'no_offer': return noOfferDecided.map(decidedRow)
      case 'failed': return failedDecided.map(decidedRow)
    }
  }, [cat, query, queueItems, hotItems, prepDecided, marginDecided, failedDecided, decided, now])

  const dismiss = async (oppId: string | null | undefined) => {
    if (!oppId) return
    setRaw((prev) => {
      const next = prev.filter((i) => i.opportunityId !== oppId)
      setCachedQueue(next)
      return next
    })
    await hideQueueItem(oppId).catch(() => null)
  }
  const evaluate = (address: string) => {
    router.push(`/dashboard/analyze?address=${encodeURIComponent(address)}`)
  }

  const next = queueItems.find((i) => jobIdForItem(i)) ?? null
  const nextJobId = next ? jobIdForItem(next) : null
  const resume = lastViewed && lastViewed.jobId !== nextJobId ? lastViewed : null

  const catIcons: Record<Cat, React.ReactNode> = {
    waiting: <ListChecks size={14} />,
    hot: <Flame size={14} />,
    prep_offer: <FileSignature size={14} />,
    no_margin: <CircleSlash size={14} />,
    no_offer: <Ban size={14} />,
    failed: <AlertTriangle size={14} />,
  }
  const visibleCats: Cat[] = (['waiting', 'hot', 'prep_offer', 'no_margin', 'no_offer', 'failed'] as Cat[])
    .filter((c) => c !== 'hot' || counts.hot > 0)

  return (
    <div className="playground-bg -m-4 sm:-m-6 lg:-m-8 min-h-screen lg:h-[100dvh] flex flex-col lg:overflow-hidden">
      {/* Header band — same geometry + card chrome as Property Search */}
      <div className="px-4 sm:px-6 lg:px-4 pt-3 pb-1 lg:pt-4 lg:pb-0 lg:h-20 lg:flex lg:items-center lg:border-b lg:border-border space-y-3 flex-shrink-0">
        <div className="w-full border border-border/60 overflow-hidden bg-background shadow-sm corner-accents corner-accents-bottom">
          <div className="px-4 py-3 flex items-center gap-3">
            <div className="w-7 h-7 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0">
              <FileSignature className="w-3.5 h-3.5 text-primary" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-body-sm text-foreground-secondary">Offers</div>
              <div className="text-xs text-foreground-tertiary">
                {loaded
                  ? `${counts.waiting} waiting${decided.length ? ` · ${decided.filter((d) => d.ok).length} decided today` : ''}`
                  : 'Loading queue…'}
              </div>
            </div>
            <div className="relative flex-shrink-0">
              <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-foreground-tertiary pointer-events-none" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search address…"
                className="w-44 sm:w-56 bg-secondary/50 border border-border/50 rounded-md pl-7 pr-2 py-1.5 text-xs text-foreground placeholder:text-foreground-tertiary outline-none focus:border-primary/50"
              />
            </div>
          </div>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="px-4 sm:px-6 lg:px-4 pt-3 pb-6 space-y-3">
          {/* Actions row — continue the queue or jump back to the last report */}
          {(nextJobId || resume) && !query && (
            <div className="border border-border/60 bg-background shadow-sm px-3 py-2 flex items-center gap-2 flex-wrap">
              {nextJobId && (
                <Link
                  href={`/dashboard/give-offer/${nextJobId}?cat=waiting`}
                  onMouseEnter={() => prefetchReport(nextJobId)}
                  onClick={() => { armNavVeil(); prefetchReport(nextJobId) }}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-primary/10 text-primary text-xs font-medium hover:text-emerald-600 dark:hover:text-emerald-400 hover:bg-emerald-500/10 transition-colors"
                >
                  <Play size={12} />
                  Next up — {next!.fullAddress ?? next!.address ?? 'top of queue'}
                </Link>
              )}
              {resume && (
                <Link
                  href={`/dashboard/give-offer/${resume.jobId}`}
                  onMouseEnter={() => prefetchReport(resume.jobId)}
                  onClick={() => { armNavVeil(); prefetchReport(resume.jobId) }}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-border text-xs text-foreground-secondary hover:text-emerald-600 dark:hover:text-emerald-400 hover:bg-emerald-500/10 transition-colors"
                >
                  <RotateCcw size={12} />
                  Last report — {resume.address ?? resume.jobId}
                </Link>
              )}
            </div>
          )}

          {/* Category tiles — click into a bucket */}
          {!query && (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
              {visibleCats.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setCat(c)}
                  className={`border rounded-md px-3 py-2.5 text-left transition-colors ${
                    cat === c
                      ? 'border-primary/60 bg-primary/10'
                      : 'border-border/60 bg-background hover:text-emerald-600 dark:hover:text-emerald-400 hover:bg-emerald-500/10'
                  }`}
                >
                  <div className={`flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider ${cat === c ? 'text-primary' : 'text-foreground-tertiary'}`}>
                    {catIcons[c]}
                    {CAT_LABELS[c]}
                  </div>
                  <div className="text-lg font-semibold text-foreground mt-1 tabular-nums">
                    {loaded ? counts[c] : <span className="text-foreground-tertiary">–</span>}
                  </div>
                </button>
              ))}
            </div>
          )}

          {/* Rows for the selected category / search results */}
          <div className="border border-border/60 bg-background shadow-sm overflow-hidden">
            <div className="px-3 py-2 border-b border-border/50 text-[10px] font-semibold uppercase tracking-wider text-foreground-tertiary">
              {query ? `Search — ${rows.length} match${rows.length === 1 ? '' : 'es'}` : CAT_LABELS[cat]}
            </div>
            {failedFetch ? (
              <div className="px-4 py-8 flex flex-col items-center gap-2 text-center">
                <Inbox className="w-5 h-5 text-foreground-tertiary" />
                <div className="text-body-sm text-foreground-secondary">Queue unavailable</div>
                <div className="text-xs text-foreground-tertiary">The engine did not respond — try again shortly.</div>
              </div>
            ) : !loaded ? (
              <div className="px-4 py-8 flex items-center justify-center gap-2">
                <div className="w-4 h-4 rounded-full border-2 border-primary/30 border-t-primary animate-spin" />
                <span className="text-xs text-foreground-tertiary">Loading queue…</span>
              </div>
            ) : rows.length === 0 ? (
              <div className="px-4 py-8 flex flex-col items-center gap-2 text-center">
                <Inbox className="w-5 h-5 text-foreground-tertiary" />
                <div className="text-body-sm text-foreground-secondary">
                  {query ? 'No matches' : cat === 'waiting' ? 'Queue is clear' : `Nothing in ${CAT_LABELS[cat].toLowerCase()} yet`}
                </div>
                <div className="text-xs text-foreground-tertiary">
                  {query
                    ? 'No queued or decided address matches.'
                    : cat === 'waiting'
                      ? 'Every queued property has been dispositioned — new ones land here as they reach underwriting.'
                      : 'Dispositions land here as you work the queue.'}
                </div>
              </div>
            ) : (
              <div className="divide-y divide-border/40">
                {rows.map((row) => {
                  const actions = (
                    <span className="flex items-center gap-1 flex-shrink-0">
                      {row.needsEval && (
                        <button
                          type="button"
                          title="Run evaluation now"
                          className="px-1.5 py-0.5 rounded text-[10px] font-medium border border-primary/40 text-primary hover:bg-primary/10"
                          onClick={(e) => { e.preventDefault(); e.stopPropagation(); evaluate(row.address) }}
                        >
                          Evaluate
                        </button>
                      )}
                      {row.oppId && (
                        <button
                          type="button"
                          title="Remove from waiting queue"
                          className="p-1 rounded text-foreground-tertiary hover:text-red-400 hover:bg-red-400/10"
                          onClick={(e) => { e.preventDefault(); e.stopPropagation(); dismiss(row.oppId) }}
                        >
                          <Trash2 size={12} />
                        </button>
                      )}
                    </span>
                  )
                  const inner = (
                    <>
                      {row.icon}
                      <div className="flex-1 min-w-0">
                        <div className="text-xs text-foreground truncate">{row.address}</div>
                        <div className="text-[10px] text-foreground-tertiary">{row.meta}</div>
                      </div>
                      <CopyAddr text={row.address} />
                      {actions}
                    </>
                  )
                  return row.jobId ? (
                    <Link
                      key={row.key}
                      href={`/dashboard/give-offer/${row.jobId}${!query ? `?cat=${cat}` : ''}`}
                      onMouseEnter={() => prefetchReport(row.jobId!)}
                      onClick={() => { armNavVeil(); prefetchReport(row.jobId!) }}
                      className="flex items-center gap-3 px-3 py-2 hover:bg-secondary/50 transition-colors"
                    >
                      {inner}
                    </Link>
                  ) : (
                    <div key={row.key} className="flex items-center gap-3 px-3 py-2">
                      {inner}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

const CAT_SAFE_FILTERS: Record<string, true> = {
  longest: true, newest: true, '1h': true, '4h': true, '24h': true,
}
