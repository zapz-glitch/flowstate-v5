'use client'

import { useState, useCallback, useEffect, useRef } from 'react'
import { useSetAtom } from 'jotai'
import { activeAnalysisAtom, analysisResultAtom, analysisStateAtom } from '@/atoms/analysis'
import { initialAnalysisState } from '@/types/analysis'
import Link from 'next/link'
import {
  Search,
  Play,
  Code,
  RefreshCw,
  StopCircle,
  ChevronDown,
  ChevronRight,
  DollarSign,
  SlidersHorizontal,
  ExternalLink,
  Sparkles,
  Globe,
  Loader2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { AddressAutocomplete } from '@/components/AddressAutocomplete'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet'
import { queueAnalysis, type CompsData, type AnalyzeData } from './actions'
import { cn } from '@/lib/utils'
import { useAnalysis } from '@/hooks/use-analysis'
import { useAnalysisEvaluation } from '@/hooks/use-analysis-evaluation'
import type { AnalysisStep } from '@/types/analysis'
import {
  SubjectPropertyCard,
  ValuationCard,
  ComparablesSection,
  RiskFloodCard,
  VisionAnalysisButton,
} from '@/components/analysis'
import {
  SubjectPropertySkeleton,
  ValuationSkeleton,
  ComparablesSkeleton,
  RiskFloodSkeleton,
} from '@/components/analysis/AnalysisSkeletons'
import { useEnrichmentSSE, type EnrichmentEvent } from '@/hooks/use-enrichment-sse'
import { AppraisalFilterEditor, type FilterState, type AdjustmentState } from '@/components/analysis/AppraisalFilterEditor'
import { SettingsPanel } from '@/components/report/SettingsPanel'
import { DownloadReportButton } from '@/components/report/DownloadReportButton'

// ─── Status Labels ───────────────────────────────────────────────────────────

const FRIENDLY_LABELS: Record<AnalysisStep, string> = {
  property_fetch: 'Analyzing subject property',
  appraisal_rules: 'Evaluating comparable sales',
  valuation: 'Calculating valuation',
  response_build: 'Finalizing results',
}

function getStatusLabel(step: AnalysisStep | null): string {
  if (!step) return 'Starting analysis'
  return FRIENDLY_LABELS[step] ?? 'Processing'
}

function TypewriterText({ text, typeSpeed = 30 }: { text: string; typeSpeed?: number }) {
  const [displayed, setDisplayed] = useState('')
  const [cursorVisible, setCursorVisible] = useState(true)
  const timerRef = useRef<NodeJS.Timeout | null>(null)

  useEffect(() => {
    setDisplayed('')
    const fullText = text + '...'
    let i = 0

    timerRef.current = setInterval(() => {
      i++
      if (i <= fullText.length) {
        setDisplayed(fullText.slice(0, i))
      } else {
        if (timerRef.current) clearInterval(timerRef.current)
      }
    }, typeSpeed)

    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [text, typeSpeed])

  useEffect(() => {
    const blink = setInterval(() => setCursorVisible((v) => !v), 530)
    return () => clearInterval(blink)
  }, [])

  return (
    <span>
      {displayed}
      <span className={cursorVisible ? 'opacity-100' : 'opacity-0'} aria-hidden>|</span>
    </span>
  )
}

// ─── Main Page ───────────────────────────────────────────────────────────────

export default function AnalyzePage() {
  const [address, setAddress] = useState('')
  const [skipCache, setSkipCache] = useState(false)
  const [llmAnalysis] = useState(false)
  const [marketData, setMarketData] = useState(false)
  const [arvThreshold, setArvThreshold] = useState(10)
  const [error, setError] = useState<string | null>(null)
  const [suggestedFilters, setSuggestedFilters] = useState<FilterState[] | null>(null)
  const [suggestedArvThreshold, setSuggestedArvThreshold] = useState<number | null>(null)
  const [pendingRetry, setPendingRetry] = useState(false)
  const [appraisalFilters, setAppraisalFilters] = useState<FilterState[]>([])
  const [appraisalAdjustments, setAppraisalAdjustments] = useState<AdjustmentState[]>([])

  const [showRawJson, setShowRawJson] = useState(false)
  const [searchExpanded, setSearchExpanded] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [durationMs, setDurationMs] = useState<number | null>(null)
  const [enrichmentStreamUrl, setEnrichmentStreamUrl] = useState<string | null>(null)
  const [enrichmentToken, setEnrichmentToken] = useState<string | null>(null)
  const [enrichmentStatus, setEnrichmentStatus] = useState<string | null>(null)

  // Global analysis context
  const {
    activeAnalysis,
    analysisState,
    analysisResult,
    displayData,
    clearAnalysis,
    cancelAnalysis,
  } = useAnalysis()

  const isRunning = isSubmitting || (activeAnalysis !== null && analysisState.status !== 'completed' && analysisState.status !== 'failed')
  const hasResult = analysisResult !== null
  const hasPartialData = displayData !== null

  // Atom setters (needed by enrichment handler and handleAnalyze)
  const setActiveAnalysis = useSetAtom(activeAnalysisAtom)
  const setAnalysisResult = useSetAtom(analysisResultAtom)
  const setAnalysisState = useSetAtom(analysisStateAtom)

  // SSE enrichment handler
  const handleEnrichmentEvent = useCallback((event: EnrichmentEvent) => {
    if (event.event === 'market_data_started' || event.event === 'llm_started') {
      setEnrichmentStatus(event.data.message || 'Processing...')
    } else if (event.event === 'llm_complete') {
      // If LLM produced an updated result with comp selection, replace entirely
      if (event.data.updatedResult) {
        setAnalysisResult(event.data.updatedResult as AnalyzeData)
        const selectedCount = event.data.llmAnalysis?.selectedForArv?.length ?? 0
        setEnrichmentStatus(`AI selected ${selectedCount} comps for ARV`)
        setTimeout(() => setEnrichmentStatus(null), 3000)
      } else if (event.data.rankings) {
        // Just enrich with reasoning (no selection change)
        setAnalysisResult((prev) => {
          if (!prev) return prev
          type Ranking = { compId: string; reasoning: string; score: number; keyFeatures: string[] }
          const rankings = event.data.rankings as Ranking[]
          const rankingMap = new Map(rankings.map((r) => [r.compId, r]))
          const updatedComps = { ...prev.comps }
          if (updatedComps.items) {
            updatedComps.items = updatedComps.items.map((comp) => {
              const match = rankingMap.get(comp.address || '')
              if (!match) return comp
              return { ...comp, selectionReason: match.reasoning, qualityScore: match.score, keyFeatures: match.keyFeatures }
            })
          }
          return { ...prev, comps: updatedComps } as AnalyzeData
        })
        setEnrichmentStatus(null)
      } else {
        setEnrichmentStatus(null)
      }
    } else if (event.event === 'market_data_complete') {
      // If re-evaluation produced an updated result, replace the current one
      if (event.data.updatedResult) {
        setAnalysisResult(event.data.updatedResult as AnalyzeData)
        setEnrichmentStatus('Market data applied — result updated')
        setTimeout(() => setEnrichmentStatus(null), 3000)
      } else {
        setEnrichmentStatus(null)
      }
    } else if (event.event === 'enrichment_done') {
      setEnrichmentStatus(null)
      setEnrichmentStreamUrl(null)
      setEnrichmentToken(null)
    } else if (event.event === 'error') {
      setEnrichmentStatus(`Error: ${event.data.message || 'Unknown error'}`)
      setTimeout(() => setEnrichmentStatus(null), 5000)
    }
  }, [setAnalysisResult])

  const { status: sseStatus } = useEnrichmentSSE({
    streamUrl: enrichmentStreamUrl,
    token: enrichmentToken,
    onEvent: handleEnrichmentEvent,
  })

  // Clear enrichment status if SSE connection fails or completes without events
  useEffect(() => {
    if (sseStatus === 'error') {
      setEnrichmentStatus('SSE connection failed — enrichment may still be processing')
      setTimeout(() => setEnrichmentStatus(null), 5000)
    } else if (sseStatus === 'done' && enrichmentStatus === 'Starting enrichment...') {
      setEnrichmentStatus(null)
    }
  }, [sseStatus, enrichmentStatus])

  // Unified evaluation hook: settings, comp override, display data, sticky bar
  const {
    settingsHook,
    recalcData,
    compOverride,
    handleToggleComp,
    handleResetComps,
    displayValuation,
    effectiveComps,
    isRecalculated,
    valuationCardRef,
    showStickyBar,
    settingsOpen,
    setSettingsOpen,
  } = useAnalysisEvaluation({
    data: analysisResult ?? null,
    stickyBarRootMargin: '-60px 0px 0px 0px',
  })

  // Analysis handler
  const handleAnalyze = useCallback(async () => {
    if (!address.trim()) return

    clearAnalysis()
    setError(null)
    setDurationMs(null)
    setEnrichmentStreamUrl(null)
    setEnrichmentToken(null)
    setEnrichmentStatus(null)
    setIsSubmitting(true)

    const t0 = Date.now()
    try {
      const overrides = appraisalFilters.length > 0 ? {
        filters: appraisalFilters,
        adjustments: appraisalAdjustments,
      } : undefined
      if (overrides) {
        console.log('[Analyze] Sending appraisal overrides:', overrides.filters?.length, 'filters,', overrides.adjustments?.length, 'adjustments')
        console.log('[Analyze] Filter states:', overrides.filters?.map(f => `${f.type}:${f.enabled}:${f.value}`).join(', '))
      }
      console.log('[Analyze] ARV threshold:', arvThreshold, '%')

      const response = await queueAnalysis({
        address: address.trim(),
        searchOptions: { radiusMiles: 1, maxComps: 10, monthsBack: 12 },
        skipCache,
        marketData: marketData ? { enabled: true } : undefined,
        llmAnalysis: llmAnalysis ? { enabled: true } : undefined,
        arvThresholdPercent: arvThreshold,
        appraisalOverrides: overrides,
      })

      if (response.success && response.result) {
        setDurationMs(Date.now() - t0)
        setActiveAnalysis({ jobId: response.jobId ?? '', address: address.trim() })
        setAnalysisResult(response.result as AnalyzeData)
        setAnalysisState({ ...initialAnalysisState, jobId: response.jobId ?? null, status: 'completed' })

        // Connect SSE if enrichment is pending
        if (response.enrichment) {
          setEnrichmentStreamUrl(response.enrichment.streamUrl)
          setEnrichmentToken(response.enrichment.token)
          setEnrichmentStatus('Starting enrichment...')
        }
      } else {
        setError(response.error || 'Analysis failed')
        if (response.suggestedFilters) {
          setSuggestedFilters(response.suggestedFilters as FilterState[])
        }
        if (response.suggestedArvThreshold) {
          // Store suggested threshold — applied when user clicks "Apply Suggestions"
          setSuggestedArvThreshold(response.suggestedArvThreshold)
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start analysis')
    } finally {
      setIsSubmitting(false)
    }
  }, [address, skipCache, marketData, llmAnalysis, arvThreshold, appraisalFilters, appraisalAdjustments, clearAnalysis, setActiveAnalysis, setAnalysisResult, setAnalysisState])

  // Auto-retry after "Apply & Retry" updates the filter state
  useEffect(() => {
    if (pendingRetry) {
      setPendingRetry(false)
      handleAnalyze()
    }
  }, [pendingRetry, handleAnalyze])

  const handleCancel = useCallback(() => {
    cancelAnalysis()
  }, [cancelAnalysis])

  const handleNewAnalysis = useCallback(() => {
    clearAnalysis()
    setSearchExpanded(true)
    setShowRawJson(false)
  }, [clearAnalysis])

  const isSearchCollapsed = (isRunning || hasResult || hasPartialData) && !searchExpanded

  return (
    <div className="space-y-6 playground-bg min-h-screen -m-6 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="space-y-2">
          <h1 className="text-heading-lg text-foreground tracking-tight">API Playground</h1>
          <p className="text-body text-foreground-tertiary">Test the Flowstate API with real property data</p>
        </div>
      </div>

      {/* Input Form — collapses to compact bar once running/results shown, click to expand */}
      {isSearchCollapsed ? (
        <div
          className="border border-border rounded-xl overflow-hidden cursor-pointer hover:ring-1 hover:ring-border/50 transition-all"
          onClick={() => setSearchExpanded(true)}
        >
          <div className="px-4 py-3 flex items-center gap-3">
            <div className="w-7 h-7 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0">
              <Search className="w-3.5 h-3.5 text-primary" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-body-sm text-foreground-secondary truncate">
                {activeAnalysis?.address || address || 'Search an address...'}
              </div>
              {isRunning && (
                <div className="text-xs text-primary mt-0.5" key={analysisState.currentStep}>
                  <TypewriterText text={getStatusLabel(analysisState.currentStep)} />
                </div>
              )}
            </div>
            {isRunning ? (
              <Button variant="destructive" size="sm" onClick={(e) => { e.stopPropagation(); handleCancel() }}>
                <StopCircle className="w-3.5 h-3.5 mr-1.5" />
                Cancel
              </Button>
            ) : (
              <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); setSearchExpanded(true) }}>
                <ChevronDown className="w-3.5 h-3.5" />
              </Button>
            )}
          </div>
        </div>
      ) : (
        <div className="relative z-20 border border-border rounded-xl">
          <div className="px-6 py-5 border-b border-border rounded-t-xl">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-primary/10 flex items-center justify-center">
                <Search className="w-4.5 h-4.5 text-primary" />
              </div>
              <div className="flex-1">
                <h2 className="text-body font-semibold">/v1/analyze</h2>
                <p className="text-caption text-foreground-tertiary">Property details, comparables, and valuation</p>
              </div>
              {(isRunning || hasResult || hasPartialData) && (
                <button
                  type="button"
                  onClick={() => setSearchExpanded(false)}
                  className="p-1.5 rounded-lg hover:bg-secondary transition-colors text-foreground-tertiary"
                >
                  <ChevronDown className="w-4 h-4 rotate-180" />
                </button>
              )}
            </div>
          </div>
          <div className="px-6 py-5 space-y-4">
            <div className="flex gap-3">
              <AddressAutocomplete
                value={address}
                onChange={setAddress}
                onSubmit={() => {
                  if (!isRunning && address.trim()) {
                    handleAnalyze()
                    setSearchExpanded(false)
                  }
                }}
                className="flex-1"
                autoFocus={searchExpanded}
                disabled={isRunning}
              />
              {isRunning ? (
                <Button variant="destructive" onClick={handleCancel}>
                  <StopCircle className="w-4 h-4 mr-2" />
                  Cancel
                </Button>
              ) : (
                <Button onClick={() => { handleAnalyze(); setSearchExpanded(false) }} disabled={isRunning || !address.trim()}>
                  <Play className="w-4 h-4 mr-2" />
                  Run
                </Button>
              )}
            </div>
            <div className="flex items-center gap-6 flex-wrap">
              <div className="flex items-center gap-2">
                <Switch id="skip-cache" checked={skipCache} onCheckedChange={setSkipCache} />
                <Label htmlFor="skip-cache" className="flex items-center gap-1.5 text-body-sm text-foreground-tertiary cursor-pointer">
                  <RefreshCw className="w-3.5 h-3.5" />
                  Skip cache
                </Label>
              </div>
              <div className="flex items-center gap-2">
                <Switch id="market-data" checked={marketData} onCheckedChange={setMarketData} />
                <Label htmlFor="market-data" className="flex items-center gap-1.5 text-body-sm text-foreground-tertiary cursor-pointer">
                  <Globe className="w-3.5 h-3.5" />
                  Market Data
                </Label>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Error — filter match failure shows editor, other errors show simple message */}
      {(error || analysisState.status === 'failed') && (() => {
        const errorMsg = error || analysisState.error || 'Analysis failed'
        const isFilterError = errorMsg.includes('appraisal filters') || errorMsg.includes('Suggested changes')

        if (isFilterError) {
          return (
            <div className="rounded-xl border border-red-500/20 overflow-hidden">
              <div className="px-6 py-5 space-y-4">
                <AppraisalFilterEditor
                  filters={appraisalFilters}
                  adjustments={appraisalAdjustments}
                  onFiltersChange={setAppraisalFilters}
                  onAdjustmentsChange={setAppraisalAdjustments}
                  arvThreshold={arvThreshold}
                  onArvThresholdChange={setArvThreshold}
                  errorMessage={errorMsg}
                  suggestedFilters={suggestedFilters}
                  compact
                />
                <div className="flex items-center gap-2">
                  {suggestedFilters && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setAppraisalFilters(suggestedFilters)
                        if (suggestedArvThreshold) setArvThreshold(suggestedArvThreshold)
                        setSuggestedFilters(null)
                        setSuggestedArvThreshold(null)
                        setError(null)
                        setPendingRetry(true)
                      }}
                      className="gap-1.5 border-amber-500/30 text-amber-600 hover:bg-amber-500/10"
                    >
                      Apply &amp; Retry
                    </Button>
                  )}
                  <Button size="sm" variant="outline" onClick={() => { setError(null); setSuggestedFilters(null); handleAnalyze() }} className="gap-1.5">
                    <Play className="w-3.5 h-3.5" />
                    Retry
                  </Button>
                </div>
              </div>
            </div>
          )
        }

        return (
          <div className="rounded-xl overflow-hidden border border-red-500/20">
            <div className="px-6 py-5">
              <div className="text-red-500 font-medium">Error</div>
              <div className="text-muted-foreground mt-1">{errorMsg}</div>
            </div>
          </div>
        )
      })()}

      {/* Progressive Results — render components as data arrives via step_data events */}
      {(isRunning || hasResult || hasPartialData) && (
        <div className="space-y-6">
          {/* Toolbar: only shown after final result */}
          {hasResult && (
            <div className="flex items-center justify-between no-print">
              <div className="flex items-center gap-3">
                {durationMs != null && (
                  <div className="text-caption text-foreground-tertiary">Completed in {(durationMs / 1000).toFixed(1)}s</div>
                )}
                {enrichmentStatus && (
                  <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-primary/10 text-caption text-primary">
                    <Loader2 className="w-3 h-3 animate-spin" />
                    <Sparkles className="w-3 h-3" />
                    {enrichmentStatus}
                  </div>
                )}
                {activeAnalysis?.jobId && (
                  <Link
                    href={`/dashboard/reports/${activeAnalysis.jobId}`}
                    className="flex items-center gap-1.5 text-caption text-primary hover:underline"
                  >
                    View Full Report
                    <ExternalLink className="w-3 h-3" />
                  </Link>
                )}
              </div>
              <div className="flex items-center gap-2 ml-auto">
                {isRecalculated && (
                  <Badge variant="outline" className="bg-blue-500/10 text-blue-600 border-blue-500/30 text-caption-sm">
                    Recalculated
                  </Badge>
                )}
                <Button variant="outline" size="sm" onClick={handleNewAnalysis}>
                  <Search className="w-3.5 h-3.5 mr-1.5" />
                  New Analysis
                </Button>
                <DownloadReportButton
                  reportProps={{
                    address: activeAnalysis?.address || 'Property Report',
                    date: new Date().toISOString(),
                    subject: analysisResult?.subject,
                    valuation: displayValuation,
                    comps: effectiveComps,
                    riskFlags: analysisResult?.riskFlags,
                    floodZone: analysisResult?.floodZone,
                    isRecalculated,
                  }}
                />
              </div>
            </div>
          )}

          {/* Sticky Valuation Summary Bar — only after final result, visible when full card scrolls out */}
          {hasResult && displayValuation && showStickyBar && (
            <div className="sticky top-0 z-10 no-print">
              <div className={cn(
                'border-x-0 border-b border-border overflow-hidden bg-background/90 backdrop-blur-xl',
                isRecalculated && 'ring-1 ring-amber-500/30'
              )}>
                <div className="px-4 py-3 flex items-center gap-4 flex-wrap">
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <DollarSign className="w-4 h-4 text-primary" />
                    <span className="text-caption font-medium text-foreground-secondary">Valuation</span>
                    {isRecalculated && (
                      <Badge className="bg-amber-500/15 text-amber-700 border-amber-500/30 text-[10px] px-1.5 py-0">
                        Recalculated
                      </Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-5 flex-1 min-w-0">
                    <div className="flex items-baseline gap-1.5">
                      <span className="text-caption-sm text-foreground-tertiary">ARV</span>
                      <span className="text-body-sm font-bold text-primary tabular-nums">
                        {isRecalculated && <span className="text-amber-500">~</span>}
                        ${displayValuation.arv?.toLocaleString() || '-'}
                      </span>
                    </div>
                    <div className="flex items-baseline gap-1.5">
                      <span className="text-caption-sm text-foreground-tertiary">Buy</span>
                      <span className="text-body-sm font-semibold tabular-nums">${displayValuation.buyPrice?.toLocaleString() || '-'}</span>
                    </div>
                    <div className="flex items-baseline gap-1.5">
                      <span className="text-caption-sm text-foreground-tertiary">Rehab</span>
                      <span className="text-body-sm font-medium tabular-nums">${displayValuation.rehabCost?.toLocaleString() || '-'}</span>
                    </div>
                    <div className="flex items-baseline gap-1.5">
                      <span className="text-caption-sm text-foreground-tertiary">Profit</span>
                      <span className={cn('text-body-sm font-semibold tabular-nums', (displayValuation.projectedProfit ?? 0) > 0 ? 'text-emerald-600' : 'text-red-600')}>
                        ${displayValuation.projectedProfit?.toLocaleString() || '-'}
                      </span>
                    </div>
                    {displayValuation.projectedROI != null && (
                      <div className="flex items-baseline gap-1.5">
                        <span className="text-caption-sm text-foreground-tertiary">ROI</span>
                        <span className={cn('text-body-sm font-semibold tabular-nums', displayValuation.projectedROI > 15 ? 'text-emerald-600' : displayValuation.projectedROI > 0 ? 'text-foreground' : 'text-red-600')}>
                          {displayValuation.projectedROI.toFixed(1)}%
                        </span>
                      </div>
                    )}
                  </div>
                  {displayValuation.recommendation && (
                    <Badge
                      variant="outline"
                      className={cn(
                        'text-[10px] px-2 py-0 flex-shrink-0',
                        displayValuation.recommendation.toUpperCase().includes('PURSUE') && 'bg-emerald-500/10 text-emerald-700 border-emerald-500/30',
                        displayValuation.recommendation.toUpperCase().includes('PASS') && 'bg-red-500/10 text-red-700 border-red-500/30',
                        displayValuation.recommendation.toUpperCase().includes('REVIEW') && 'bg-amber-500/10 text-amber-700 border-amber-500/30',
                      )}
                    >
                      {displayValuation.recommendation}
                    </Badge>
                  )}
                  <button
                    type="button"
                    onClick={() => setSettingsOpen(true)}
                    className="p-1.5 rounded-lg text-foreground-tertiary hover:text-foreground hover:bg-secondary transition-colors flex-shrink-0"
                    title="Evaluation Settings"
                  >
                    <SlidersHorizontal className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Progressive Report Content */}
          <div id="underwriter-report" data-date={new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })} className="space-y-6">
            {/* Print-only report header — only when final result */}
            {hasResult && (
              <div className="hidden print:block print-report-header">
                <div className="flex items-start justify-between pb-4 border-b-2 border-gray-800 mb-6">
                  <div>
                    <div className="text-xs font-semibold uppercase tracking-widest text-gray-500 mb-1">Underwriting Report</div>
                    <h1 className="text-2xl font-bold text-gray-900">{analysisResult.subject?.address || 'Property Analysis'}</h1>
                    {analysisResult.subject?.county && (
                      <div className="text-sm text-gray-500 mt-0.5">{analysisResult.subject.county} County</div>
                    )}
                  </div>
                  <div className="text-right">
                    <div className="text-xs text-gray-400 mb-1">Prepared by Flowstate</div>
                    <div className="text-xs text-gray-400">{new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</div>
                    {analysisResult.subject?.classification && (
                      <div className="mt-2 inline-block px-3 py-1 border border-gray-300 rounded text-xs font-medium">
                        {analysisResult.subject.classification.type === 'as_is' ? 'As-Is' : analysisResult.subject.classification.type === 'after_renovation' ? 'Renovated' : 'Transitional'}
                        {' · '}{analysisResult.subject.classification.confidence}% confidence
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* Subject Property — available after Step 1 (property_fetch) */}
            {displayData?.subject ? (
              <SubjectPropertyCard
                subject={displayData.subject}
                footer={displayData.subject.photos?.length ? (
                  <VisionAnalysisButton
                    photoUrls={displayData.subject.photos}
                    propertyContext={{
                      address: displayData.subject.address,
                      squareFeet: displayData.subject.squareFeet ?? undefined,
                      yearBuilt: displayData.subject.yearBuilt ?? undefined,
                    }}
                    existingAnalysis={displayData.visionAnalysis}
                  />
                ) : undefined}
              />
            ) : isRunning && !displayData?.subject ? (
              <SubjectPropertySkeleton />
            ) : null}

            {/* Valuation Summary — only from final result (Step 5) */}
            {hasResult && (appraisalFilters.length > 0 ? analysisResult?.valuation : displayValuation) ? (
              <div ref={valuationCardRef}>
                <ValuationCard
                  valuation={appraisalFilters.length > 0 ? (analysisResult?.valuation as import('./actions').ValuationData) : displayValuation!}
                  isRecalculated={appraisalFilters.length > 0 ? false : isRecalculated}
                  onOpenSettings={() => setSettingsOpen(true)}
                />
              </div>
            ) : isRunning ? (
              <ValuationSkeleton />
            ) : null}

            {/* Risk Flags & Flood Zone — available after Step 1 */}
            {(displayData?.riskFlags || displayData?.floodZone || displayData?.permits || analysisResult?.valuation?.asIsMarketIntel) ? (
              <RiskFloodCard riskFlags={displayData?.riskFlags} floodZone={displayData?.floodZone} permits={displayData?.permits} asIsMarketIntel={analysisResult?.valuation?.asIsMarketIntel} />
            ) : isRunning && !displayData?.riskFlags ? (
              <RiskFloodSkeleton />
            ) : null}

            {/* Comparables — available after Step 2, enriched with photos (Step 3) and classifications (Step 4) */}
            {hasResult ? (
              (appraisalFilters.length > 0 ? analysisResult?.comps : effectiveComps) && (
                <ComparablesSection
                  comps={appraisalFilters.length > 0 ? (analysisResult?.comps as import('./actions').CompsData) : effectiveComps!}
                  subject={displayData?.subject}
                  subjectSubdivision={displayData?.subject?.subdivision}
                  selectedCompKeys={appraisalFilters.length > 0 ? undefined : compOverride?.selectedCompKeys}
                  isManual={appraisalFilters.length > 0 ? false : (compOverride?.isManual ?? false)}
                  recalculatedArv={appraisalFilters.length > 0 ? undefined : (isRecalculated ? displayValuation?.arv : undefined)}
                  onToggleComp={appraisalFilters.length > 0 ? undefined : handleToggleComp}
                  onReset={appraisalFilters.length > 0 ? undefined : handleResetComps}
                />
              )
            ) : displayData && displayData.comps && displayData.comps.items && displayData.comps.items.length > 0 ? (
              <ComparablesSection
                comps={displayData.comps as CompsData}
                subject={displayData.subject!}
                subjectSubdivision={displayData.subject?.subdivision}
              />
            ) : isRunning ? (
              <ComparablesSkeleton />
            ) : null}
          </div>

          {/* Raw JSON Toggle — only after final result */}
          {hasResult && (
            <div className="border border-border rounded-xl overflow-hidden no-print">
              <div
                className="px-6 py-4 cursor-pointer flex items-center gap-3 hover:bg-white/5 dark:hover:bg-white/[0.02] transition-colors"
                onClick={() => setShowRawJson(!showRawJson)}
              >
                <div className="w-8 h-8 rounded-lg bg-secondary/60 flex items-center justify-center">
                  <Code className="w-4 h-4 text-foreground-secondary" />
                </div>
                <span className="text-body font-medium flex-1">Raw JSON Response</span>
                {showRawJson ? <ChevronDown className="w-4 h-4 text-foreground-tertiary" /> : <ChevronRight className="w-4 h-4 text-foreground-tertiary" />}
              </div>
              {showRawJson && (
                <div className="px-4 pb-4">
                  <div className="relative">
                    <button
                      type="button"
                      onClick={(e) => {
                        navigator.clipboard.writeText(JSON.stringify(analysisResult, null, 2))
                        const btn = e.currentTarget
                        btn.textContent = 'Copied!'
                        setTimeout(() => { btn.textContent = 'Copy JSON' }, 2000)
                      }}
                      className="absolute top-3 right-3 z-10 px-2.5 py-1 rounded-md bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs transition-colors border border-zinc-700"
                    >
                      Copy JSON
                    </button>
                    <pre className="bg-zinc-950 text-zinc-100 rounded-xl p-4 pt-10 overflow-auto max-h-[600px] text-xs font-mono">
                      {JSON.stringify(analysisResult, null, 2)}
                    </pre>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Evaluation Settings Sheet */}
      <Sheet open={settingsOpen} onOpenChange={(open) => {
        setSettingsOpen(open)
        // When opening settings panel, clear overrides so recalc engine takes over
        if (open && appraisalFilters.length > 0) {
          setAppraisalFilters([])
          setAppraisalAdjustments([])
        }
      }}>
        <SheetContent side="right" className="w-[400px] sm:max-w-[400px] p-0 flex flex-col">
          <SheetHeader className="px-5 pt-5 pb-3 border-b border-border">
            <SheetTitle className="text-body font-semibold">Evaluation Settings</SheetTitle>
            <SheetDescription className="text-caption text-foreground-tertiary">
              Adjust filters, adjustments, and deal parameters to see real-time recalculation.
            </SheetDescription>
          </SheetHeader>
          <SettingsPanel settingsHook={settingsHook} recalcData={recalcData} />
        </SheetContent>
      </Sheet>
    </div>
  )
}
