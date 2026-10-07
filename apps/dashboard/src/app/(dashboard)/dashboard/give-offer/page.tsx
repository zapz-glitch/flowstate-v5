'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  Ban,
  FileSignature, Inbox, ListChecks, Flame, RotateCcw, CircleSlash,
  ChevronRight, Copy, Check, Search, AlertTriangle, Trash2, Clock,
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
import { PageHeader } from '@/components/ui/page-header'
import { SkeletonRows } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/ui/states'

const SORT_PREF_KEY = 'giveOffer.waitFilter'
const POLL_MS = 5000

type Cat = 'waiting' | 'ready' | 'hot' | 'prep_offer' | 'no_margin' | 'no_offer' | 'failed'

const CAT_LABELS: Record<Cat, string> = {
  waiting: 'Evaluating',
  ready: 'Ready',
  hot: 'Hot leads',
  prep_offer: 'Prep offers',
  no_margin: 'No margin',
  no_offer: 'No offer',
  failed: 'Failed',
}

const EXPECTED_EVAL_MS = 90_000

/** Circular elapsed-time indicator for leads still being evaluated —
 *  fills clockwise over EXPECTED_EVAL_MS, then spins until the report
 *  lands. Pure CSS animation — no JS tick needed for the spin phase. */
function EvalRing({ elapsedMs }: { elapsedMs: number }) {
  const r = 6
  const c = 2 * Math.PI * r
  const fill = Math.min(elapsedMs / EXPECTED_EVAL_MS, 1)
  const overtime = elapsedMs > EXPECTED_EVAL_MS * 2
  return (
    <svg
      width="16" height="16" viewBox="0 0 16 16"
      className={overtime ? 'animate-spin' : ''}
      style={{ transform: 'rotate(-90deg)' }}
      aria-label={`evaluating ${Math.round(elapsedMs / 1000)}s`}
    >
      <circle cx="8" cy="8" r={r} fill="none" strokeWidth="2" className="stroke-foreground-tertiary/20" />
      <circle
        cx="8" cy="8" r={r} fill="none" strokeWidth="2" strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - Math.max(fill, 0.12))}
        className={overtime ? 'stroke-amber-500' : 'stroke-primary'}
      />
    </svg>
  )
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
      className="p-1 rounded text-foreground-tertiary hover:text-foreground hover:bg-secondary transition-colors"
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
  address?: string
  meta?: string
  jobId: string | null
  icon?: React.ReactNode
  oppId?: string | null
  itemKey?: string
  needsEval?: boolean
  urgent?: boolean
  deadlineAt?: string | null
  deadlineNote?: string | null
  section?: string
  evalElapsedMs?: number
  pocketScore?: number | null
  pocketName?: string | null
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

  const dueItems = useMemo(() =>
    queueItems
      .filter((i) => i.offer_stage === 'deadline_today')
      .sort((a, b) => parseQueuedAt(a.deadline_at) - parseQueuedAt(b.deadline_at)),
    [queueItems])
  // waiting = queued/evaluating (no report yet); ready = report landed.
  const waitingItems = useMemo(() =>
    queueItems.filter((i) => !jobIdForItem(i)),
    [queueItems])
  const readyItems = useMemo(() =>
    queueItems.filter((i) => jobIdForItem(i)),
    [queueItems])
  const hotItems = useMemo(() => queueItems.filter((i) => hotIds.has(i.leadId)), [queueItems, hotIds])
  const prepDecided = useMemo(() => decided.filter((d) => d.ok && d.workflow === 'prep_offer'), [decided])
  const marginDecided = useMemo(() => decided.filter((d) => d.ok && d.workflow === 'no_margin'), [decided])
  const noOfferDecided = useMemo(() => decided.filter((d) => d.ok && d.workflow === 'no_offer'), [decided])
  const failedDecided = useMemo(() => decided.filter((d) => !d.ok), [decided])

  const counts: Record<Cat, number> = {
    waiting: waitingItems.length,
    ready: readyItems.length,

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
          item.deadline_at ? `due ${item.deadline_at}` : null,
          jobId ? null : 'needs evaluation',
          `waiting ${formatWait(Math.floor((now - parseQueuedAt(item.queuedAt)) / 1000))}`,
          fmtPrice(item.listPrice ?? item.wholesalePrice),
        ].filter(Boolean).join(' · '),
        jobId,
        oppId: item.opportunityId,
        itemKey: item.opportunityId ?? item.leadId,
        needsEval: !jobId,
        evalElapsedMs: jobId ? undefined : Math.max(0, now - parseQueuedAt(item.queuedAt)),
        urgent: item.offer_stage === 'deadline_today',
        deadlineAt: item.deadline_at,
        deadlineNote: item.deadline_note,
        pocketScore: item.pocketScore,
        pocketName: item.pocketName,
        icon: item.offer_stage === 'deadline_today'
          ? <AlertTriangle size={13} className="text-red-500 flex-shrink-0" />
          : jobId
            ? <ChevronRight size={13} className="text-foreground-tertiary flex-shrink-0" />
            : <EvalRing elapsedMs={Math.max(0, now - parseQueuedAt(item.queuedAt))} />,
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
      case 'waiting': return waitingItems.map((i) => queueRow(i))
      case 'ready': {
        const byMetro = new Map<string, PipelineItem[]>()
        for (const i of readyItems) {
          const m = i.metro ?? 'Other'
          if (!byMetro.has(m)) byMetro.set(m, [])
          byMetro.get(m)!.push(i)
        }
        const metros = [...byMetro.entries()].sort((a, b) => {
          const top = (arr: [string, PipelineItem[]]) => Math.max(...arr[1].map((i) => i.pocketScore ?? -1), -1)
          return top(b) - top(a)
        })
        const out: RowData[] = []
        for (const [metro, metroItems] of metros) {
          out.push({ key: `metro:${metro}`, section: metro, jobId: null } as RowData)
          metroItems
            .sort((a, b) => (b.pocketScore ?? -1) - (a.pocketScore ?? -1))
            .forEach((i) => out.push({ ...queueRow(i), urgent: i.offer_stage === 'deadline_today' }))
        }
        return out
      }

      case 'hot': return hotItems.map((i) => queueRow(i, 'hot lead'))
      case 'prep_offer': return prepDecided.map(decidedRow)
      case 'no_margin': return marginDecided.map(decidedRow)
      case 'no_offer': return noOfferDecided.map(decidedRow)
      case 'failed': return failedDecided.map(decidedRow)
    }
  }, [cat, query, queueItems, hotItems, prepDecided, marginDecided, failedDecided, decided, now])

  const dismiss = async (key: string | null | undefined) => {
    if (!key) return
    setRaw((prev) => {
      const next = prev.filter((i) => (i.opportunityId ?? i.leadId) !== key)
      setCachedQueue(next)
      return next
    })
    await hideQueueItem(key).catch(() => null)
  }
  const evaluate = (address: string) => {
    router.push(`/dashboard/analyze?address=${encodeURIComponent(address)}`)
  }

  const next = readyItems[0] ?? queueItems.find((i) => jobIdForItem(i)) ?? null
  const nextJobId = next ? jobIdForItem(next) : null
  const resume = lastViewed && lastViewed.jobId !== nextJobId ? lastViewed : null

  const catIcons: Record<Cat, React.ReactNode> = {
    waiting: <Clock size={14} />,
    ready: <Inbox size={14} />,
    hot: <Flame size={14} />,
    prep_offer: <FileSignature size={14} />,
    no_margin: <CircleSlash size={14} />,
    no_offer: <Ban size={14} />,
    failed: <AlertTriangle size={14} />,
  }
  const visibleCats: Cat[] = (['waiting', 'ready', 'hot', 'prep_offer', 'no_margin', 'no_offer', 'failed'] as Cat[])
    .filter((c) => c !== 'hot' || counts.hot > 0)


  return (
    <div className="playground-bg -m-4 sm:-m-6 lg:-m-8 min-h-screen lg:h-[100dvh] flex flex-col lg:overflow-hidden">
      {/* Header band — keeps Property Search's height and bottom rule so panes line up */}
      <div className="px-4 sm:px-6 lg:px-4 pt-3 pb-3 lg:pt-4 lg:pb-0 lg:h-20 lg:flex lg:items-center lg:border-b lg:border-border flex-shrink-0">
        <PageHeader
          title="Offers"
          className="w-full"
          actions={
            <div className="relative">
              <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-foreground-tertiary pointer-events-none" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search address…"
                className="w-44 sm:w-56 bg-secondary/50 border border-border/50 rounded-md pl-7 pr-2 py-1.5 text-xs text-foreground placeholder:text-foreground-tertiary outline-none focus:border-primary/50"
              />
            </div>
          }
        />
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="px-4 sm:px-6 lg:px-4 pt-3 pb-6 space-y-3">
          {/* Jump back to the last report */}
          {resume && !query && (
            <div className="border border-border/60 bg-background shadow-sm px-3 py-2 flex items-center gap-2 flex-wrap">
              {resume && (
                <Link
                  href={`/dashboard/give-offer/${resume.jobId}`}
                  onMouseEnter={() => prefetchReport(resume.jobId)}
                  onClick={() => { armNavVeil(); prefetchReport(resume.jobId) }}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-border text-xs text-foreground-secondary hover:text-foreground hover:bg-secondary transition-colors"
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
                      : 'border-border/60 bg-background hover:text-foreground hover:bg-secondary'
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
              <SkeletonRows label="Loading offers" rows={5} className="border-0 rounded-none" />
            ) : rows.length === 0 ? (
              <EmptyState
                title={query ? 'No matches' : cat === 'waiting' ? 'Nothing evaluating right now' : `Nothing in ${CAT_LABELS[cat].toLowerCase()} yet`}
                description={query
                  ? 'No queued or decided address matches.'
                  : cat === 'waiting'
                    ? 'Every queued property has been dispositioned. New ones land here as they reach underwriting.'
                    : 'Dispositions land here as you work the queue.'}
              />
            ) : (
              <div className="divide-y divide-border/40">
                {rows.map((row) => {
                  if (row.section) {
                    return (
                      <div key={row.key} className="px-3 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-foreground-tertiary">
                        {row.section}
                      </div>
                    )
                  }
                  const actions = (
                    <span className="flex items-center gap-1 flex-shrink-0">
                      {row.needsEval && (
                        <button
                          type="button"
                          title="Run evaluation now"
                          className="px-1.5 py-0.5 rounded text-[10px] font-medium border border-primary/40 text-primary hover:bg-primary/10"
                          onClick={(e) => { e.preventDefault(); e.stopPropagation(); evaluate(row.address ?? '') }}
                        >
                          Evaluate
                        </button>
                      )}
                      {row.itemKey && (
                        <button
                          type="button"
                          title="Remove from waiting queue"
                          className="p-1 rounded text-foreground-tertiary hover:text-red-400 hover:bg-red-400/10"
                          onClick={(e) => { e.preventDefault(); e.stopPropagation(); dismiss(row.itemKey) }}
                        >
                          <Trash2 size={12} />
                        </button>
                      )}
                    </span>
                  )
                  const inner = (
                    <>
                      {row.pocketScore != null && (
                        <span
                          title={row.pocketName ? `Pocket: ${row.pocketName}` : 'Pocket score'}
                          className={`text-[10px] font-semibold tabular-nums px-1.5 py-0.5 rounded flex-shrink-0 ${
                            row.pocketScore >= 7 ? 'text-emerald-400 bg-emerald-400/10'
                            : row.pocketScore >= 4 ? 'text-foreground-secondary bg-foreground-tertiary/10'
                            : 'text-foreground-tertiary bg-foreground-tertiary/10'}`}
                        >
                          {row.pocketScore.toFixed(1)}
                        </span>
                      )}
                      <div className="flex-1 min-w-0">
                        <div className={`text-xs truncate ${row.urgent ? 'text-red-500 font-medium' : 'text-foreground'}`}>{row.address}</div>
                        <div className={`text-[10px] ${row.urgent ? 'text-red-400' : 'text-foreground-tertiary'}`}>{row.meta}{row.pocketName ? ` · ${row.pocketName}` : ''}</div>
                        {row.deadlineNote && <div className="text-[10px] text-foreground-secondary truncate mt-0.5">{row.deadlineNote}</div>}
                      </div>
                      <CopyAddr text={row.address ?? ''} />
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
