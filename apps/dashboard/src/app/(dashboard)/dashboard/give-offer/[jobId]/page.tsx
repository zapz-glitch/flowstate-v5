'use client'

import { use, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ChevronLeft, ChevronRight, Timer, ListFilter } from 'lucide-react'
import DashboardReportPage from '../../reports/[jobId]/page'
import { getOfferQueue, type PipelineItem } from '../actions'
import { decidedIds, jobIdForItem, parseQueuedAt, sortedQueue, formatWait, WAIT_FILTER_LABELS, type WaitFilter, getCachedQueue, setCachedQueue, prefetchReport } from '../queue'
import { useSidebar } from '@/components/SidebarProvider'
import { cn } from '@/lib/utils'

const POLL_MS = 5000
const SORT_PREF_KEY = 'giveOffer.waitFilter'

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
  const [raw, setRaw] = useState<PipelineItem[]>(getCachedQueue() ?? [])
  const [queueLoaded, setQueueLoaded] = useState(getCachedQueue() != null)
  const [filter, setFilter] = useState<WaitFilter>('longest')
  // Transition veil — covers the chip→nav→mount swap so the disposition
  // advance reads as one smooth crossfade, not a page teardown.
  const [veil, setVeil] = useState(false)
  const veilFromJob = useRef<string | null>(null)
  const { collapsed } = useSidebar()
  const now = useNow()

  useEffect(() => {
    const saved = window.localStorage.getItem(SORT_PREF_KEY)
    if (saved && saved in WAIT_FILTER_LABELS) setFilter(saved as WaitFilter)
  }, [])

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

  const items = useMemo(
    () => sortedQueue(raw, filter).filter((i) => !decidedIds.has(i.leadId)),
    [raw, filter],
  )
  const index = items.findIndex((i) => jobIdForItem(i) === jobId)
  const current = index >= 0 ? items[index] : null

  const goTo = useCallback(
    (item: PipelineItem | undefined) => {
      const next = item ? jobIdForItem(item) : null
      if (next) {
        prefetchReport(next)
        router.push(`/dashboard/give-offer/${next}`)
      } else router.push('/dashboard/give-offer')
    },
    [router],
  )

  const advance = useCallback(() => {
    if (current) decidedIds.add(current.leadId)
    // Warm the next report during the outcome-chip window so the report
    // page lands on content — no skeleton flash a beat after navigation.
    const next = items[index + 1] ?? items[0]
    prefetchReport(next ? jobIdForItem(next) : null)
    // Let the chip read, veil in, swap the route under cover, reveal.
    setTimeout(() => {
      veilFromJob.current = jobId
      setVeil(true)
      setTimeout(() => {
        setRaw((prev) => prev.filter((i) => i.leadId !== current?.leadId))
        goTo(next)
      }, 240)
    }, 1400)
  }, [current, items, index, goTo, jobId])

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
        {index >= 0 ? `${index + 1} of ${items.length}` : `${items.length} queued`}
      </span>
      {current && (
        <span className="flex items-center gap-1 text-foreground-secondary tabular-nums">
          <Timer size={11} className="text-foreground-tertiary" />
          {formatWait(Math.floor((now - parseQueuedAt(current.queuedAt)) / 1000))}
        </span>
      )}
      <span className="flex items-center gap-1">
        <ListFilter size={11} className="text-foreground-tertiary" />
        <select
          value={filter}
          onChange={(e) => {
            const v = e.target.value as WaitFilter
            setFilter(v)
            window.localStorage.setItem(SORT_PREF_KEY, v)
          }}
          className="bg-transparent text-foreground-secondary text-[11px] outline-none cursor-pointer"
        >
          {Object.entries(WAIT_FILTER_LABELS).map(([v, label]) => (
            <option key={v} value={v}>{label}</option>
          ))}
        </select>
      </span>
      <button
        type="button"
        disabled={index <= 0}
        onClick={() => goTo(items[index - 1])}
        className="p-1 rounded hover:bg-secondary disabled:opacity-30 transition-colors"
        title="Previous property"
      >
        <ChevronLeft size={14} />
      </button>
      <button
        type="button"
        onClick={() => goTo(items[index + 1] ?? (index === -1 ? items[0] : undefined))}
        disabled={items.length === 0 || index >= items.length - 1}
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
