'use client'

import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { SlidersHorizontal, RotateCcw } from 'lucide-react'
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
import { getCompKey, scopeLabel, scopeRank } from './format-helpers'
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
  /** Highlights this comp key (map marker hover / click) */
  highlightedCompKey?: string | null
  /** Called when a comp card is clicked (for comparison dialog) */
  onCompClick?: (comp: CompItem) => void
  /** Called when a comp card is hovered (for map marker sync) */
  onCompHover?: (key: string | null) => void
  /** Rules/fallback context for the "Report" comp-selection feedback ticket */
  feedbackContext?: FeedbackContext | null
  /** Called after a feedback stamp is submitted — batch review uses it to advance */
  onFeedbackSubmitted?: (type: 'validate' | 'improve') => void
  /** The selection stats for the tier being viewed · the page draws them (the subject card's foot) */
  onSelectionStats?: (stats: CompSelectionStats) => void
}

/** "5 selected · 25 excluded · $241/sf avg · $320k to $410k", as numbers */
export interface CompSelectionStats {
  selected: number
  excluded: number
  avgPsf: number | null
  priceMin: number | null
  priceMax: number | null
}

/** 'default' = what the rules selected · 'price' = a tier, highest sale first */
type SortOption = 'default' | 'price'

type Tier = 'all' | 'arv' | 'market' | 'floor'
/** Thin line between pills · the same mark the valuation box uses */
const DIVIDER = 'w-px h-3 bg-border mx-1 flex-shrink-0'

