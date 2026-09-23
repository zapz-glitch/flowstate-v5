'use client'

import { useEffect, useRef, useCallback, useState } from 'react'

export interface EnrichmentEvent {
  event: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any
}

export interface UseEnrichmentSSEOptions {
  streamUrl: string | null
  token: string | null
  onEvent: (event: EnrichmentEvent) => void
}

const EVENT_TYPES = [
  'connected',
  'property_fetch',
  'subject_found',
  'comps_found',
  'evaluation_started',
  'eval_progress',
  'evaluation_complete',
  'llm_started',
  'llm_complete',
  'market_context',
  'risk_flags_updated',
  'enrichment_done',
  'error',
]

/**
 * Hook to connect to the AnalysisJobDO SSE endpoint for real-time enrichment updates.
 * Auto-disconnects on `enrichment_done` event or component unmount.
 */
export function useEnrichmentSSE({ streamUrl, token, onEvent }: UseEnrichmentSSEOptions) {
  const [isConnected, setIsConnected] = useState(false)
  const [status, setStatus] = useState<'idle' | 'connecting' | 'connected' | 'done' | 'error'>('idle')
  const eventSourceRef = useRef<EventSource | null>(null)
  const onEventRef = useRef(onEvent)
  onEventRef.current = onEvent

  const disconnect = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close()
      eventSourceRef.current = null
    }
    setIsConnected(false)
  }, [])

  useEffect(() => {
    if (!streamUrl || !token) {
      setStatus('idle')
      return
    }

    setStatus('connecting')

    const url = `${streamUrl}?token=${encodeURIComponent(token)}`
    console.log('[EnrichmentSSE] Connecting to:', url)
    const es = new EventSource(url)
    eventSourceRef.current = es

    es.onopen = () => {
      console.log('[EnrichmentSSE] Connected')
      setIsConnected(true)
      setStatus('connected')
    }

    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) {
        setStatus('done')
      } else {
        setStatus('error')
      }
      setIsConnected(false)
    }

    for (const eventType of EVENT_TYPES) {
      es.addEventListener(eventType, (e: MessageEvent) => {
        try {
          const data = JSON.parse(e.data)
          onEventRef.current({ event: eventType, data })

          if (eventType === 'enrichment_done') {
            setStatus('done')
            es.close()
            eventSourceRef.current = null
            setIsConnected(false)
          }
        } catch (err) {
          console.warn(`[EnrichmentSSE] Failed to parse ${eventType} event:`, err)
        }
      })
    }

    return () => {
      es.close()
      eventSourceRef.current = null
      setIsConnected(false)
    }
  }, [streamUrl, token])

  return { isConnected, status, disconnect }
}
