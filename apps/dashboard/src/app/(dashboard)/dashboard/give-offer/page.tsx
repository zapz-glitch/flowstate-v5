'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ChevronRight, FileSignature, ListFilter, Play, Timer } from 'lucide-react'
import { getOfferQueue, getPipelineMetrics, type PipelineItem, type PipelineMetrics } from './actions'
import { formatMoneyThousands as fmtK } from '@/components/analysis/valuation-number'
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
    <div className="playground-bg -m-4 sm:-m-6 lg:-m-8 min-h-screen lg:h-[100dvh] flex flex-col lg:overflow-hidden">
      {/* Header band — same geometry + card chrome as Property Search */}
      <div className="px-4 sm:px-6 lg:px-4 pt-3 pb-1 lg:pt-4 lg:pb-0 lg:h-20 lg:flex lg:items-center lg:border-b lg:border-border space-y-3 flex-shrink-0">
        <div className="w-full border border-border/60 overflow-hidden bg-background shadow-sm corner-accents corner-accents-bottom">
          <div className="px-4 py-3 flex items-center gap-3">
            <div className="w-7 h-7 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0">
              <FileSignature className="w-3.5 h-3.5 text-primary" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-body-sm text-foreground-secondary">Give Offer</div>
              <div className="text-xs text-foreground-tertiary">{items.length} in queue</div>
            </div>
            <span className="flex items-center gap-1 text-[10px] text-foreground-tertiary flex-shrink-0">
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
                className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-emerald-600 text-white text-xs font-medium hover:bg-emerald-500 transition-colors flex-shrink-0"
              >
                <Play size={12} />
                Start offers
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Metrics + queue list — same content-region gutters as Property Search */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="px-4 sm:px-6 pt-3 pb-4 space-y-3">
          {metrics && (
            <div className="grid grid-cols-4 sm:grid-cols-8 divide-x divide-border border border-border/60 bg-background shadow-sm">
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

          <div className="border border-border/60 bg-background shadow-sm divide-y divide-border/50">
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
                        <span className="tabular-nums">
                          List <b className="text-foreground-secondary">{item.listPrice != null ? `$${fmtK(item.listPrice)}` : '—'}</b>
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
                    className="flex items-center gap-3 px-4 sm:px-6 py-3 hover:bg-secondary/30 transition-colors"
                  >
                    {row}
                  </Link>
                ) : (
                  <div key={item.leadId} className="flex items-center gap-3 px-4 sm:px-6 py-3 opacity-60">
                    {row}
                  </div>
                )
              })
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
