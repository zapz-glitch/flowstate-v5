'use client'

import { use, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ChevronLeft, ChevronRight, Timer, ListFilter } from 'lucide-react'
import DashboardReportPage from '../../reports/[jobId]/page'
import { getOfferQueue, type PipelineItem } from '../actions'
import { jobIdForItem, parseQueuedAt, sortedQueue, formatWait, WAIT_FILTER_LABELS, type WaitFilter } from '../queue'

const POLL_MS = 5000
const SORT_PREF_KEY = 'giveOffer.waitFilter'

/** Decided items stay out of the queue for this SPA session even if the
 * engine hasn't dequeued them yet on the next poll. */
const decidedIds = new Set<string>()

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
  const router = useRouter()
  const [raw, setRaw] = useState<PipelineItem[]>([])
  const [filter, setFilter] = useState<WaitFilter>('longest')
  const now = useNow()

  useEffect(() => {
    const saved = window.localStorage.getItem(SORT_PREF_KEY)
    if (saved && saved in WAIT_FILTER_LABELS) setFilter(saved as WaitFilter)
  }, [])

  useEffect(() => {
    let cancelled = false
    const load = () =>
      getOfferQueue().then((q) => {
        if (cancelled || !q.ok) return
        setRaw(q.items)
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
      if (next) router.push(`/dashboard/give-offer/${next}`)
      else router.push('/dashboard/give-offer')
    },
    [router],
  )

  const advance = useCallback(() => {
    if (current) decidedIds.add(current.leadId)
    // Let the hero's outcome chip read first, then roll to the next deal.
    setTimeout(() => {
      setRaw((prev) => prev.filter((i) => i.leadId !== current?.leadId))
      const next = items[index + 1] ?? items[0]
      goTo(next)
    }, 1400)
  }, [current, items, index, goTo])

  const bar = (
    <div className="shrink-0 no-print border-b border-border bg-background px-3 sm:px-5 py-1.5 flex items-center gap-3 text-[11px]">
      <span className="font-semibold">Give Offer</span>
      <span className="text-foreground-tertiary tabular-nums">
        {index >= 0 ? `${index + 1} of ${items.length}` : `${items.length} queued`}
      </span>
      {current && (
        <span className="flex items-center gap-1 text-foreground-secondary tabular-nums">
          <Timer size={11} className="text-foreground-tertiary" />
          {formatWait(Math.floor((now - parseQueuedAt(current.queuedAt)) / 1000))}
        </span>
      )}
      <span className="flex items-center gap-1 ml-auto">
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
    </div>
  )

  return (
    <DashboardReportPage
      params={Promise.resolve({ jobId })}
      queue={{ node: bar, onDecided: advance }}
    />
  )
}
