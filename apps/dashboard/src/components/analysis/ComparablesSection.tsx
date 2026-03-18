'use client'

import { useState } from 'react'
import { Home, SlidersHorizontal, RotateCcw, ChevronDown, MapPin } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import type { CompsData, CompItem, SubjectData } from './shared-types'
import { getCompKey } from './format-helpers'
import { CompCard } from './CompCard'
import { NeighbourhoodMap } from './NeighbourhoodMap'

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
}: ComparablesSectionProps) {
  const [expandedComps, setExpandedComps] = useState<Set<string>>(new Set())
  const [excludedOpen, setExcludedOpen] = useState(false)
  const [mapOpen, setMapOpen] = useState(false)
  const compItems = comps.items || []

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
    : compItems.filter((c) => c.isEnabled !== false)
  const excludedComps = hasInteractiveSelection
    ? compItems.filter((_c, i) => !selectedCompKeys!.has(getCompKey(_c, i)))
    : compItems.filter((c) => c.isEnabled === false)

  const selectedCount = arvComps.length

  // Calculate median and avg from SELECTED comps only
  const selectedPrices = arvComps
    .map((c) => c.adjustedPrice ?? c.salePrice)
    .filter((p): p is number => p != null && p > 0)
    .sort((a, b) => a - b)
  const selectedMedian = selectedPrices.length > 0
    ? selectedPrices.length % 2 === 0
      ? Math.round((selectedPrices[selectedPrices.length / 2 - 1] + selectedPrices[selectedPrices.length / 2]) / 2)
      : selectedPrices[Math.floor(selectedPrices.length / 2)]
    : null
  const selectedPsfs = arvComps
    .filter((c) => c.pricePerSqft != null && c.pricePerSqft > 0)
    .map((c) => c.pricePerSqft!)
  const selectedAvgPsf = selectedPsfs.length > 0
    ? Math.round(selectedPsfs.reduce((s, p) => s + p, 0) / selectedPsfs.length)
    : null

  return (
    <div>
      <div className="mb-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
              <Home className="w-4 h-4 text-primary" />
            </div>
            <div>
              <h3 className="text-body font-semibold">Comparables ({comps.count || compItems.length})</h3>
              <p className="text-caption text-foreground-tertiary mt-0.5">
                {selectedCount} selected for ARV
                {excludedComps.length > 0 && ` · ${excludedComps.length} excluded`}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {selectedMedian != null && (
              <span className="text-caption text-foreground-tertiary hidden md:block">
                Median: <span className="font-medium text-foreground">${selectedMedian.toLocaleString()}</span>
              </span>
            )}
            {selectedAvgPsf != null && (
              <Badge variant="outline" className="text-caption-sm bg-background/50 hidden md:flex">
                Avg: ${selectedAvgPsf}/sqft
              </Badge>
            )}
            {subject?.latitude && subject?.longitude && (
              <button
                type="button"
                onClick={() => setMapOpen(true)}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-caption text-foreground-secondary hover:text-foreground hover:bg-secondary transition-colors border border-border no-print"
              >
                <MapPin className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Map</span>
              </button>
            )}
          </div>
        </div>

        {/* Manual mode banner */}
        {isManual && (
          <div className="mt-3 px-3.5 py-2.5 rounded-xl bg-amber-500/8 border border-amber-500/20 flex items-center justify-between gap-3 no-print">
            <div className="flex items-center gap-2">
              <SlidersHorizontal className="w-3.5 h-3.5 text-amber-600 flex-shrink-0" />
              <span className="text-caption text-amber-700 dark:text-amber-400">
                Manual selection · {selectedCount} comp{selectedCount !== 1 ? 's' : ''} · ARV: <span className="font-semibold">~${recalculatedArv?.toLocaleString() ?? '—'}</span>
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
                    <td className="py-1.5 pr-4 font-medium">{comp.address}</td>
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
                    <td className="py-1 pr-4">{comp.address}</td>
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

      {/* Interactive comp cards */}
      <div className="space-y-3 print:hidden">
        {arvComps.length > 0 && (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <span className="text-caption font-semibold text-emerald-600 uppercase tracking-wider">Selected for ARV</span>
              <div className="flex-1 h-px bg-emerald-500/20" />
              <span className="text-caption text-foreground-tertiary">{arvComps.length} comp{arvComps.length !== 1 ? 's' : ''}</span>
            </div>
            {hasInteractiveSelection
              ? compItems.map((comp, i) => {
                  const key = getCompKey(comp, i)
                  if (!selectedCompKeys!.has(key)) return null
                  return (
                    <CompCard
                      key={key}
                      comp={comp}
                      index={i}
                      isExpanded={expandedComps.has(key)}
                      onToggle={() => toggleExpand(key)}
                      subject={subject}
                      subjectSubdivision={subjectSubdivision}
                      isSelectedForArv={true}
                      onToggleArv={() => onToggleComp?.(key)}
                    />
                  )
                })
              : arvComps.map((comp) => {
                  const originalIndex = compItems.indexOf(comp)
                  return (
                    <CompCard
                      key={comp.address || originalIndex}
                      comp={comp}
                      index={originalIndex}
                      subject={subject}
                      subjectSubdivision={subjectSubdivision}
                    />
                  )
                })
            }
          </div>
        )}

        {excludedComps.length > 0 && (
          <div className="space-y-3">
            <button
              type="button"
              onClick={() => setExcludedOpen((v) => !v)}
              className="flex items-center gap-2 w-full group"
            >
              <span className="text-caption font-semibold text-foreground-tertiary uppercase tracking-wider">Excluded</span>
              <div className="flex-1 h-px bg-border/40" />
              <span className="text-caption text-foreground-tertiary">{excludedComps.length} comp{excludedComps.length !== 1 ? 's' : ''}</span>
              {hasInteractiveSelection && (
                <span className="text-caption-sm text-foreground-tertiary italic">· check to include</span>
              )}
              <ChevronDown className={`w-3.5 h-3.5 text-foreground-tertiary transition-transform ${excludedOpen ? 'rotate-180' : ''}`} />
            </button>
            {excludedOpen && (
              <div className="space-y-3">
                {hasInteractiveSelection
                  ? compItems.map((comp, i) => {
                      const key = getCompKey(comp, i)
                      if (selectedCompKeys!.has(key)) return null
                      return (
                        <CompCard
                          key={key}
                          comp={comp}
                          index={i}
                          isExpanded={expandedComps.has(key)}
                          onToggle={() => toggleExpand(key)}
                          subject={subject}
                      subjectSubdivision={subjectSubdivision}
                          isSelectedForArv={false}
                          onToggleArv={() => onToggleComp?.(key)}
                        />
                      )
                    })
                  : excludedComps.map((comp) => {
                      const originalIndex = compItems.indexOf(comp)
                      return (
                        <CompCard
                          key={comp.address || originalIndex}
                          comp={comp}
                          index={originalIndex}
                          subject={subject}
                      subjectSubdivision={subjectSubdivision}
                        />
                      )
                    })
                }
              </div>
            )}
          </div>
        )}
      </div>

      {/* Map Dialog */}
      <Dialog open={mapOpen} onOpenChange={setMapOpen}>
        <DialogContent className="max-w-4xl p-0 overflow-hidden">
          <DialogHeader className="px-5 pt-5 pb-3">
            <DialogTitle className="text-body font-semibold">Subject & Comparables Map</DialogTitle>
          </DialogHeader>
          <div className="px-5 pb-5">
            <NeighbourhoodMap subject={subject} comps={comps} />
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