/** Tier words · shared by the pills and the empty state */
const TIER_LABEL: Record<Tier, string> = { all: 'All', arv: 'ARV', market: 'Median', floor: 'Investor' }

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
  onCompClick,
  onCompHover,
  feedbackContext,
  onFeedbackSubmitted,
  onSelectionStats,
}: ComparablesSectionProps) {
  const [sortBy, setSortBy] = useState<SortOption>('default')
  const [tierFilter, setTierFilter] = useState<Tier>('all')
  const [reportOpen, setReportOpen] = useState(false)
  const [reportNotes, setReportNotes] = useState('')
  const [reportSubmitting, setReportSubmitting] = useState<FeedbackKind | null>(null)
  const [reportSaveError, setReportSaveError] = useState<string | null>(null)
  // Tier switches swap a tall grid for a short one (or an empty state). The
  // grid keeps a minimum height so the page never collapses and yanks the
  // reader back up to the subject card.
  const gridRef = useRef<HTMLDivElement>(null)
  const tierRowRef = useRef<HTMLDivElement>(null)
  const tierBarRef = useRef<HTMLDivElement>(null)
  // The bar pins right under whatever is pinned above it (the subject card,
  // or the valuation box on the single-column page) · its top follows that
  // element's height, which changes with pane width and wrapping.
  const [stickyTop, setStickyTop] = useState(0)
  useEffect(() => {
    const bar = tierBarRef.current
    if (!bar) return
    const hero = bar.closest('.props-pane, body')?.querySelector<HTMLElement>('[data-pane-sticky]')
    if (!hero) return
    const measure = () => setStickyTop(Math.round((parseFloat(getComputedStyle(hero).top) || 0) + hero.offsetHeight))
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(hero)
    return () => ro.disconnect()
  }, [])
  const [lockedGridHeight, setLockedGridHeight] = useState<number | null>(null)
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

  // A new comp list (new analysis, streaming update) releases the height lock.
  useEffect(() => { setLockedGridHeight(null) }, [comps.items])

  const selectTier = (tier: Tier) => {
    if (tier === tierFilter) return
    // Hold the grid down to the bottom of the screen: the scroll position
    // stays valid, and a short tier leaves at most one screen of space.
    const top = gridRef.current?.getBoundingClientRect().top
    if (top != null) setLockedGridHeight(Math.max(0, Math.ceil(window.innerHeight - top)))
    setTierFilter(tier)
    setSortBy(tier === 'all' ? 'default' : 'price')
    // Stay with the comp list after the grid re-renders.
    requestAnimationFrame(() => tierRowRef.current?.scrollIntoView({ block: 'nearest' }))
  }

  const compItems = comps.items || []
  const hasInteractiveSelection = !!selectedCompKeys

  // Sorted items keep their original index for stable keys & map marker numbering.
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
    const geoRank = (c: CompItem) => scopeRank(scopeLabel(c, subject))

    // How far a comp sits from the rules: failed rules first (fewer is
    // closer), then how far it misses on size, year and sale age.
    const failedRules = (c: CompItem) =>
      (c.appraisalRules?.filters ?? []).filter((f) => (f.status ?? (f.passed ? 'passed' : 'failed')) === 'failed').length
    const miss = (c: CompItem) => {
      const sf = c.squareFeet != null && subject?.squareFeet ? Math.abs(c.squareFeet - subject.squareFeet) / subject.squareFeet : 1
      const yr = c.yearBuilt != null && subject?.yearBuilt ? Math.abs(c.yearBuilt - subject.yearBuilt) / 50 : 1
      return sf + yr + (c.distanceMiles ?? 5) / 5
    }
    // The server's picks lead: the anchor, then the other drivers, then any
    // other checked comp, then comps that pass the rules, then the rest.
    const pickRank = (c: CompItem, i: number) =>
      c.bRole === 'anchor' ? 0 : c.bRole === 'driver' ? 1 : isSel(c, i) ? 2 : c.bRole === 'pool' || (c.bRole == null && c.isEnabled === true) ? 3 : 4

    if (sortBy === 'default') {
      // Server picks first, then every other comp from closest to the rules
      // to furthest. Tighter geography breaks ties.
      return [...indexed].sort((a, b) => {
        const pa = pickRank(a.comp, a.originalIndex), pb = pickRank(b.comp, b.originalIndex)
        if (pa !== pb) return pa - pb
        const fa = failedRules(a.comp), fb = failedRules(b.comp)
        if (fa !== fb) return fa - fb
        const ga = geoRank(a.comp), gb = geoRank(b.comp)
        if (ga !== gb) return ga - gb
        const aMatch = subdivMatch(a.comp)
        const bMatch = subdivMatch(b.comp)
        if (aMatch !== bMatch) return bMatch - aMatch
        return (miss(a.comp) - miss(b.comp)) || ((a.comp.distanceMiles ?? 999) - (b.comp.distanceMiles ?? 999))
      })
    }

    // A tier view: tract matches first, then highest sale · no selected-first pinning.
    return [...indexed].sort((a, b) =>
      (geoRank(a.comp) - geoRank(b.comp))
      || ((b.comp.salePrice ?? 0) - (a.comp.salePrice ?? 0))
      || (a.originalIndex - b.originalIndex))
  }, [filteredCompItems, compItems, sortBy, subjectSubdivision, subject, selectedCompKeys, hasInteractiveSelection])

  // Group comps based on selection mode
  const arvComps = hasInteractiveSelection
    ? filteredCompItems.filter((c) => selectedCompKeys!.has(getCompKey(c, compItems.indexOf(c))))
    : filteredCompItems.filter((c) => c.isEnabled === true)
  const excludedComps = hasInteractiveSelection
    ? filteredCompItems.filter((c) => !selectedCompKeys!.has(getCompKey(c, compItems.indexOf(c))))
    : filteredCompItems.filter((c) => c.isEnabled !== true)
  const selectedCount = arvComps.length

  // Report — submit the feedback ticket (stored on the report for the agent),
  // stamp it, then advance to the next property in batch-review mode
  const submitReport = async (kind: FeedbackKind) => {
    if (reportSubmitting) return
    setReportSubmitting(kind)
    setReportSaveError(null)
    const report = generateCompFeedbackReport({
      subject,
      comps: compItems,
      userSelectedKeys: selectedCompKeys ?? new Set(),
      context: feedbackContext ?? {},
      userNotes: reportNotes,
      kind,
    })

    // Shown inline and as a toast, so a failed save is never silent.
    const fail = (message: string) => {
      setReportSaveError(message)
      setReportSubmitting(null)
      toast.error(message)
    }

    const jobId = feedbackContext?.jobId
    if (jobId) {
      try {
        const res = await submitReportFeedback(jobId, kind, reportNotes, report)
        if (!res.success) return fail(res.error ?? 'Could not save the review. Try again.')
      } catch (err) {
        if (reloadForStaleAction(err)) return
        return fail('Could not save the review. Try again.')
      }
    }

    setReportSubmitting(null)
    setReportOpen(false)
    setReportNotes('')
    toast.success(kind === 'validate' ? 'Report validated' : 'Flagged for improvement')
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

  // Tell the page the stats for the tier on screen (it draws them in the subject card)
  const excludedCount = excludedComps.length
  useEffect(() => {
    onSelectionStats?.({ selected: selectedCount, excluded: excludedCount, avgPsf, priceMin, priceMax })
  }, [onSelectionStats, selectedCount, excludedCount, avgPsf, priceMin, priceMax])

  return (
    <div>
      {/* Tiers stay pinned under the valuation box while the list scrolls,
          so the selection count and the tier switches are always in reach. */}
      <div
        ref={tierBarRef}
        data-comps-anchor
        className="sticky z-[9] bg-background pb-2 mb-2 space-y-2 border-b border-border/60"
        style={{ top: stickyTop }}
      >
        {/* Evidence tiers · ARV evidence / median / investor floor */}
        <div ref={tierRowRef} className="flex items-center gap-1 no-print flex-wrap scroll-mt-24">
          {/* A thin line between every tier */}
          {(['all', 'arv', 'market'] as const).map((t, i) => (
            <span key={t} className="inline-flex items-center gap-1">
              {i > 0 && <span className={DIVIDER} aria-hidden />}
              <TierPill tier={t} active={tierFilter === t} onSelect={selectTier} />
            </span>
          ))}
          {/* Investor and Report travel together · they never wrap apart */}
          <span className="inline-flex items-center gap-1">
            <span className={DIVIDER} aria-hidden />
            <TierPill tier="floor" active={tierFilter === 'floor'} onSelect={selectTier} />
            {jobId && (
              <>
                <span className={DIVIDER} aria-hidden />
                {/* Review · stamp this report or flag it; saved on the report */}
                <button
                  type="button"
                  onClick={() => { setReportNotes(''); setReportSaveError(null); setReportOpen(true) }}
                  className="text-[11px] px-2 py-0.5 rounded text-foreground-tertiary hover:text-foreground hover:bg-secondary transition-colors"
                  title="Validate this report or flag it for improvement"
                >
                  Report
                </button>
              </>
            )}
          </span>
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

      {/* All comps · grid only. The wrapper keeps a minimum height across tier
          switches so an empty or short tier never collapses the page. */}
      <div
        ref={gridRef}
        className="print:hidden"
        style={lockedGridHeight ? { minHeight: lockedGridHeight } : undefined}
      >
        {sortedItems.length === 0 && tierFilter !== 'all' && (
          <div className="border border-dashed border-border rounded-sm flex flex-col items-center justify-center gap-2 min-h-[16rem] px-4 text-center">
            <p className="text-body-sm text-foreground-secondary">No {TIER_LABEL[tierFilter]} comps in this report</p>
            <button
              type="button"
              onClick={() => selectTier('all')}
              className="text-[11px] font-medium text-foreground-tertiary underline underline-offset-2 hover:text-foreground transition-colors"
            >
              Show all
            </button>
          </div>
        )}
        {sortedItems.length > 0 && (
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
                  onCompClick={onCompClick}
                  onHover={onCompHover}
                  isHighlighted={highlightedCompKey === key}
                />
              )
            })}
          </div>
        )}
      </div>

      {/* Report dialog · notes, then Validate or Flag. Stays open while saving. */}
      <Dialog open={reportOpen} onOpenChange={(next) => { if (!reportSubmitting) setReportOpen(next) }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Review this report</DialogTitle>
            <DialogDescription>
              Validate this report or flag it for improvement. Your notes are saved with the report.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <textarea
              autoFocus
              aria-label="Notes"
              value={reportNotes}
              onChange={(e) => setReportNotes(e.target.value)}
              disabled={reportSubmitting !== null}
              rows={4}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-body-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary resize-y disabled:opacity-60"
            />
            {reportSaveError && (
              <p role="alert" className="text-body-sm text-red-600 dark:text-red-400">{reportSaveError}</p>
            )}
            <div className="flex items-center justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => submitReport('validate')}
                disabled={reportSubmitting !== null}
                className="text-emerald-600 dark:text-emerald-400 border-emerald-500/30 hover:bg-emerald-500/10"
              >
                {reportSubmitting === 'validate' ? 'Saving…' : 'Validate'}
              </Button>
              <Button
                size="sm"
                onClick={() => submitReport('improve')}
                disabled={reportSubmitting !== null}
                className="bg-amber-600 hover:bg-amber-700 text-white"
              >
                {reportSubmitting === 'improve' ? 'Saving…' : 'Flag for improvement'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

    </div>
  )
}

/** One evidence-tier pill · hues match the map pins and the card stamps */
function TierPill({ tier, active, onSelect }: { tier: Tier; active: boolean; onSelect: (tier: Tier) => void }) {
  const activeClass: Record<Tier, string> = {
    all: 'bg-secondary text-foreground font-medium',
    arv: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 font-medium',
    market: 'bg-orange-500/15 text-orange-500 font-medium',
    floor: 'bg-red-500/15 text-red-400 font-medium',
  }
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={() => onSelect(tier)}
      className={cn(
        'text-[11px] px-2 py-0.5 rounded transition-colors',
        active ? activeClass[tier] : 'text-foreground-tertiary hover:text-foreground hover:bg-secondary',
      )}
    >
      {TIER_LABEL[tier]}
    </button>
  )
}
