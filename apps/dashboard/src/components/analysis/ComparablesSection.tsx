'use client'

import { useState, useEffect, useMemo, useCallback } from 'react'
import { SlidersHorizontal, RotateCcw, Loader2, LayoutGrid, List, ArrowUpDown, Bell, Check } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { CopyButton } from '@/components/ui/copy-button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { subdivisionsMatch } from '@flowstate-api/shared'
import type { CompsData, CompItem, SubjectData } from './shared-types'
import { getCompKey } from './format-helpers'
import { CompGridCard } from './CompGridCard'
import { RuleMatchDetails } from './RuleMatchDetails'
import { generateCompFeedbackReport, type FeedbackContext, type FeedbackKind } from '@/lib/comp-feedback'
import { submitReportFeedback } from '@/app/(dashboard)/dashboard/batch/actions'
import { assignCompTier } from '@/app/(dashboard)/dashboard/analyze/actions'
import { reloadForStaleAction } from '@/lib/server-action'
import { CdarvStatusChip } from './CdarvStatusChip'

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
  /** Reviewer tier pin — feeds the client-side ARV recalc alongside local persistence */
  onPinTier?: (compId: string, tier: 'arv' | 'as_is' | null) => void
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
  /** Rules/fallback context for the "Notify" comp-selection feedback report */
  feedbackContext?: FeedbackContext | null
  /** Called after a feedback stamp is submitted — batch review uses it to advance */
  onFeedbackSubmitted?: (type: 'validate' | 'improve') => void
}

type SortOption = 'default' | 'subdivision' | 'neighborhood' | 'distance' | 'price' | 'psf'

const SORT_LABELS: Record<SortOption, string> = {
  default: 'Default',
  subdivision: 'Subdivision',
  neighborhood: 'Neighborhood',
  distance: 'Distance',
  price: 'Price',
  psf: '$/Sqft',
}

/** Neighborhood match by normalized name OR provider code (mirrors server-side neighborhoodsMatch) */
function neighborhoodsMatchClient(comp: CompItem, subject: SubjectData | null | undefined): boolean {
  const norm = (s?: string | null) => s?.trim().toLowerCase() || null
  const a = norm(comp.neighborhoodName)
  const b = norm(subject?.neighborhoodName)
  if (a && b && a === b) return true
  return comp.neighborhoodCode != null && subject?.neighborhoodCode != null && comp.neighborhoodCode === subject.neighborhoodCode
}

