import { useState, useCallback, useRef } from 'react'
import type { CompItem } from '@/components/analysis/shared-types'
import { getCompKey } from '@/components/analysis/format-helpers'

/**
 * Shared hook for map↔list interaction used by both playground and report pages.
 * Manages marker highlighting, scroll-to-card, and comparison dialog state.
 *
 * @param getComps - Function that returns the current comp items array.
 *                   Called on each marker click to find the comp by key.
 */
export function useMapInteraction(getComps: () => CompItem[]) {
  const [activeMarkerKey, setActiveMarkerKey] = useState<string | null>(null)
  const [comparisonComp, setComparisonComp] = useState<CompItem | null>(null)
  const [comparisonOpen, setComparisonOpen] = useState(false)

  const scrollAndHighlight = useCallback((key: string) => {
    const el = document.querySelector(`[data-card-key="${key}"]`)
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      el.classList.add('ring-2', 'ring-primary', 'ring-offset-2', 'ring-offset-background')
      setTimeout(() => {
        el.classList.remove('ring-2', 'ring-primary', 'ring-offset-2', 'ring-offset-background')
        setActiveMarkerKey(null)
      }, 2000)
      return true
    }
    return false
  }, [])

  // Stable ref for getComps so the callback doesn't re-create on every comp change
  const getCompsRef = useRef(getComps)
  getCompsRef.current = getComps

  const handleMarkerSelect = useCallback((type: 'subject' | 'comp', compKey?: string) => {
    const key = type === 'subject' ? 'subject' : compKey
    if (!key) return
    setActiveMarkerKey(key)

    // Open comparison dialog for comp clicks
    if (type === 'comp' && compKey) {
      const compItems = getCompsRef.current()
      const comp = compItems.find((c, i) => getCompKey(c, i) === compKey)
      if (comp) {
        setComparisonComp(comp)
        setComparisonOpen(true)
        return
      }
    }

    if (!scrollAndHighlight(key)) {
      setTimeout(() => scrollAndHighlight(key), 150)
    }
  }, [scrollAndHighlight])

  return {
    activeMarkerKey,
    comparisonComp,
    setComparisonComp,
    comparisonOpen,
    setComparisonOpen,
    handleMarkerSelect,
  }
}
