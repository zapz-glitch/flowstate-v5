'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { FileSignature, Inbox, ListFilter, Play, RotateCcw, CircleSlash, ChevronRight, Copy, Check } from 'lucide-react'
import { getOfferQueue, type PipelineItem } from './actions'
import {
  getCachedQueue,
  getDecidedToday,
  getLastViewed,
  jobIdForItem,
  parseQueuedAt,
  setCachedQueue,
  sortedQueue,
  formatWait,
  WAIT_FILTER_LABELS,
  decidedIds,
  type WaitFilter,
  type DecidedEntry,
} from './queue'

const SORT_PREF_KEY = 'giveOffer.waitFilter'
const POLL_MS = 10000

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

export default function GiveOfferPage() {
  const [raw, setRaw] = useState<PipelineItem[]>(getCachedQueue() ?? [])
  const [loaded, setLoaded] = useState(getCachedQueue() != null)
  const [failed, setFailed] = useState(false)
  const [filter, setFilter] = useState<WaitFilter>('longest')
  const [decided, setDecided] = useState<DecidedEntry[]>([])
  const [lastViewed, setLastViewedState] = useState<{ jobId: string; address: string | null } | null>(null)
  const now = useNow()

  useEffect(() => {
    const saved = window.localStorage.getItem(SORT_PREF_KEY)
    if (saved && saved in WAIT_FILTER_LABELS) setFilter(saved as WaitFilter)
    setDecided(getDecidedToday())
    setLastViewedState(getLastViewed())
  }, [])

  useEffect(() => {
    let cancelled = false
    const load = () =>
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
    load()
    const t = setInterval(load, POLL_MS)
    return () => { cancelled = true; clearInterval(t) }
  }, [])

  const items = useMemo(
    () => {
      getDecidedToday() // hydrates decidedIds from sessionStorage pre-paint
      return sortedQueue(raw, filter).filter((i) => !decidedIds.has(i.leadId))
    },
    [raw, filter],
  )
  const next = items[0]
  const nextJobId = next ? jobIdForItem(next) : null
  const resume = lastViewed && lastViewed.jobId !== nextJobId ? lastViewed : null

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
                  ? `${items.length} in queue${decided.length ? ` · ${decided.length} decided today` : ''}`
                  : 'Loading queue…'}
              </div>
            </div>
            <span className="flex items-center gap-1 text-foreground-tertiary text-[11px]">
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
          </div>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="px-4 sm:px-6 lg:px-4 pt-3 pb-6 space-y-3">
          {/* Actions row — continue the queue or jump back to the last report */}
          {(nextJobId || resume) && (
            <div className="border border-border/60 bg-background shadow-sm px-3 py-2 flex items-center gap-2 flex-wrap">
              {nextJobId && (
                <Link
                  href={`/dashboard/give-offer/${nextJobId}`}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-primary/10 text-primary text-xs font-medium hover:bg-primary/20 transition-colors"
                >
                  <Play size={12} />
                  Next up — {next!.address ?? 'top of queue'}
                </Link>
              )}
              {resume && (
                <Link
                  href={`/dashboard/give-offer/${resume.jobId}`}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-border text-xs text-foreground-secondary hover:bg-secondary transition-colors"
                >
                  <RotateCcw size={12} />
                  Last report — {resume.address ?? resume.jobId}
                </Link>
              )}
            </div>
          )}

          {/* Pending queue */}
          <div className="border border-border/60 bg-background shadow-sm overflow-hidden">
            <div className="px-3 py-2 border-b border-border/50 text-[10px] font-semibold uppercase tracking-wider text-foreground-tertiary">
              Queue
            </div>
            {failed ? (
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
            ) : items.length === 0 ? (
              <div className="px-4 py-8 flex flex-col items-center gap-2 text-center">
                <Inbox className="w-5 h-5 text-foreground-tertiary" />
                <div className="text-body-sm text-foreground-secondary">Queue is clear</div>
                <div className="text-xs text-foreground-tertiary">
                  Every queued property has been dispositioned — new ones land here as they reach underwriting.
                </div>
              </div>
            ) : (
              <div className="divide-y divide-border/40">
                {items.map((item) => {
                  const jid = jobIdForItem(item)!
                  const addr = item.address ?? item.displayName ?? item.leadId
                  const wait = formatWait(Math.floor((now - parseQueuedAt(item.queuedAt)) / 1000))
                  const price = fmtPrice(item.listPrice ?? item.wholesalePrice)
                  return (
                    <Link
                      key={item.leadId}
                      href={`/dashboard/give-offer/${jid}`}
                      className="flex items-center gap-3 px-3 py-2 hover:bg-secondary/50 transition-colors group"
                    >
                      <ChevronRight size={13} className="text-foreground-tertiary flex-shrink-0 group-hover:text-foreground-secondary" />
                      <div className="flex-1 min-w-0">
                        <div className="text-xs text-foreground truncate">{addr}</div>
                        <div className="text-[10px] text-foreground-tertiary">waiting {wait}{price ? ` · ${price}` : ''}</div>
                      </div>
                      <CopyAddr text={addr} />
                    </Link>
                  )
                })}
              </div>
            )}
          </div>

          {/* Decided today — revisit any disposition, copy the address */}
          {decided.length > 0 && (
            <div className="border border-border/60 bg-background shadow-sm overflow-hidden">
              <div className="px-3 py-2 border-b border-border/50 text-[10px] font-semibold uppercase tracking-wider text-foreground-tertiary">
                Decided today
              </div>
              <div className="divide-y divide-border/40">
                {decided.map((d) => {
                  const inner = (
                    <>
                      {d.workflow === 'prep_offer' ? (
                        <FileSignature size={13} className="text-emerald-500 flex-shrink-0" />
                      ) : (
                        <CircleSlash size={13} className="text-foreground-tertiary flex-shrink-0" />
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="text-xs text-foreground truncate">{d.address}</div>
                        <div className="text-[10px] text-foreground-tertiary">
                          {d.workflow === 'prep_offer' ? 'Offer prep' : 'No margin'} · {fmtTime(d.at)}
                        </div>
                      </div>
                      <CopyAddr text={d.address} />
                    </>
                  )
                  return d.jobId ? (
                    <Link
                      key={d.leadId + d.at}
                      href={`/dashboard/give-offer/${d.jobId}`}
                      className="flex items-center gap-3 px-3 py-2 hover:bg-secondary/50 transition-colors"
                    >
                      {inner}
                    </Link>
                  ) : (
                    <div key={d.leadId + d.at} className="flex items-center gap-3 px-3 py-2">
                      {inner}
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