export function ComparablesSection({
  comps,
  subjectSubdivision,
  subject,
  selectedCompKeys,
  isManual = false,
  recalculatedArv,
  onToggleComp,
  onPinTier,
  onReset,
  highlightedCompKey,
  isAnalyzing = false,
  onRunAiAnalysis,
  onUndoAiSelection,
  onCompClick,
  onCompHover,
  feedbackContext,
  onFeedbackSubmitted,
}: ComparablesSectionProps) {
  const [expandedComps, setExpandedComps] = useState<Set<string>>(new Set())
  const [excludedOpen, setExcludedOpen] = useState(false)
  const [sortBy, setSortBy] = useState<SortOption>('default')
  const [tierFilter, setTierFilter] = useState<'all' | 'arv' | 'market' | 'floor'>('all')
  const [sortDesc, setSortDesc] = useState(true)
  const [notifyOpen, setNotifyOpen] = useState(false)
  const [notifyNotes, setNotifyNotes] = useState('')
  const [notifySubmitting, setNotifySubmitting] = useState<FeedbackKind | null>(null)
  const [notifySaveError, setNotifySaveError] = useState<string | null>(null)
  // Reviewer-pinned comp tiers — compId → 'arv'|'as_is'. Optimistic local
  // state; persisted via PUT /v1/analyze/jobs/:jobId/comp-tier.
  const [tierPins, setTierPins] = useState<Record<string, 'arv' | 'as_is'>>({})
  const [tierPending, setTierPending] = useState<Set<string>>(new Set())

  const jobId = feedbackContext?.jobId ?? null
  // Stable callback — memoized cards take it as a prop, so identity matters.
  const pinTier = useCallback(async (comp: CompItem, tier: 'arv' | 'as_is' | null) => {
    const compId = comp.id
    if (!jobId || !compId) return
    setTierPending((p) => new Set(p).add(compId))
    setTierPins((p) => {
      const next = { ...p }
      if (tier) next[compId] = tier
      else delete next[compId]
      return next
    })
    onPinTier?.(compId, tier)
    const res = await assignCompTier(jobId, compId, tier)
    if (!res.success) {
      setTierPins((p) => {
        const next = { ...p }
        if (comp.userTier) next[compId] = comp.userTier
        else delete next[compId]
        return next
      })
      toast.error(res.error ?? 'Could not save the tier assignment')
    }
    setTierPending((p) => { const n = new Set(p); n.delete(compId); return n })
  }, [jobId])
  // Server-rendered overrides merge with optimistic pins — pins win until
  // the next load confirms them.
  const compWithTier = (comp: CompItem): CompItem => {
    const pinned = comp.id ? tierPins[comp.id] : undefined
    return pinned ? { ...comp, userTier: pinned } : comp
  }

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
  const hasInteractiveSelection = !!selectedCompKeys

  // Sorted items preserving original index for stable keys & map marker numbering.
  // Stacked ordering: selected block pinned first → geo grouping (subdivision/
  // neighborhood modes) → appraisal-rule closeness (constant across every sort)
  // → directional key (price under geo modes, own key for distance/price/psf).
  // Evidence-tier filter — ARV (after_renovation) / Median (transitional)
  // / Investor (as_is). Drives the card list, not the map colors.
  const tierOf = (c: CompItem) =>
    c.classification?.type === 'after_renovation' ? 'arv'
      : c.classification?.type === 'as_is' ? 'floor'
      : 'market'
  const filteredCompItems = useMemo(
    () => tierFilter === 'all' ? compItems : compItems.filter((c) => tierOf(c) === tierFilter),
    [compItems, tierFilter]
  )

  const sortedItems = useMemo(() => {
    const indexed = filteredCompItems
      .map((comp, i) => ({ comp, originalIndex: compItems.indexOf(comp) }))
    const isSel = (c: CompItem, i: number) =>
      hasInteractiveSelection ? selectedCompKeys!.has(getCompKey(c, i)) : (c.compGroup === 'arv' || c.isEnabled === true)
    const subdivMatch = (c: CompItem) =>
      subjectSubdivision && c.subdivision && subdivisionsMatch(subjectSubdivision, c.subdivision) ? 1 : 0

    if (sortBy === 'default') {
      // What the rules selected: selected block first, then enabled, then
      // excluded; subdivision matches before non-matches; nearest first
      return [...indexed].sort((a, b) => {
        const ra = isSel(a.comp, a.originalIndex) ? 0 : a.comp.isEnabled ? 1 : 2
        const rb = isSel(b.comp, b.originalIndex) ? 0 : b.comp.isEnabled ? 1 : 2
        if (ra !== rb) return ra - rb
        const aMatch = subdivMatch(a.comp)
        const bMatch = subdivMatch(b.comp)
        if (aMatch !== bMatch) return bMatch - aMatch
        return (a.comp.distanceMiles ?? 999) - (b.comp.distanceMiles ?? 999)
      })
    }

    const dir = sortDesc ? -1 : 1

    const geoMatch = (c: CompItem): number => {
      if (sortBy === 'subdivision') return subdivMatch(c)
      if (sortBy === 'neighborhood') return neighborhoodsMatchClient(c, subject) ? 1 : 0
      return 0
    }
    const numKey = (c: CompItem): number => {
      switch (sortBy) {
        case 'distance': return c.distanceMiles ?? 999
        case 'psf': return c.pricePerSqft ?? 0
        // subdivision & neighborhood ascend/descend by price
        default: return c.salePrice ?? 0
      }
    }

    return [...indexed].sort((a, b) => {
      const sa = isSel(a.comp, a.originalIndex) ? 0 : 1
      const sb = isSel(b.comp, b.originalIndex) ? 0 : 1
      if (sa !== sb) return sa - sb
      const ga = geoMatch(a.comp), gb = geoMatch(b.comp)
      if (ga !== gb) return gb - ga
      return dir * (numKey(a.comp) - numKey(b.comp)) || (a.originalIndex - b.originalIndex)
    })
  }, [filteredCompItems, compItems, sortBy, sortDesc, subjectSubdivision, subject, selectedCompKeys, hasInteractiveSelection])

  // Functional update keeps the identity stable for memoized cards.
  const toggleExpand = useCallback((key: string) => {
    setExpandedComps((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  // Group comps based on selection mode
  const arvComps = hasInteractiveSelection
    ? filteredCompItems.filter((c) => selectedCompKeys!.has(getCompKey(c, compItems.indexOf(c))))
    : filteredCompItems.filter((c) => c.isEnabled === true)
  const excludedComps = hasInteractiveSelection
    ? filteredCompItems.filter((c) => !selectedCompKeys!.has(getCompKey(c, compItems.indexOf(c))))
    : filteredCompItems.filter((c) => c.isEnabled !== true)
  // If no comps are selected (e.g. streaming, before evaluation), show all in main section
  const showAllFlat = arvComps.length === 0 && excludedComps.length > 0

  const selectedCount = arvComps.length

  // Notify — submit the feedback ticket (stored on the report for the agent),
  // stamp it, then advance to the next property in batch-review mode
  const submitNotify = async (kind: FeedbackKind) => {
    if (notifySubmitting) return
    setNotifySubmitting(kind)
    setNotifySaveError(null)
    const report = generateCompFeedbackReport({
      subject,
      comps: compItems,
      userSelectedKeys: selectedCompKeys ?? new Set(),
      context: feedbackContext ?? {},
      userNotes: notifyNotes,
      kind,
    })

    const jobId = feedbackContext?.jobId
    if (jobId) {
      try {
        const res = await submitReportFeedback(jobId, kind, notifyNotes, report)
        if (!res.success) {
          setNotifySaveError(res.error ?? 'Submission failed')
          setNotifySubmitting(null)
          return
        }
      } catch (err) {
        if (reloadForStaleAction(err)) return
        setNotifySaveError('Submission failed')
        setNotifySubmitting(null)
        return
      }
    }

    setNotifySubmitting(null)
    setNotifyOpen(false)
    setNotifyNotes('')
    toast.success(kind === 'validate' ? 'Validated — report stamped' : 'Submitted — feedback ticket saved')
    onFeedbackSubmitted?.(kind === 'validate' ? 'validate' : 'improve')
  }

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
            {/* Notify — comp-selection feedback report (always available) */}
            <button
              type="button"
              onClick={() => { setNotifyNotes(''); setNotifySaveError(null); setNotifyOpen(true) }}
              className="flex items-center gap-1 text-caption text-foreground-tertiary hover:text-foreground font-medium transition-colors no-print"
              title="Generate a comp-selection feedback report for devin.ai"
            >
              <Bell className="w-3 h-3" />
              Notify
            </button>

          </div>
        </div>

        {/* Row 2: Evidence-tier filter + sort controls */}
        <div className="flex items-center gap-1 no-print flex-wrap">
          {/* Tier filter — ARV evidence / median / investor floor */}
          {(['all', 'arv', 'market', 'floor'] as const).map((t) => {
            const labels = { all: 'All', arv: 'ARV', market: 'Median', floor: 'Investor' }
            const colors = {
              all: tierFilter === t ? 'bg-secondary text-foreground font-medium' : 'text-foreground-tertiary hover:text-foreground hover:bg-secondary',
              arv: tierFilter === t ? 'bg-brand/15 text-brand font-medium' : 'text-foreground-tertiary hover:text-foreground hover:bg-secondary',
              market: tierFilter === t ? 'bg-orange-500/15 text-orange-500 font-medium' : 'text-foreground-tertiary hover:text-foreground hover:bg-secondary',
              floor: tierFilter === t ? 'bg-red-500/15 text-red-400 font-medium' : 'text-foreground-tertiary hover:text-foreground hover:bg-secondary',
            }
            return (
              <button
                key={t}
                type="button"
                onClick={() => { setTierFilter(t); if (t !== 'all') { setSortBy('price'); setSortDesc(true) } else { setSortBy('default') } }}
                className={cn('text-[10px] px-2 py-0.5 rounded transition-colors', colors[t])}
              >
                {labels[t]}
              </button>
            )
          })}
        </div>

        {/* CDARV status — observational only; never gates evaluation */}
        {feedbackContext?.jobId && <CdarvStatusChip jobId={feedbackContext.jobId} />}

        {/* Manual mode banner */}
        {isManual && (
          <div className="px-3 py-2 bg-amber-500/8 border border-amber-500/20 flex items-center justify-between gap-3 no-print">
            <div className="flex items-center gap-2">
              <SlidersHorizontal className="w-3.5 h-3.5 text-amber-600 flex-shrink-0" />
              <span className="text-caption text-amber-700 dark:text-amber-400">
                Manual · {selectedCount} comp{selectedCount !== 1 ? 's' : ''} · ARV: <span className="font-semibold tabular-nums">~${recalculatedArv?.toLocaleString() ?? '—'}</span>
              </span>
            </div>
            <div className="flex items-center gap-3">
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
                    <td className="py-1.5 pr-4 font-medium">{comp.address}<CopyButton text={comp.address ?? ''} title="Copy address" className="ml-1" /><RuleMatchDetails comp={comp} /></td>
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
                    <td className="py-1 pr-4">{comp.address}<CopyButton text={comp.address ?? ''} title="Copy address" className="ml-1" /><RuleMatchDetails comp={comp} /></td>
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

      {/* All comps — grid only */}
      <div className="print:hidden">
        {(
          <div className="comps-grid">
            {sortedItems.map(({ comp, originalIndex }) => {
              const key = getCompKey(comp, originalIndex)
              const isSelected = hasInteractiveSelection
                ? selectedCompKeys!.has(key)
                : comp.isEnabled === true
              return (
                <CompGridCard
                  key={key}
                  comp={compWithTier(comp)}
                  index={originalIndex}
                  subject={subject}
                  isSelectedForArv={isSelected}
                  onToggleArv={onToggleComp}
                  onAssignTier={jobId ? pinTier : undefined}
                  tierPending={comp.id ? tierPending.has(comp.id) : false}
                  onCompClick={onCompClick}
                  onHover={onCompHover}
                  isHighlighted={highlightedCompKey === key}
                />
              )
            })}
          </div>
        )}
      </div>

      {/* Notify dialog — notes → submits a feedback ticket, then advances */}
      <Dialog open={notifyOpen} onOpenChange={setNotifyOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Review this report</DialogTitle>
            <DialogDescription>
              Stamp this report as right or flag it for a fix. It saves to the
              report&apos;s feedback trail — revisit it anytime.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <textarea
              autoFocus
              value={notifyNotes}
              onChange={(e) => setNotifyNotes(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  submitNotify('improve')
                }
              }}
              placeholder="Notes for later, e.g. '10321 Briarcliff is the right comp, same street renovated sale'&#10;&#10;Enter = Flag for improvement · Shift+Enter = new line"
              rows={4}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-body-sm text-foreground placeholder:text-foreground-tertiary focus:outline-none focus:ring-1 focus:ring-primary resize-y"
            />
            {notifySaveError && (
              <p className="text-xs text-red-400">{notifySaveError}</p>
            )}
            <div className="flex items-center justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => submitNotify('validate')}
                disabled={notifySubmitting !== null}
                className="text-emerald-600 border-emerald-500/30 hover:bg-emerald-500/10"
              >
                {notifySubmitting === 'validate' ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Check className="w-3.5 h-3.5 mr-1.5" />}
                Validate
              </Button>
              <Button
                size="sm"
                onClick={() => submitNotify('improve')}
                disabled={notifySubmitting !== null}
                className="bg-amber-600 hover:bg-amber-700 text-white"
              >
                {notifySubmitting === 'improve' ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Bell className="w-3.5 h-3.5 mr-1.5" />}
                Flag for improvement
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

    </div>
  )
}
