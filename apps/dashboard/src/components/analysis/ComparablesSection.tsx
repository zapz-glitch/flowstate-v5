'use client'

import { useState, useEffect, useMemo } from 'react'
import { SlidersHorizontal, RotateCcw, Loader2, LayoutGrid, List, ArrowUpDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { CompsData, CompItem, SubjectData } from './shared-types'
import { getCompKey, normalizeSubdivision } from './format-helpers'
import { CompCard } from './CompCard'
import { CompGridCard } from './CompGridCard'
import { RuleMatchDetails } from './RuleMatchDetails'

export interface ComparablesSectionProps {
  comps: CompsData
  subjectSubdivision?: string | null
  /** Subject property data for map display */
  subject?: SubjectData | null
  /** If provided, enables interactive comp selection mode */
  selectedCompKeys?: Set<string>
  /** Whether selection has been manually changed */
  isManual?: boolean
  /** Recalculated ARV to display in manual mode banner */
  recalculatedArv?: number
  /** Called when a comp's ARV toggle is clicked */
  onToggleComp?: (key: string) => void
  /** Called when reset button is clicked */
  onReset?: () => void
  /** When set, auto-expands excluded section and highlights this comp key */
  highlightedCompKey?: string | null
  /** When true, shows all comps expanded with analysis-in-progress animation */
  isAnalyzing?: boolean
  /** Called to trigger AI comp selection */
  onRunAiAnalysis?: () => void
  /** Called to undo AI comp selection — only passed when AI analysis has been done */
  onUndoAiSelection?: () => void
  /** Called when a comp card is clicked (for comparison dialog) */
  onCompClick?: (comp: CompItem) => void
  /** Called when a comp card is hovered (for map marker sync) */
  onCompHover?: (key: string | null) => void
}

type SortOption = 'default' | 'subdivision' | 'distance' | 'price' | 'psf'

const SORT_LABELS: Record<SortOption, string> = {
  default: 'Default',
  subdivision: 'Subdivision',
  distance: 'Distance',
  price: 'Price',
  psf: '$/Sqft',
}

export function ComparablesSection({
  comps,
  subjectSubdivision,
  subject,
  selectedCompKeys,
  isManual = false,
  recalculatedArv,
  onToggleComp,
  onReset,
  highlightedCompKey,
  isAnalyzing = false,
  onRunAiAnalysis,
  onUndoAiSelection,
  onCompClick,
  onCompHover,
}: ComparablesSectionProps) {
  const [expandedComps, setExpandedComps] = useState<Set<string>>(new Set())
  const [excludedOpen, setExcludedOpen] = useState(false)
  const [layout, setLayout] = useState<'grid' | 'list'>('grid')
  const [sortBy, setSortBy] = useState<SortOption>('default')
  const [sortDesc, setSortDesc] = useState(true)

  // Auto-expand excluded section when a highlighted comp is in it
  useEffect(() => {
    if (!highlightedCompKey) return
    const compItems = comps.items || []
    const isExcluded = selectedCompKeys
      ? !selectedCompKeys.has(highlightedCompKey)
      : compItems.some((c, i) => getCompKey(c, i) === highlightedCompKey && c.isEnabled === false)
    if (isExcluded && !excludedOpen) {
      setExcludedOpen(true)
    }
  }, [highlightedCompKey, comps.items, selectedCompKeys, excludedOpen])
  const compItems = comps.items || []

  // Sorted items preserving original index for stable keys & map marker numbering
  const sortedItems = useMemo(() => {
    const indexed = compItems.map((comp, i) => ({ comp, originalIndex: i }))
    if (sortBy === 'default') return indexed
    const dir = sortDesc ? -1 : 1
    const sorted = [...indexed]
    switch (sortBy) {
      case 'subdivision': {
        // Subject-subdivision matches first (desc) / last (asc), then by name
        const subNorm = normalizeSubdivision(subjectSubdivision)
        sorted.sort((a, b) => {
          const aMatch = normalizeSubdivision(a.comp.subdivision) === subNorm ? 1 : 0
          const bMatch = normalizeSubdivision(b.comp.subdivision) === subNorm ? 1 : 0
          if (aMatch !== bMatch) return dir * (aMatch - bMatch)
          return (a.comp.subdivision ?? '').localeCompare(b.comp.subdivision ?? '')
        })
        break
      }
      case 'distance':
        sorted.sort((a, b) => dir * ((a.comp.distanceMiles ?? 999) - (b.comp.distanceMiles ?? 999)))
        break
      case 'price':
        sorted.sort((a, b) => dir * ((a.comp.salePrice ?? 0) - (b.comp.salePrice ?? 0)))
        break
      case 'psf':
        sorted.sort((a, b) => dir * ((a.comp.pricePerSqft ?? 0) - (b.comp.pricePerSqft ?? 0)))
        break
    }
    return sorted
  }, [compItems, sortBy, sortDesc])

  const hasInteractiveSelection = !!selectedCompKeys

  const toggleExpand = (key: string) => {
    const next = new Set(expandedComps)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    setExpandedComps(next)
  }

  // Group comps based on selection mode
  const arvComps = hasInteractiveSelection
    ? compItems.filter((_c, i) => selectedCompKeys!.has(getCompKey(_c, i)))
    : compItems.filter((c) => c.isEnabled === true)
  const excludedComps = hasInteractiveSelection
    ? compItems.filter((_c, i) => !selectedCompKeys!.has(getCompKey(_c, i)))
    : compItems.filter((c) => c.isEnabled !== true)
  // If no comps are selected (e.g. streaming, before evaluation), show all in main section
  const showAllFlat = arvComps.length === 0 && excludedComps.length > 0

  const selectedCount = arvComps.length

  // Stats from selected comps
  const selectedPrices = arvComps
    .map((c) => c.adjustedPrice ?? c.salePrice)
    .filter((p): p is number => p != null && p > 0)
    .sort((a, b) => a - b)
  const priceMin = selectedPrices.length > 0 ? selectedPrices[0] : null
  const priceMax = selectedPrices.length > 0 ? selectedPrices[selectedPrices.length - 1] : null
  const avgPsf = (() => {
    const psfs = arvComps.filter((c) => c.pricePerSqft != null && c.pricePerSqft > 0).map((c) => c.pricePerSqft!)
    return psfs.length > 0 ? Math.round(psfs.reduce((s, p) => s + p, 0) / psfs.length) : null
  })()

  return (
    <div>
      <div className="mb-4 space-y-2">
        {/* Row 1: Title + stats + actions */}
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <h3 className="text-body font-semibold">Comparables</h3>
            <span className="text-[10px] text-foreground-tertiary tabular-nums">
              {selectedCount} selected
              {excludedComps.length > 0 && ` · ${excludedComps.length} excluded`}
              {avgPsf != null && ` · $${avgPsf}/sf avg`}
              {priceMin != null && priceMax != null && priceMin !== priceMax && (
                <span className="hidden sm:inline"> · ${(priceMin / 1000).toFixed(0)}k–${(priceMax / 1000).toFixed(0)}k</span>
              )}
            </span>
          </div>
          <div className="flex items-center gap-2">
            {/* Grid/List toggle */}
            <div className="flex items-center border border-border rounded overflow-hidden no-print">
              <button
                type="button"
                onClick={() => setLayout('grid')}
                className={cn('p-1.5 transition-colors', layout === 'grid' ? 'bg-primary/10 text-primary' : 'text-foreground-tertiary hover:text-foreground')}
                title="Grid view"
              >
                <LayoutGrid className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={() => setLayout('list')}
                className={cn('p-1.5 transition-colors', layout === 'list' ? 'bg-primary/10 text-primary' : 'text-foreground-tertiary hover:text-foreground')}
                title="List view"
              >
                <List className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </div>

        {/* Row 2: Sort controls */}
        <div className="flex items-center gap-1 no-print">
          <ArrowUpDown className="w-3 h-3 text-foreground-tertiary mr-0.5" />
          {(['default', 'subdivision', 'distance', 'price', 'psf'] as const).map((opt) => (
            <button
              key={opt}
              type="button"
              onClick={() => {
                if (sortBy === opt && opt !== 'default') setSortDesc((d) => !d)
                else { setSortBy(opt); setSortDesc(true) }
              }}
              className={cn(
                'text-[10px] px-2 py-0.5 rounded transition-colors inline-flex items-center gap-0.5',
                sortBy === opt
                  ? 'bg-primary/15 text-primary font-medium'
                  : 'text-foreground-tertiary hover:text-foreground hover:bg-secondary'
              )}
            >
              {SORT_LABELS[opt]}
              {sortBy === opt && opt !== 'default' && (
                <span className="text-[8px]">{sortDesc ? '↓' : '↑'}</span>
              )}
            </button>
          ))}
        </div>

        {/* Manual mode banner */}
        {isManual && (
          <div className="px-3 py-2 bg-amber-500/8 border border-amber-500/20 flex items-center justify-between gap-3 no-print">
            <div className="flex items-center gap-2">
              <SlidersHorizontal className="w-3.5 h-3.5 text-amber-600 flex-shrink-0" />
              <span className="text-caption text-amber-700 dark:text-amber-400">
                Manual · {selectedCount} comp{selectedCount !== 1 ? 's' : ''} · ARV: <span className="font-semibold tabular-nums">~${recalculatedArv?.toLocaleString() ?? '—'}</span>
              </span>
            </div>
            {onReset && (
              <button
                type="button"
                onClick={onReset}
                className="flex items-center gap-1 text-caption text-amber-600 hover:text-amber-700 font-medium transition-colors"
              >
                <RotateCcw className="w-3 h-3" />
                Reset
              </button>
            )}
          </div>
        )}
      </div>

      {comps.items?.some(comp => comp.priorityRank != null) && (
        <p className="mb-3 text-[11px] text-foreground">
          Priority order: subdivision, year built, square footage, lot size, physical style. Rule match reports enabled-rule results separately from this ranking.
        </p>
      )}

      {/* Print-only compact comp table */}
      <div className="hidden print:block px-6 py-4">
        {arvComps.length > 0 && (
          <div className="mb-4">
            <div className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-2">Selected for ARV ({arvComps.length})</div>
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="border-b border-gray-200">
                  <th className="text-left py-1.5 pr-4 font-medium text-gray-500">#</th>
                  <th className="text-left py-1.5 pr-4 font-medium text-gray-500">Address</th>
                  <th className="text-right py-1.5 px-2 font-medium text-gray-500">Sale Price</th>
                  <th className="text-right py-1.5 px-2 font-medium text-gray-500">Adj. Price</th>
                  <th className="text-right py-1.5 px-2 font-medium text-gray-500">Sq Ft</th>
                  <th className="text-right py-1.5 px-2 font-medium text-gray-500">$/Sqft</th>
                  <th className="text-right py-1.5 pl-2 font-medium text-gray-500">Sold</th>
                </tr>
              </thead>
              <tbody>
                {arvComps.map((comp, i) => (
                  <tr key={i} className="border-b border-gray-100">
                    <td className="py-1.5 pr-4 text-gray-400">{i + 1}</td>
                    <td className="py-1.5 pr-4 font-medium">{comp.address}<RuleMatchDetails comp={comp} /></td>
                    <td className="text-right py-1.5 px-2">${comp.salePrice?.toLocaleString() || '-'}</td>
                    <td className="text-right py-1.5 px-2 text-emerald-700">{comp.adjustedPrice ? `$${comp.adjustedPrice.toLocaleString()}` : '-'}</td>
                    <td className="text-right py-1.5 px-2">{comp.squareFeet?.toLocaleString() || '-'}</td>
                    <td className="text-right py-1.5 px-2">{comp.pricePerSqft ? `$${comp.pricePerSqft.toFixed(0)}` : '-'}</td>
                    <td className="text-right py-1.5 pl-2 text-gray-500">{comp.saleDate ? new Date(comp.saleDate).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }) : '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {excludedComps.length > 0 && (
          <div>
            <div className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-2">Excluded ({excludedComps.length})</div>
            <table className="w-full text-xs border-collapse">
              <tbody>
                {excludedComps.map((comp, i) => (
                  <tr key={i} className="border-b border-gray-100 text-gray-400">
                    <td className="py-1 pr-4">{comp.address}<RuleMatchDetails comp={comp} /></td>
                    <td className="text-right py-1 px-2">${comp.salePrice?.toLocaleString() || '-'}</td>
                    <td className="text-right py-1 pl-2">
                      {comp.disableReasons?.join(', ') || 'Manually excluded'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* All comps — grid or list */}
      <div className="print:hidden">
        {layout === 'grid' ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {sortedItems.map(({ comp, originalIndex }) => {
              const key = getCompKey(comp, originalIndex)
              const isSelected = hasInteractiveSelection
                ? selectedCompKeys!.has(key)
                : comp.isEnabled === true
              return (
                <CompGridCard
                  key={key}
                  comp={comp}
                  index={originalIndex}
                  subject={subject}
                  isSelectedForArv={isSelected}
                  onToggleArv={onToggleComp ? () => onToggleComp(key) : undefined}
                  onClick={() => onCompClick?.(comp)}
                  onHover={onCompHover ? (hovering) => onCompHover(hovering ? key : null) : undefined}
                  isHighlighted={highlightedCompKey === key}
                />
              )
            })}
          </div>
        ) : (
          <div className="space-y-3">
            {sortedItems.map(({ comp, originalIndex }) => {
              const key = getCompKey(comp, originalIndex)
              const isSelected = hasInteractiveSelection
                ? selectedCompKeys!.has(key)
                : comp.isEnabled === true
              return (
                <CompCard
                  key={key}
                  comp={comp}
                  index={originalIndex}
                  isExpanded={expandedComps.has(key)}
                  onToggle={() => toggleExpand(key)}
                  subjectSubdivision={subjectSubdivision}
                  isSelectedForArv={isSelected}
                  onToggleArv={onToggleComp ? () => onToggleComp(key) : undefined}
                />
              )
            })}
          </div>
        )}
      </div>

    </div>
  )
}
