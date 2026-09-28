'use client'

import { use, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { ChevronLeft, ChevronRight, Timer, ListFilter } from 'lucide-react'
import DashboardReportPage from '../../reports/[jobId]/page'
import { getOfferQueue, type PipelineItem } from '../actions'
import { getActivityRows } from '../../analytics/actions'
import { decidedIds, jobIdForItem, parseQueuedAt, sortedQueue, formatWait, WAIT_FILTER_LABELS, type WaitFilter, getCachedQueue, setCachedQueue, prefetchReport, recordDecision, setLastViewed, decisionFor, getDecidedToday, type DecidedEntry } from '../queue'
import { useSidebar } from '@/components/SidebarProvider'
import { cn } from '@/lib/utils'

const POLL_MS = 5000
const SORT_PREF_KEY = 'giveOffer.waitFilter'

type Cat = 'waiting' | 'hot' | 'prep_offer' | 'no_margin' | 'failed'
const QUEUE_CATS = new Set<Cat>(['waiting', 'hot'])
const CATS = new Set<Cat>([...QUEUE_CATS, 'prep_offer', 'no_margin', 'failed'] as Cat[])

function useNow(): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  return now
}

export default function GiveOfferReportPage({ params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = use(params)
  // Stable identity — a fresh Promise per render makes the inner use()
  // suspend on every replay, which trips React error #482 (>100 suspends).
  const reportParams = useMemo(() => Promise.resolve({ jobId }), [jobId])
  const router = useRouter()
  const searchParams = useSearchParams()
  const rawCat = searchParams.get('cat')
  const cat: Cat = CATS.has(rawCat as Cat) ? (rawCat as Cat) : 'waiting'
  const isQueueCat = QUEUE_CATS.has(cat)

  const [raw, setRaw] = useState<PipelineItem[]>(getCachedQueue() ?? [])
  const [queueLoaded, setQueueLoaded] = useState(getCachedQueue() != null)
  const [filter, setFilter] = useState<WaitFilter>('longest')
  const [decided, setDecided] = useState<DecidedEntry[]>([])
  const [hotIds, setHotIds] = useState<Set<string>>(new Set())
  // Transition veil — covers the chip→nav→mount swap so the disposition
  // advance reads as one smooth crossfade, not a page teardown.
  const [veil, setVeil] = useState(false)
  const veilFromJob = useRef<string | null>(null)
  const { collapsed } = useSidebar()
  const now = useNow()

  useEffect(() => {
    const saved = window.localStorage.getItem(SORT_PREF_KEY)
    if (saved && saved in WAIT_FILTER_LABELS) setFilter(saved as WaitFilter)
    setDecided(getDecidedToday())
  }, [])

  // Hot-lead set only needed while browsing that category.
  useEffect(() => {
    if (cat !== 'hot' || hotIds.size) return
    let cancelled = false
    getActivityRows(['hot_lead']).then((res) => {
      if (!cancelled && res.ok) setHotIds(new Set(res.rows.map((r) => r.leadId).filter((l): l is string => !!l)))
    }).catch(() => {})
    return () => { cancelled = true }
  }, [cat, hotIds.size])

  useEffect(() => {
    let cancelled = false
    const load = () =>
      getOfferQueue().then((q) => {
        if (cancelled) return
        if (q.ok) {
          setCachedQueue(q.items)
          setRaw(q.items)
        }
        setQueueLoaded(true)
      })
    load()
    const t = setInterval(load, POLL_MS)
    return () => { cancelled = true; clearInterval(t) }
  }, [])

  // Live queue ordering (saved wait filter), minus session-decided leads.
  const queueItems = useMemo(() => {
    getDecidedToday() // hydrates decidedIds from sessionStorage pre-paint
    return sortedQueue(raw, filter).filter((i) => !decidedIds.has(i.leadId))
  }, [raw, filter])

  // The active category's nav order — prev/next, position, and auto-advance
  // all walk this list. Queue categories sort by the wait filter; outcome
  // categories keep the decided list's newest-first order.
  const orderedJobIds = useMemo<string[]>(() => {
    if (isQueueCat) {
      const scoped = cat === 'hot' ? queueItems.filter((i) => hotIds.has(i.leadId)) : queueItems
      return scoped.map(jobIdForItem).filter((j): j is string => !!j)
    }
    return decided
      .filter((d) => (cat === 'failed' ? !d.ok : d.ok && d.workflow === cat))
      .map((d) => d.jobId)
      .filter((j): j is string => !!j)
  }, [queueItems, decided, cat, hotIds, isQueueCat])

  const index = orderedJobIds.indexOf(jobId)
  // Queue fields (fallback card, notes, wait timer) resolve against the raw
  // queue regardless of which category we navigated in from.
  const current = raw.find((i) => jobIdForItem(i) === jobId) ?? null

  // Session disposition — when this property was already decided this
  // session the hero shows a dated warning chip instead of pretending
  // it's untouched. Read post-mount: sessionStorage is client-only and
  // would diverge between SSR and hydration.
  const [disposition, setDisposition] = useState<{ workflow: 'prep_offer' | 'no_margin'; at: number } | null>(null)
  useEffect(() => {
    setDisposition(decisionFor(jobId, current?.leadId))
  }, [jobId, current?.leadId])

  const goToId = useCallback(
    (jid: string | null | undefined) => {
      if (jid) {
        prefetchReport(jid)
        router.push(`/dashboard/give-offer/${jid}?cat=${cat}`)
      } else router.push('/dashboard/give-offer')
    },
    [router, cat],
  )

  // Remember where we were — the Offers dashboard's Resume button jumps
  // straight back here.
  useEffect(() => {
    setLastViewed(jobId, current?.address ?? current?.displayName ?? null)
  }, [jobId, current?.address, current?.displayName])

  const advance = useCallback((workflow: 'prep_offer' | 'no_margin') => {
    if (current) recordDecision(current, workflow, jobId)
    const nextId = orderedJobIds[index + 1] ?? orderedJobIds[0]
    // Warm the next report during the outcome-chip window so the report
    // page lands on content — no skeleton flash a beat after navigation.
    prefetchReport(nextId)
    // Let the chip read, veil in, swap the route under cover, reveal.
    setTimeout(() => {
      veilFromJob.current = jobId
      setVeil(true)
      setTimeout(() => {
        setRaw((prev) => prev.filter((i) => i.leadId !== current?.leadId))
        goToId(nextId)
      }, 240)
    }, 1400)
  }, [current, orderedJobIds, index, goToId, jobId])

  // A failed dispatch is recorded (Failed category) but never advances —
  // the operator stays on the report to retry.
  const recordFailed = useCallback((workflow: 'prep_offer' | 'no_margin') => {
    if (current) recordDecision(current, workflow, jobId, false)
  }, [current, jobId])

  // Reveal once the destination has mounted and painted a frame — the
  // jobId dep restarts the short reveal timer when the route swaps; if
  // the swap never lands the long timer drops the veil anyway.
  useEffect(() => {
    if (!veil) return
    const swapped = veilFromJob.current !== jobId
    const t = setTimeout(() => setVeil(false), swapped ? 320 : 2500)
    return () => clearTimeout(t)
  }, [jobId, veil])

  // Queue controls shared by the standalone strip (fallback/loading
  // states) and the compact cluster rendered inside the header card.
  const controls = (
    <>
      <span className="text-foreground-tertiary tabular-nums">
        {index >= 0 ? `${index + 1} of ${orderedJobIds.length}` : `${orderedJobIds.length} in ${cat}`}
      </span>
      {isQueueCat && current && (
        <span className="flex items-center gap-1 text-foreground-secondary tabular-nums">
          <Timer size={11} className="text-foreground-tertiary" />
          {formatWait(Math.floor((now - parseQueuedAt(current.queuedAt)) / 1000))}
        </span>
      )}
      {/* Sort lives in the item view — changing it re-orders the queue and
          lands on the new front of the line. */}
      {isQueueCat && (
        <span className="flex items-center gap-1">
          <ListFilter size={11} className="text-foreground-tertiary" />
          <select
            value={filter}
            onChange={(e) => {
              const v = e.target.value as WaitFilter
              setFilter(v)
              window.localStorage.setItem(SORT_PREF_KEY, v)
              const reordered = sortedQueue(raw, v).filter((i) => !decidedIds.has(i.leadId))
              const scoped = cat === 'hot' ? reordered.filter((i) => hotIds.has(i.leadId)) : reordered
              goToId(scoped[0] ? jobIdForItem(scoped[0]) : null)
            }}
            className="bg-transparent text-foreground-secondary text-[11px] outline-none cursor-pointer"
          >
            {Object.entries(WAIT_FILTER_LABELS).map(([v, label]) => (
              <option key={v} value={v}>{label}</option>
            ))}
          </select>
        </span>
      )}
      <button
        type="button"
        disabled={index <= 0}
        onClick={() => goToId(orderedJobIds[index - 1])}
        className="p-1 rounded hover:bg-secondary disabled:opacity-30 transition-colors"
        title="Previous property"
      >
        <ChevronLeft size={14} />
      </button>
      <button
        type="button"
        onClick={() => goToId(orderedJobIds[index + 1] ?? (index === -1 ? orderedJobIds[0] : undefined))}
        disabled={orderedJobIds.length === 0 || index >= orderedJobIds.length - 1}
        className="p-1 rounded hover:bg-secondary disabled:opacity-30 transition-colors"
        title="Skip — next property"
      >
        <ChevronRight size={14} />
      </button>
    </>
  )

  // Standalone strip — only used where the header card isn't rendered
  // (QueueFallback + loading states).
  const bar = (
    <div className="shrink-0 no-print border-b border-border bg-background px-4 sm:px-6 lg:px-4 py-1.5 flex items-center gap-3 text-[11px]">
      <Link href="/dashboard/give-offer" className="font-semibold hover:text-foreground-secondary transition-colors" title="Back to the offer queue">Offers</Link>
      {controls}
      <span className="flex-1" />
    </div>
  )

  // Compact cluster — lives inside the header card so queue navigation
  // stays inside the shared 64px band baseline instead of a separate bar.
  const inline = (
    <span className="flex items-center gap-2.5 text-[11px] text-foreground-tertiary flex-shrink-0">
      {controls}
    </span>
  )

  return (
    <>
      <DashboardReportPage
      params={reportParams}
      queue={{
        node: bar,
        inline,
        backHref: '/dashboard/give-offer',
        loaded: queueLoaded,
        onDecided: advance,
        onFailed: recordFailed,
        fallback: current
          ? {
              leadId: current.leadId,
              address: current.address ?? current.displayName ?? current.leadId,
              wholesalePrice: current.wholesalePrice,
              listPrice: current.listPrice ?? null,
              opportunityId: current.opportunityId,
            }
          : undefined,
        /** Live realtor notes riding the queue item — shown while the
         *  persisted report snapshot (sellerNotes) is absent. */
        notes: current?.conditionNotes ?? null,
        disposition,
      }}
    />
      {/* Disposition transition veil — opaque page-colored cover that
          fades in over the chip, the route swap happens beneath it, then
          it fades out on the settled next report. */}
      <div
        aria-hidden
        className={cn(
          'fixed inset-y-0 right-0 left-0 z-[90] bg-background transition-opacity duration-300 ease-out pointer-events-none',
          collapsed ? 'lg:left-[72px]' : 'lg:left-64',
          veil ? 'opacity-100' : 'opacity-0',
        )}
      />
    </>
  )
}
