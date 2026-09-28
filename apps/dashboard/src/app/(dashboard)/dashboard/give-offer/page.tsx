'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { FileSignature, Inbox } from 'lucide-react'
import { getOfferQueue, type PipelineItem } from './actions'
import {
  decidedIds,
  getCachedQueue,
  jobIdForItem,
  setCachedQueue,
  sortedQueue,
  WAIT_FILTER_LABELS,
  type WaitFilter,
} from './queue'

const SORT_PREF_KEY = 'giveOffer.waitFilter'

export default function GiveOfferPage() {
  const router = useRouter()
  const [raw, setRaw] = useState<PipelineItem[]>(getCachedQueue() ?? [])
  const [loaded, setLoaded] = useState(getCachedQueue() != null)
  const [failed, setFailed] = useState(false)
  const [filter, setFilter] = useState<WaitFilter>('longest')
  const [navigated, setNavigated] = useState(false)

  useEffect(() => {
    const saved = window.localStorage.getItem(SORT_PREF_KEY)
    if (saved && saved in WAIT_FILTER_LABELS) setFilter(saved as WaitFilter)
  }, [])

  useEffect(() => {
    let cancelled = false
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
    return () => {
      cancelled = true
    }
  }, [])

  const items = useMemo(
    () => sortedQueue(raw, filter).filter((i) => !decidedIds.has(i.leadId)),
    [raw, filter],
  )
  const first = items[0]
  const firstJobId = first ? jobIdForItem(first) : null

  // Offers opens the top-priority queued property directly — the active
  // wait filter decides which one is first.
  useEffect(() => {
    if (!loaded || navigated || !firstJobId) return
    setNavigated(true)
    router.replace(`/dashboard/give-offer/${firstJobId}`)
  }, [loaded, navigated, firstJobId, router])

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
                {loaded ? `${items.length} in queue` : 'Loading queue…'}
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="px-4 sm:px-6 pt-3 pb-4">
          <div className="border border-border/60 bg-background shadow-sm px-4 py-10 flex flex-col items-center justify-center text-center gap-2">
            {failed ? (
              <>
                <Inbox className="w-5 h-5 text-foreground-tertiary" />
                <div className="text-body-sm text-foreground-secondary">Queue unavailable</div>
                <div className="text-xs text-foreground-tertiary">The engine did not respond — try again shortly.</div>
              </>
            ) : !loaded || first ? (
              <>
                <div className="w-5 h-5 rounded-full border-2 border-primary/30 border-t-primary animate-spin" />
                <div className="text-body-sm text-foreground-secondary">
                  {first ? `Opening ${first.address ?? 'next property'}…` : 'Loading queue…'}
                </div>
              </>
            ) : (
              <>
                <Inbox className="w-5 h-5 text-foreground-tertiary" />
                <div className="text-body-sm text-foreground-secondary">Queue is clear</div>
                <div className="text-xs text-foreground-tertiary">
                  Every queued property has been dispositioned — new ones land here as they reach underwriting.
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
