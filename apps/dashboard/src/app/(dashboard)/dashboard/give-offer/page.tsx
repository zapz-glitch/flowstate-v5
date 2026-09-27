'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ChevronRight, FileSignature, ListFilter, Play, Timer } from 'lucide-react'
import { getOfferQueue, getPipelineMetrics, type PipelineItem, type PipelineMetrics } from './actions'
import { decidedIds, formatWait, jobIdForItem, parseQueuedAt, sortedQueue, getCachedQueue, setCachedQueue, WAIT_FILTER_LABELS, type WaitFilter } from './queue'

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

function MetricCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="px-3 py-2">
      <div className="text-[9px] uppercase tracking-wider text-foreground-tertiary">{label}</div>
      <div className="text-sm font-bold tabular-nums mt-0.5">{value}</div>
    </div>
  )
}

export default function GiveOfferPage() {
  const router = useRouter()
  const [raw, setRaw] = useState<PipelineItem[]>(getCachedQueue() ?? [])
  const [metrics, setMetrics] = useState<PipelineMetrics | null>(null)
  const [loaded, setLoaded] = useState(getCachedQueue() != null)
  const [failed, setFailed] = useState(false)
  const [filter, setFilter] = useState<WaitFilter>('longest')
  const now = useNow()

  useEffect(() => {
    const saved = window.localStorage.getItem(SORT_PREF_KEY)
    if (saved && saved in WAIT_FILTER_LABELS) setFilter(saved as WaitFilter)
  }, [])

  useEffect(() => {
    let cancelled = false
    const load = () => {
      getOfferQueue().then((q) => {
        if (cancelled) return
        if (q.ok) {
          setCachedQueue(q.items)
          setRaw(q.items)
          setFailed(false)
        } else {
          setFailed(true)
        }
        setLoaded(true)
      })
      getPipelineMetrics().then((m) => {
        if (!cancelled && m.ok) setMetrics(m.metrics)
      })
    }
    load()
    const t = setInterval(load, POLL_MS)
    return () => { cancelled = true; clearInterval(t) }
  }, [])

  const items = useMemo(
    () => sortedQueue(raw, filter).filter((i) => !decidedIds.has(i.leadId)),
    [raw, filter],
  )
  const first = items[0]

  return (
    <div className="flex flex-col h-full">
      {/* Header: title + count + start */}
      <div className="shrink-0 border-b border-border px-4 sm:px-6 py-3">
        <div className="flex items-center gap-3">
          <h1 className="text-sm font-semibold">Give Offer</h1>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-secondary text-foreground-secondary tabular-nums">
            {items.length} in queue
          </span>
          <div className="ml-auto flex items-center gap-2">
            <span className="flex items-center gap-1 text-[10px] text-foreground-tertiary">
              <ListFilter size={11} />
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
            {first && (
              <button
                type="button"
                onClick={() => router.push(`/dashboard/give-offer/${jobIdForItem(first)}`)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-emerald-600 text-white text-xs font-medium hover:bg-emerald-500 transition-colors"
              >
                <Play size={12} />
                Start offers
              </button>
            )}
          </div>
        </div>
        {metrics && (
          <div className="grid grid-cols-4 sm:grid-cols-8 divide-x divide-border border border-border rounded-sm bg-background mt-2">
            <MetricCell label="Reach-outs" value={String(metrics.newReachouts)} />
            <MetricCell label="Responses" value={String(metrics.responses)} />
            <MetricCell
              label="Conv."
              value={metrics.responseRatePct == null ? '—' : `${Math.round(metrics.responseRatePct)}%`}
            />
            <MetricCell label="Reactivated" value={String(metrics.reactivations)} />
            <MetricCell label="To underwrite" value={String(metrics.sentToUnderwriting)} />
            <MetricCell label="Offers prepped" value={String(metrics.offersPrepped)} />
            <MetricCell label="Sent" value={String(metrics.offersSent)} />
            <MetricCell
              label="Avg prep"
              value={metrics.avgPrepMinutes == null ? '—' : `${Math.round(metrics.avgPrepMinutes)}m`}
            />
          </div>
        )}
      </div>

      {/* Queue list — reports-style rows, each links to its item page */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {!loaded ? (
          <div className="p-6 text-sm text-foreground-tertiary animate-pulse">Loading the offer queue…</div>
        ) : failed && items.length === 0 ? (
          <div className="p-6 text-sm text-red-500">Couldn&apos;t load the queue — try refreshing.</div>
        ) : items.length === 0 ? (
          <div className="p-6 text-sm text-foreground-tertiary">
            Nothing waiting on an offer — properties land here when underwriting completes.
          </div>
        ) : (
          items.map((item, i) => {
            const jobId = jobIdForItem(item)
            const wait = Math.max(0, Math.floor((now - parseQueuedAt(item.queuedAt)) / 1000))
            const row = (
              <>
                <div className="w-8 text-[10px] text-foreground-tertiary tabular-nums flex-shrink-0">#{i + 1}</div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate">{item.address ?? item.displayName ?? item.leadId}</div>
                  <div className="flex items-center gap-3 mt-0.5 text-[11px] text-foreground-tertiary">
                    <span className="flex items-center gap-1 tabular-nums">
                      <Timer size={10} />
                      {formatWait(wait)} in queue
                    </span>
                    {item.wholesalePrice != null && (
                      <span className="tabular-nums">
                        Wholesale <b className="text-foreground-secondary">${item.wholesalePrice.toLocaleString('en-US')}</b>
                      </span>
                    )}
                  </div>
                </div>
                <span className="flex items-center gap-1.5 text-[11px] text-foreground-tertiary flex-shrink-0">
                  <FileSignature size={12} />
                  Review
                  <ChevronRight size={13} />
                </span>
              </>
            )
            return jobId ? (
              <Link
                key={item.leadId}
                href={`/dashboard/give-offer/${jobId}`}
                className="flex items-center gap-3 px-4 sm:px-6 py-3 border-b border-border/50 hover:bg-secondary/30 transition-colors"
              >
                {row}
              </Link>
            ) : (
              <div key={item.leadId} className="flex items-center gap-3 px-4 sm:px-6 py-3 border-b border-border/50 opacity-60">
                {row}
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
