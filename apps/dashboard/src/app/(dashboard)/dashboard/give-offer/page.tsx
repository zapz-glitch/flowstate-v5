'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Card } from '@/components/ui/card'
import { getOfferQueue } from './actions'
import { jobIdForItem, sortedQueue, getCachedQueue } from './queue'

export default function GiveOfferPage() {
  const router = useRouter()
  const [state, setState] = useState<'loading' | 'empty' | 'error'>('loading')

  useEffect(() => {
    // Instant redirect when a recent queue is already cached.
    const cached = getCachedQueue()
    if (cached) {
      const first = sortedQueue(cached, 'longest')[0]
      const jobId = first ? jobIdForItem(first) : null
      if (jobId) { router.replace(`/dashboard/give-offer/${jobId}`); return }
    }
    let cancelled = false
    getOfferQueue().then((q) => {
      if (cancelled) return
      if (!q.ok) { setState('error'); return }
      const first = sortedQueue(q.items, 'longest')[0]
      const jobId = first ? jobIdForItem(first) : null
      if (jobId) router.replace(`/dashboard/give-offer/${jobId}`)
      else setState('empty')
    })
    return () => { cancelled = true }
  }, [router])

  return (
    <div className="flex items-center justify-center min-h-[50vh]">
      <Card className="px-8 py-10 text-center max-w-md">
        {state === 'loading' && (
          <>
            <div className="text-body-sm text-foreground-secondary animate-pulse">Loading the offer queue…</div>
          </>
        )}
        {state === 'empty' && (
          <>
            <p className="text-body-sm text-foreground-secondary">Nothing waiting on an offer.</p>
            <p className="text-caption text-foreground-tertiary mt-1">
              Properties land here the moment underwriting completes.
            </p>
          </>
        )}
        {state === 'error' && (
          <p className="text-body-sm text-red-500">Couldn&apos;t load the queue — try refreshing.</p>
        )}
      </Card>
    </div>
  )
}
