'use client'

import { useEffect } from 'react'
import { reloadForStaleAction } from '@/lib/server-action'

/**
 * Global stale-Server-Action recovery. Deploys rotate action IDs; a tab from
 * the previous deploy that invokes an action gets `Failed to find Server
 * Action`. Uncaught rejections land here — reload once so the new bundle's
 * IDs line up. Caught rejections are handled by reloadForStaleAction at the
 * call site.
 */
export function StaleActionGuard() {
  useEffect(() => {
    const onRejection = (e: PromiseRejectionEvent) => {
      if (reloadForStaleAction(e.reason)) e.preventDefault()
    }
    const onError = (e: ErrorEvent) => {
      reloadForStaleAction(e.error ?? e.message)
    }
    window.addEventListener('unhandledrejection', onRejection)
    window.addEventListener('error', onError)
    return () => {
      window.removeEventListener('unhandledrejection', onRejection)
      window.removeEventListener('error', onError)
    }
  }, [])
  return null
}
