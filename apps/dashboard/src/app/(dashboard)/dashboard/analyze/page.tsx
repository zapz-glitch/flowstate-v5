'use client'

import { useState, useCallback, useEffect, useRef } from 'react'
import { useSetAtom } from 'jotai'
import { activeAnalysisAtom, analysisResultAtom, analysisStateAtom } from '@/atoms/analysis'
import { initialAnalysisState } from '@/types/analysis'
import {
  Search,
  Play,
  Code,
  RefreshCw,
  StopCircle,
  ChevronDown,
  ChevronRight,
  Loader2,
  BrainCircuit,
  Navigation,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { AddressAutocomplete } from '@/components/AddressAutocomplete'
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
import { getArvThreshold, getReportsByProperty, type ExistingReport } from '@/lib/client-api'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { useAnalysis } from '@/hooks/use-analysis'
import { useAnalysisEvaluation } from '@/hooks/use-analysis-evaluation'
import type { AnalysisStep } from '@/types/analysis'
import {
  ComparablesSection,
  VisionAnalysisButton,
  PropertyMap,
  DealSummaryHero,
  PhotoGallery,
} from '@/components/analysis'
import { ResizableLayout } from '@/components/ui/resizable'
import {
  SubjectPropertySkeleton,
  ValuationSkeleton,
  ComparablesSkeleton,
} from '@/components/analysis/AnalysisSkeletons'
import { useEnrichmentSSE, type EnrichmentEvent } from '@/hooks/use-enrichment-sse'
import { AppraisalFilterEditor, type FilterState, type AdjustmentState } from '@/components/analysis/AppraisalFilterEditor'
import { SettingsPanel } from '@/components/report/SettingsPanel'
import { DownloadReportButton } from '@/components/report/DownloadReportButton'
import { CompComparisonDialog } from '@/components/analysis/CompComparisonDialog'
import { getCompKey } from '@/components/analysis/format-helpers'
import type { CompItem } from './actions'

// ─── Analysis Phases ────────────────────────────────────────────────────────
//
//  idle     → nothing happening
//  fetching → API call in flight (show all skeletons)
//  ready    → API returned full result (valuation shown immediately)
//             Zillow photos + optional AI analysis may still be running in background
//
type AnalysisPhase = 'idle' | 'fetching' | 'ready'

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
  // Search & options
  const [address, setAddress] = useState('')
  const [skipCache, setSkipCache] = useState(false)
  const [arvThreshold, setArvThreshold] = useState(15)
  const [asIsThreshold, setAsIsThreshold] = useState(70)

  // Error & retry
  const [error, setError] = useState<string | null>(null)
  const [suggestedFilters, setSuggestedFilters] = useState<FilterState[] | null>(null)
  const [suggestedArvThreshold, setSuggestedArvThreshold] = useState<number | null>(null)
  const [pendingRetry, setPendingRetry] = useState(false)
  const [appraisalFilters, setAppraisalFilters] = useState<FilterState[]>([])
  const [appraisalAdjustments, setAppraisalAdjustments] = useState<AdjustmentState[]>([])

  // Existing reports dialog
  const [existingReports, setExistingReports] = useState<ExistingReport[]>([])
  const [showExistingDialog, setShowExistingDialog] = useState(false)
  const [pendingAnalyze, setPendingAnalyze] = useState(false)

  // UI state
  const [showRawJson, setShowRawJson] = useState(false)
  const [searchExpanded, setSearchExpanded] = useState(false)
  const [durationMs, setDurationMs] = useState<number | null>(null)

  // Phase-based state machine
  const [phase, setPhase] = useState<AnalysisPhase>('idle')
  const [aiAnalysis, setAiAnalysis] = useState(false)
  const [aiAnalyzing, setAiAnalyzing] = useState(false)
  const [enrichmentStreamUrl, setEnrichmentStreamUrl] = useState<string | null>(null)
  const [enrichmentToken, setEnrichmentToken] = useState<string | null>(null)

  // Global analysis context (Jotai)
  const {
    activeAnalysis,
    analysisState,
    analysisResult,
    displayData,
    clearAnalysis,
    cancelAnalysis,
  } = useAnalysis()

  // Load user's saved ARV threshold on mount
  useEffect(() => {
    getArvThreshold().then((res) => {
      setArvThreshold(res.config.percent)
    }).catch(() => {})
  }, [])

  // Derived state
  const isFetching = phase === 'fetching'
  const isReady = phase === 'ready'
  const isActive = phase !== 'idle'
  const hasResult = analysisResult !== null
  const renderData = displayData

  // Atom setters
  const setActiveAnalysis = useSetAtom(activeAnalysisAtom)
  const setAnalysisResult = useSetAtom(analysisResultAtom)
  const setAnalysisState = useSetAtom(analysisStateAtom)

  // ─── SSE Event Handler ────────────────────────────────────────────────────

  const handleEnrichmentEvent = useCallback((event: EnrichmentEvent) => {
    const { event: eventType, data } = event

    switch (eventType) {
      case 'market_data_started':
        // enrichment status removed('Fetching photos...')
        break

      case 'market_data_complete':
        if (data.updatedResult) {
          setAnalysisResult(data.updatedResult as AnalyzeData)
        }
        // enrichment status removed(null)
        break

      case 'llm_started':
        setAiAnalyzing(true)
        // enrichment status removed('AI analyzing comparables...')
        break

      case 'llm_complete':
        setAiAnalyzing(false)
        if (data.updatedResult) {
          setAnalysisResult(data.updatedResult as AnalyzeData)
        } else if (data.rankings) {
          setAnalysisResult((prev) => {
            if (!prev) return prev
            type Ranking = { compId: string; reasoning: string; score: number; keyFeatures: string[] }
            const rankings = data.rankings as Ranking[]
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
        }
        // enrichment status removed(null)
        break

      case 'enrichment_done':
        setAiAnalyzing(false)
        // enrichment status removed(null)
        setEnrichmentStreamUrl(null)
        setEnrichmentToken(null)
        break

      case 'error':
        setAiAnalyzing(false)
        // enrichment status removed(null)
        break
    }
  }, [setAnalysisResult])

  const { status: sseStatus } = useEnrichmentSSE({
    streamUrl: enrichmentStreamUrl,
    token: enrichmentToken,
    onEvent: handleEnrichmentEvent,
  })

  // Handle SSE connection failures
  useEffect(() => {
    if (sseStatus === 'error' || sseStatus === 'done') {
      setAiAnalyzing(false)
    }
  }, [sseStatus])

  // ─── Evaluation Hook ─────────────────────────────────────────────────────

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
    settingsOpen,
    setSettingsOpen,
  } = useAnalysisEvaluation({
    data: analysisResult ?? null,
    stickyBarRootMargin: '-60px 0px 0px 0px',
  })

  // ─── Map Interaction + Comparison Dialog ────────────────────────────────

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

  const handleMarkerSelect = useCallback((type: 'subject' | 'comp', compKey?: string) => {
    const key = type === 'subject' ? 'subject' : compKey
    if (!key) return
    setActiveMarkerKey(key)

    // Open comparison dialog for comp clicks
    if (type === 'comp' && compKey) {
      const compItems = (analysisResult?.comps?.items ?? renderData?.comps?.items ?? []) as CompItem[]
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
  }, [scrollAndHighlight, analysisResult, renderData])

  // ─── Analysis Handler ────────────────────────────────────────────────────

  // Core analysis runner
  const runAnalysis = useCallback(async () => {
    clearAnalysis()
    setError(null)
    setDurationMs(null)
    setEnrichmentStreamUrl(null)
    setEnrichmentToken(null)
    setAiAnalyzing(false)
    setPhase('fetching')

    const t0 = Date.now()
    try {
      const overrides = appraisalFilters.length > 0 ? {
        filters: appraisalFilters,
        adjustments: appraisalAdjustments,
      } : undefined

      const response = await queueAnalysis({
        address: address.trim(),
        searchOptions: { radiusMiles: 1, maxComps: 15, monthsBack: 12 },
        skipCache,
        marketData: { enabled: true },
        arvThresholdPercent: arvThreshold,
        asIsThresholdPercent: asIsThreshold,
        appraisalOverrides: overrides,
        llmAnalysis: aiAnalysis ? { enabled: true } : undefined,
      })

      if (response.success && response.result) {
        setDurationMs(Date.now() - t0)
        setActiveAnalysis({ jobId: response.jobId ?? '', address: address.trim() })
        setAnalysisResult(response.result as AnalyzeData)
        setAnalysisState({ ...initialAnalysisState, jobId: response.jobId ?? null, status: 'completed' })
        setPhase('ready')

        if (response.enrichment) {
          setEnrichmentStreamUrl(response.enrichment.streamUrl)
          setEnrichmentToken(response.enrichment.token)
          if (aiAnalysis) setAiAnalyzing(true)
        }
      } else {
        setPhase('idle')
        setError(response.error || 'Analysis failed')
        if (response.suggestedFilters) {
          setSuggestedFilters(response.suggestedFilters as FilterState[])
        }
        if (response.suggestedArvThreshold) {
          setSuggestedArvThreshold(response.suggestedArvThreshold)
        }
      }
    } catch (err) {
      setPhase('idle')
      setError(err instanceof Error ? err.message : 'Failed to start analysis')
    }
  }, [address, skipCache, aiAnalysis, arvThreshold, asIsThreshold, appraisalFilters, appraisalAdjustments, clearAnalysis, setActiveAnalysis, setAnalysisResult, setAnalysisState])

  // Entry point — checks for existing reports first
  const handleAnalyze = useCallback(async () => {
    if (!address.trim()) return

    try {
      const { reports } = await getReportsByProperty({ address: address.trim() })
      if (reports.length > 0) {
        setExistingReports(reports)
        setShowExistingDialog(true)
        return
      }
    } catch {
      // Lookup failed — proceed with analysis
    }

    runAnalysis()
  }, [address, runAnalysis])

  // Auto-retry after "Apply & Retry"
  useEffect(() => {
    if (pendingRetry) {
      setPendingRetry(false)
      handleAnalyze()
    }
  }, [pendingRetry, handleAnalyze])

  const handleCancel = useCallback(() => {
    setPhase('idle')
    cancelAnalysis()
  }, [cancelAnalysis])

  // Run AI analysis on existing result — re-calls API with llmAnalysis enabled
  const handleRunAiAnalysis = useCallback(async () => {
    if (!address.trim() || aiAnalyzing) return
    setAiAnalyzing(true)

    try {
      const overrides = appraisalFilters.length > 0 ? {
        filters: appraisalFilters,
        adjustments: appraisalAdjustments,
      } : undefined

      const response = await queueAnalysis({
        address: address.trim(),
        searchOptions: { radiusMiles: 1, maxComps: 15, monthsBack: 12 },
        skipCache: false,
        marketData: { enabled: true },
        arvThresholdPercent: arvThreshold,
        asIsThresholdPercent: asIsThreshold,
        appraisalOverrides: overrides,
        llmAnalysis: { enabled: true },
      })

      if (response.success && response.result) {
        // Update result with fresh evaluation (keeps current display while AI runs)
        setAnalysisResult(response.result as AnalyzeData)
        setActiveAnalysis({ jobId: response.jobId ?? '', address: address.trim() })
        setAnalysisState({ ...initialAnalysisState, jobId: response.jobId ?? null, status: 'completed' })

        if (response.enrichment) {
          setEnrichmentStreamUrl(response.enrichment.streamUrl)
          setEnrichmentToken(response.enrichment.token)
        }
      } else {
        setAiAnalyzing(false)
      }
    } catch {
      setAiAnalyzing(false)
    }
  }, [address, arvThreshold, asIsThreshold, appraisalFilters, appraisalAdjustments, aiAnalyzing, setAnalysisResult, setActiveAnalysis, setAnalysisState])

  // ─── Layout Flags ────────────────────────────────────────────────────────

  const isSearchCollapsed = isActive && !searchExpanded
  const hasMapData = !!(renderData?.subject?.latitude && renderData?.subject?.longitude)
  const showTwoColumn = isActive && hasMapData

  // ─── Render ──────────────────────────────────────────────────────────────

  return (
    <div className={cn('playground-bg -m-4 sm:-m-6 lg:-m-8', showTwoColumn ? 'min-h-screen lg:h-[100dvh] flex flex-col lg:overflow-hidden' : 'min-h-screen p-4 sm:p-6 lg:p-8 space-y-6')}>
      {/* Search bar + controls */}
      <div className={cn(showTwoColumn ? 'px-4 sm:px-6 pt-3 pb-1 space-y-3 flex-shrink-0' : 'space-y-6')}>
      {phase === 'idle' && !error && (
        <div>
          <h1 className="text-heading-lg text-foreground tracking-tight">API Playground</h1>
          <p className="text-body text-foreground-tertiary mt-1">Test the Flowstate API with real property data</p>
        </div>
      )}

      {/* Input Form — collapses to compact bar once active */}
      {isSearchCollapsed ? (
        <div
          className="border border-border/60 overflow-hidden cursor-pointer hover:border-primary/30 transition-all bg-background/80 backdrop-blur-sm shadow-sm corner-accents corner-accents-bottom"
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
              {isFetching && (
                <div className="text-xs text-primary mt-0.5" key={analysisState.currentStep}>
                  <TypewriterText text={getStatusLabel(analysisState.currentStep)} />
                </div>
              )}
              {aiAnalyzing && (
                <div className="text-xs text-primary mt-0.5 flex items-center gap-1.5">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  AI analyzing comps...
                </div>
              )}
            </div>
            {isFetching ? (
              <Button variant="destructive" size="sm" onClick={(e) => { e.stopPropagation(); handleCancel() }}>
                <StopCircle className="w-3.5 h-3.5 mr-1.5" />
                Cancel
              </Button>
            ) : (
              <div className="flex items-center gap-1.5">
                {isReady && hasResult && (
                  <div onClick={(e) => e.stopPropagation()} className="no-print">
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
                )}
                <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); setSearchExpanded(true) }}>
                  <ChevronDown className="w-3.5 h-3.5" />
                </Button>
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="relative z-20 border border-border/60 bg-background/80 backdrop-blur-sm shadow-sm corner-accents corner-accents-bottom">
          <div className="px-6 py-5 border-b border-border">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-primary/10 flex items-center justify-center">
                <Search className="w-4.5 h-4.5 text-primary" />
              </div>
              <div className="flex-1">
                <h2 className="text-body font-semibold">/v1/analyze</h2>
                <p className="text-caption text-foreground-tertiary">Property details, comparables, and valuation</p>
              </div>
              {isActive && (
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
                  if (!isFetching && address.trim()) {
                    handleAnalyze()
                    setSearchExpanded(false)
                  }
                }}
                className="flex-1"
                autoFocus={searchExpanded}
                disabled={isFetching}
              />
              {isFetching ? (
                <Button variant="destructive" onClick={handleCancel}>
                  <StopCircle className="w-4 h-4 mr-2" />
                  Cancel
                </Button>
              ) : (
                <Button onClick={() => { handleAnalyze(); setSearchExpanded(false) }} disabled={isFetching || !address.trim()}>
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
                <Switch id="ai-analysis" checked={aiAnalysis} onCheckedChange={setAiAnalysis} />
                <Label htmlFor="ai-analysis" className="flex items-center gap-1.5 text-body-sm text-foreground-tertiary cursor-pointer">
                  <BrainCircuit className="w-3.5 h-3.5" />
                  AI Analysis
                </Label>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Error display */}
      {(error || analysisState.status === 'failed') && (() => {
        const errorMsg = error || analysisState.error || 'Analysis failed'
        const isFilterError = errorMsg.includes('appraisal filters') || errorMsg.includes('Suggested changes')

        if (isFilterError) {
          return (
            <div className="border border-red-500/20 overflow-hidden">
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
          <div className="overflow-hidden border border-red-500/20">
            <div className="px-6 py-5">
              <div className="text-red-500 font-medium">Error</div>
              <div className="text-muted-foreground mt-1">{errorMsg}</div>
            </div>
          </div>
        )
      })()}
      </div>{/* end search wrapper */}

      {/* Two-column resizable layout */}
      {isActive && (
        <>
          {hasMapData ? (
          <ResizableLayout
            className="flex-1 min-h-0 mx-4 sm:mx-6 mt-3"
            left={
              <div className="h-full overflow-hidden">
                <PropertyMap
                  subject={renderData!.subject!}
                  comps={isReady ? (effectiveComps ?? analysisResult?.comps) : (hasResult ? analysisResult?.comps : renderData!.comps)}
                  subjectSubdivision={renderData!.subject?.subdivision}
                  selectedCompKeys={isReady ? compOverride?.selectedCompKeys : undefined}
                  onToggleComp={isReady ? handleToggleComp : undefined}
                  onMarkerSelect={handleMarkerSelect}
                  activeMarkerKey={activeMarkerKey}
                />
              </div>
            }
            right={
            <div className="min-w-0">
              <div id="underwriter-report" data-date={new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })} className={cn('flex flex-col gap-4', showTwoColumn && 'lg:pl-4 pb-4')}>

                {/* ── PHASE: FETCHING — all skeletons ── */}
                {isFetching && (
                  <>
                    <SubjectPropertySkeleton />
                    <ComparablesSkeleton />
                  </>
                )}

                {/* ── PHASE: READY — valuation shown immediately ── */}
                {isReady && hasResult && (
                  <>
                    {/* Deal summary / valuation */}
                    {renderData?.subject && displayValuation ? (
                      <div ref={valuationCardRef}>
                        <DealSummaryHero
                          subject={renderData.subject}
                          valuation={displayValuation}
                          isRecalculated={isRecalculated}
                          onOpenSettings={() => setSettingsOpen(true)}
                          riskFlags={renderData.riskFlags}
                          floodZone={renderData.floodZone}
                          jobId={activeAnalysis?.jobId}
                        />
                      </div>
                    ) : (
                      <ValuationSkeleton />
                    )}

                    {/* Proximity Adjustments */}
                    {hasResult && displayValuation && (
                      <div className="border border-border overflow-hidden no-print">
                        <div className="px-4 py-2.5 flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <Navigation className="w-3.5 h-3.5 text-foreground-tertiary" />
                            <span className="text-caption font-medium text-foreground-secondary">Proximity Adjustment</span>
                            {recalcData && recalcData.valuation.proximityDeduction > 0 && (
                              <span className="text-[10px] font-medium text-red-500 tabular-nums">
                                −${recalcData.valuation.proximityDeduction.toLocaleString()}
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-3">
                            {(['siding', 'backing', 'fronting'] as const).map((pos) => {
                              const label = pos === 'siding' ? 'Side' : pos === 'backing' ? 'Back' : 'Front'
                              const isOn = settingsHook.settings.proximityAdjustments?.[pos] ?? false
                              return (
                                <label key={pos} className="flex items-center gap-1.5 cursor-pointer">
                                  <Switch
                                    checked={isOn}
                                    onCheckedChange={(checked) => {
                                      const current = settingsHook.settings.proximityAdjustments ?? { siding: false, backing: false, fronting: false }
                                      settingsHook.updateProximityAdjustments({ ...current, [pos]: checked })
                                    }}
                                    className="scale-75"
                                  />
                                  <span className={`text-[11px] ${isOn ? 'text-foreground font-medium' : 'text-foreground-tertiary'}`}>{label}</span>
                                </label>
                              )
                            })}
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Photos */}
                    {renderData?.subject?.photos && renderData.subject.photos.length > 0 && (
                      <div className="border border-border px-4 py-3">
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-caption font-medium text-foreground-secondary">Property Photos</span>
                          <VisionAnalysisButton
                            photoUrls={renderData.subject.photos}
                            propertyContext={{
                              address: renderData.subject.address,
                              squareFeet: renderData.subject.squareFeet ?? undefined,
                              yearBuilt: renderData.subject.yearBuilt ?? undefined,
                            }}
                            existingAnalysis={renderData.visionAnalysis}
                          />
                        </div>
                        <PhotoGallery photos={renderData.subject.photos} />
                      </div>
                    )}

                    {/* AI analysis in progress banner */}
                    {aiAnalyzing && (
                      <div className="border border-primary/20 bg-primary/5 px-4 py-3 flex items-center gap-3">
                        <Loader2 className="w-4 h-4 text-primary animate-spin flex-shrink-0" />
                        <span className="text-body-sm text-foreground-secondary">AI analysis in progress — comp selection may update</span>
                      </div>
                    )}

                    {/* Comps with selection + evaluation */}
                    {(appraisalFilters.length > 0 ? analysisResult?.comps : effectiveComps) && (
                      <ComparablesSection
                        comps={appraisalFilters.length > 0 ? (analysisResult?.comps as CompsData) : effectiveComps!}
                        subject={renderData?.subject}
                        subjectSubdivision={renderData?.subject?.subdivision}
                        selectedCompKeys={compOverride?.selectedCompKeys}
                        isManual={compOverride?.isManual ?? false}
                        recalculatedArv={isRecalculated ? displayValuation?.arv : undefined}
                        onToggleComp={handleToggleComp}
                        onReset={handleResetComps}
                        highlightedCompKey={activeMarkerKey}
                        isAnalyzing={aiAnalyzing}
                        onRunAiAnalysis={!aiAnalyzing ? handleRunAiAnalysis : undefined}
                      />
                    )}

                    {/* Raw JSON */}
                    <div className="border border-border overflow-hidden no-print min-w-0">
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
                            <pre className="bg-zinc-950 text-zinc-100 p-4 pt-10 overflow-auto max-h-[600px] text-xs font-mono">
                              {JSON.stringify(analysisResult, null, 2)}
                            </pre>
                          </div>
                        </div>
                      )}
                    </div>
                  </>
                )}

              </div>{/* end underwriter-report */}
            </div>
            }
          />
          ) : isActive && (
          <div className="flex-1 min-w-0 p-4 sm:p-6">
            <div className="flex flex-col gap-4">
              {isFetching && (
                <>
                  <SubjectPropertySkeleton />
                  <ComparablesSkeleton />
                </>
              )}
            </div>
          </div>
          )}
        </>
      )}

      {/* Evaluation Settings Sheet */}
      <Sheet open={settingsOpen} onOpenChange={(open) => {
        setSettingsOpen(open)
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

      {/* Subject vs Comp comparison dialog */}
      <CompComparisonDialog
        open={comparisonOpen}
        onOpenChange={setComparisonOpen}
        subject={renderData?.subject ?? null}
        comp={comparisonComp}
        isSelected={comparisonComp && compOverride?.selectedCompKeys
          ? compOverride.selectedCompKeys.has(comparisonComp.address || '')
          : comparisonComp?.isEnabled !== false}
        onToggleSelection={isReady && comparisonComp ? () => {
          const key = comparisonComp.address || ''
          handleToggleComp(key)
        } : undefined}
      />

      {/* Existing Reports Dialog */}
      <Dialog open={showExistingDialog} onOpenChange={setShowExistingDialog}>
        <DialogContent className="max-w-md p-0 gap-0">
          <DialogHeader className="px-5 pt-5 pb-3 border-b border-border">
            <DialogTitle className="text-body font-semibold">Existing Reports Found</DialogTitle>
          </DialogHeader>
          <div className="p-4 space-y-3">
            <p className="text-caption text-foreground-tertiary">
              {existingReports.length} report{existingReports.length !== 1 ? 's' : ''} already exist for this address. Open an existing report or create a new analysis.
            </p>
            <div className="space-y-2 max-h-[300px] overflow-y-auto">
              {existingReports.map((r) => (
                <a
                  key={r.id}
                  href={`/dashboard/reports/${r.jobId}`}
                  className="block border border-border px-4 py-3 hover:bg-muted/40 transition-colors"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-foreground truncate">{r.propertyAddress}</span>
                    <span className="text-[10px] text-foreground-tertiary flex-shrink-0 ml-2">
                      {new Date(r.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 mt-1 text-[10px] text-foreground-tertiary">
                    {r.arv != null && <span>ARV: ${r.arv.toLocaleString()}</span>}
                    {r.maxAllowableOffer != null && <span>MAO: ${r.maxAllowableOffer.toLocaleString()}</span>}
                    {r.estimatedRepairs != null && <span>Rehab: ${r.estimatedRepairs.toLocaleString()}</span>}
                  </div>
                </a>
              ))}
            </div>
          </div>
          <DialogFooter className="px-5 pb-4 pt-2 border-t border-border">
            <Button variant="outline" size="sm" onClick={() => setShowExistingDialog(false)}>
              Cancel
            </Button>
            <Button size="sm" onClick={() => { setShowExistingDialog(false); runAnalysis() }}>
              New Analysis
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
