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
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { AddressAutocomplete } from '@/components/AddressAutocomplete'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { EvaluationSettingsSheet } from '@/components/report/EvaluationSettingsSheet'
import { queueAnalysis, type AnalyzeData } from './actions'
import { getArvThreshold, getReportsByProperty, getSavedReport, runCompSelection, type ExistingReport } from '@/lib/client-api'
import { useAutoSave } from '@/hooks/use-auto-save'
import { ExistingReportsDialog } from './ExistingReportsDialog'
// cn is used in the outer wrapper
import { cn } from '@/lib/utils'
import { useAnalysis } from '@/hooks/use-analysis'
import { useAnalysisEvaluation } from '@/hooks/use-analysis-evaluation'
import type { AnalysisStep } from '@/types/analysis'
import {
  AnalysisPageLayout,
} from '@/components/analysis'
import { AnalysisPageSkeleton } from '@/components/analysis/AnalysisSkeletons'
import { useEnrichmentSSE, type EnrichmentEvent } from '@/hooks/use-enrichment-sse'
import { AppraisalFilterEditor, type FilterState, type AdjustmentState } from '@/components/analysis/AppraisalFilterEditor'
import { DownloadReportButton } from '@/components/report/DownloadReportButton'
import { CompComparisonDialog } from '@/components/analysis/CompComparisonDialog'
import { useMapInteraction } from '@/hooks/use-map-interaction'
import { useEvaluationSync } from '@/hooks/use-evaluation-sync'
import type { CompItem } from './actions'

// ─── Analysis Phases ────────────────────────────────────────────────────────
//
//  idle     → nothing happening
//  fetching → API call in flight (show all skeletons)
//  ready    → API returned full result (valuation shown immediately)
//             Zillow photos + optional AI analysis may still be running in background
//
type AnalysisPhase = 'idle' | 'fetching' | 'ready'

// Last searched property — restored when returning to Property Search
const LAST_ANALYSIS_KEY = 'flowstate:last-analysis'

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
  const [aiOnlyMode, setAiOnlyMode] = useState(false) // true when "AI Selection" button clicked (skip evaluation_complete)
  const aiOnlyModeRef = useRef(false)
  const [showAdvanced, setShowAdvanced] = useState(false)

  // AI comp selection toggle (per-session, not persisted)
  const [aiEnabled, setAiEnabled] = useState(false)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [marketContext, setMarketContext] = useState<Record<string, any> | null>(null)
  const [aiReport, setAiReport] = useState<{ summary: string; selected: number; total: number; model: string } | null>(null)
  const [aiAnalysisDone, setAiAnalysisDone] = useState(false)
  // Snapshot of comps before AI overwrites them — used to restore on undo
  const preAiCompsRef = useRef<unknown>(null)

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

  // UI state
  const [showRawJson, setShowRawJson] = useState(false)
  const [searchExpanded, setSearchExpanded] = useState(false)
  const [durationMs, setDurationMs] = useState<number | null>(null)

  // Phase-based state machine
  const [phase, setPhase] = useState<AnalysisPhase>('idle')
  const [aiAnalyzing, setAiAnalyzing] = useState(false)
  const [streamingStep, setStreamingStep] = useState<'idle' | 'searching' | 'subject' | 'comps' | 'evaluating' | 'done'>('idle')
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

  // Restore the last searched property when the page mounts with no
  // in-flight analysis — the saved report carries the full AnalyzeData JSON.
  const restoredRef = useRef(false)
  useEffect(() => {
    if (restoredRef.current || analysisResult || activeAnalysis) return
    restoredRef.current = true
    let last: { jobId?: string; address?: string } | null = null
    try { last = JSON.parse(localStorage.getItem(LAST_ANALYSIS_KEY) || 'null') } catch { /* ignore */ }
    if (!last?.jobId) return
    setPhase('fetching')
    getSavedReport(last.jobId).then((res) => {
      if (res?.analysis) {
        setAnalysisResult(res.analysis as AnalyzeData)
        setActiveAnalysis({ jobId: res.jobId ?? last.jobId!, address: res.address || last.address || '' })
        setAddress(res.address || last.address || '')
        setPhase('ready')
      } else {
        setPhase('idle')
      }
    }).catch(() => {
      try { localStorage.removeItem(LAST_ANALYSIS_KEY) } catch { /* ignore */ }
      setPhase('idle')
    })
  }, [analysisResult, activeAnalysis, setAnalysisResult, setActiveAnalysis])

  // ─── SSE Event Handler ────────────────────────────────────────────────────

  const handleEnrichmentEvent = useCallback((event: EnrichmentEvent) => {
    const { event: eventType, data } = event
    const isAiOnly = aiOnlyModeRef.current

    switch (eventType) {
      case 'property_fetch':
        if (!isAiOnly) setStreamingStep('searching')
        break

      case 'subject_found':
        if (isAiOnly) break // Skip — keep existing result
        setStreamingStep('subject')
        if (data.subject) {
          setAnalysisResult((prev) => ({
            ...(prev ?? {}),
            subject: data.subject,
          } as AnalyzeData))
          setPhase('ready')
        }
        break

      case 'comps_found':
        if (isAiOnly) break // Skip — keep existing result
        setStreamingStep('comps')
        if (data.comps) {
          setAnalysisResult((prev) => ({
            ...(prev ?? {}),
            comps: {
              count: data.compCount,
              enabledCount: 0,
              disabledCount: data.compCount,
              items: data.comps.map((c: Record<string, unknown>) => ({
                ...c,
                isEnabled: false,
              })),
            },
          } as AnalyzeData))
        }
        break

      case 'evaluation_started':
        if (!isAiOnly) setStreamingStep('evaluating')
        break

      case 'evaluation_complete':
        if (isAiOnly) break // Skip — keep existing evaluation, wait for LLM
        setStreamingStep('done')
        if (data.updatedResult) {
          setAnalysisResult(data.updatedResult as AnalyzeData)
          setAnalysisState((prev) => ({ ...prev, status: 'completed' }))
        }
        break

      case 'llm_started':
        setAiAnalyzing(true)
        break

      case 'llm_complete':
        setAiAnalyzing(false)
        setAiOnlyMode(false)
        aiOnlyModeRef.current = false
        setAiAnalysisDone(true)
        if (data.updatedResult) {
          // Snapshot current comps before AI overwrites them (for undo)
          setAnalysisResult((prev) => {
            if (!prev) return data.updatedResult as AnalyzeData
            if (!preAiCompsRef.current && prev.comps) {
              preAiCompsRef.current = prev.comps
            }
            const updated = data.updatedResult as AnalyzeData
            return {
              ...prev,
              comps: updated.comps, // AI-updated comp selection (isEnabled, compGroup, etc.)
            }
          })
        }
        if (data.llmAnalysis) {
          const la = data.llmAnalysis as { summary?: string; selectedForArv?: string[]; compCount?: number; model?: string }
          setAiReport({
            summary: la.summary || 'AI comp selection complete',
            selected: la.selectedForArv?.length ?? 0,
            total: la.compCount ?? 0,
            model: la.model?.split('/').pop() ?? '',
          })
        }
        break

      case 'market_context':
        if (data.marketContext) setMarketContext(data.marketContext as Record<string, unknown>)
        break

      case 'risk_flags_updated':
        if (data.riskFlags) {
          setAnalysisResult((prev) => prev ? { ...prev, riskFlags: data.riskFlags as string[] } : prev)
        }
        break

      case 'enrichment_done':
        setAiAnalyzing(false)
        setEnrichmentStreamUrl(null)
        setEnrichmentToken(null)
        // If we never got evaluation_complete (error path), show ready anyway
        setPhase((prev) => prev === 'fetching' ? 'ready' : prev)
        break

      case 'error':
        setAiAnalyzing(false)
        setAiOnlyMode(false)
        aiOnlyModeRef.current = false
        setStreamingStep('done')
        if (data.message) {
          setError(data.message as string)
          if (data.suggestedFilters) {
            setSuggestedFilters(data.suggestedFilters as FilterState[])
          }
          if (data.suggestedArvThreshold) {
            setSuggestedArvThreshold(data.suggestedArvThreshold as number)
          }
        }
        // Keep showing whatever we have (subject/comps), don't hide the UI
        setPhase((prev) => prev === 'fetching' ? 'ready' : prev)
        break
    }
  }, [setAnalysisResult, setAnalysisState])

  const { status: sseStatus } = useEnrichmentSSE({
    streamUrl: enrichmentStreamUrl,
    token: enrichmentToken,
    onEvent: handleEnrichmentEvent,
  })

  // Handle SSE connection failures — show results even if SSE fails
  useEffect(() => {
    if (sseStatus === 'error' || sseStatus === 'done') {
      setAiAnalyzing(false)
      setPhase((prev) => prev === 'fetching' ? 'ready' : prev)
    }
  }, [sseStatus])

  // ─── Evaluation Hook ─────────────────────────────────────────────────────

  const {
    authoritativeData,
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
    aiAnalyzing,
  })

  // ─── Auto-save on evaluation/comp changes ──────────────────────────────
  const { resetAutoSave } = useAutoSave({
    jobId: isReady ? activeAnalysis?.jobId : null,
    analysisData: analysisResult,
    displayValuation,
    recalcData,
    compOverride,
    settingsHook,
    aiReport,
    preAiComps: preAiCompsRef.current,
  })

  // Reset auto-save state when starting a new analysis
  useEffect(() => {
    if (phase === 'fetching') resetAutoSave()
  }, [phase, resetAutoSave])

  // ─── Map Interaction + Comparison Dialog ────────────────────────────────

  const {
    activeMarkerKey,
    comparisonComp,
    setComparisonComp,
    comparisonOpen,
    setComparisonOpen,
    handleMarkerSelect,
  } = useMapInteraction(() =>
    (effectiveComps?.items ?? renderData?.comps?.items ?? []) as CompItem[]
  )

  // ─── Sync evaluation state to Jotai atoms ────────────────────────────────
  // Run AI comp selection on existing result — lightweight LLM-only call
  const handleRunAiAnalysis = useCallback(async () => {
    if (!analysisResult?.subject || !analysisResult?.comps?.items?.length || aiAnalyzing) return
    setAiAnalyzing(true)
    try {
      // Snapshot current comps before AI overwrites them (for undo)
      if (!preAiCompsRef.current && analysisResult.comps) {
        preAiCompsRef.current = analysisResult.comps
      }
      const s = settingsHook.settings
      const response = await runCompSelection({
        subject: analysisResult.subject as Record<string, unknown>,
        comps: analysisResult.comps as { items: Array<Record<string, unknown>> },
        riskFlags: (analysisResult as Record<string, unknown>).riskFlags as string[] | undefined,
        settings: {
          filters: s.filters.map((f) => ({ type: f.type, enabled: f.enabled, value: f.value })),
          adjustments: s.adjustments.map((a) => ({ type: a.type, enabled: a.enabled, amount: a.amount, percent: a.percent })),
          dealParams: {
            closingCostsPercent: s.dealParams.closingCostsPercent,
            carryingCostsPercent: s.dealParams.carryingCostsPercent,
            wholesaleFee: s.dealParams.wholesaleFee,
          },
          rehabLevelIndex: s.rehabLevelIndex,
          arvThresholdPercent: s.dealParams.arvThresholdPercent,
          asIsThresholdPercent: s.asIsThresholdPercent,
        },
      })
      if (response.success && response.updatedComps) {
        setAnalysisResult((prev) => {
          if (!prev) return prev
          return { ...prev, comps: response.updatedComps as typeof prev.comps }
        })
        setAiAnalysisDone(true)
        if (response.llmAnalysis) {
          setAiReport({
            summary: response.llmAnalysis.summary || 'AI comp selection complete',
            selected: response.llmAnalysis.selectedForArv?.length ?? 0,
            total: response.llmAnalysis.compCount ?? 0,
            model: response.llmAnalysis.model?.split('/').pop() ?? '',
          })
        }
        handleResetComps() // Sync comp override with new isEnabled flags
      }
    } catch {
      // Restore snapshot on error
      preAiCompsRef.current = null
    } finally {
      setAiAnalyzing(false)
    }
  }, [analysisResult, aiAnalyzing, settingsHook.settings, handleResetComps, setAnalysisResult])

  const handleUndoAiSelection = useCallback(() => {
    // Restore original math-based comp selection
    if (preAiCompsRef.current) {
      setAnalysisResult((prev) => {
        if (!prev) return prev
        return { ...prev, comps: preAiCompsRef.current as typeof prev.comps }
      })
      preAiCompsRef.current = null
    }
    handleResetComps()
    setAiReport(null)
    setAiAnalysisDone(false)
  }, [handleResetComps, setAnalysisResult])

  useEvaluationSync({
    evaluation: { isRecalculated, recalcData, compOverride, handleToggleComp, handleResetComps },
    subject: renderData?.subject,
    displayValuation: isReady ? displayValuation : undefined,
    effectiveComps: isReady ? effectiveComps : undefined,
    aiAnalyzing,
    isStreaming: streamingStep !== 'idle' && streamingStep !== 'done',
    marketContext,
    aiReport,
    onOpenSettings: () => setSettingsOpen(true),
    onCompClick: (comp) => { setComparisonComp(comp as CompItem); setComparisonOpen(true) },
    onRunAiAnalysis: handleRunAiAnalysis,
    onUndoAiSelection: aiAnalysisDone ? handleUndoAiSelection : undefined,
  })

  // ─── Analysis Handler ────────────────────────────────────────────────────

  // Core analysis runner
  const runAnalysis = useCallback(async () => {
    clearAnalysis()
    setError(null)
    setDurationMs(null)
    setEnrichmentStreamUrl(null)
    setEnrichmentToken(null)
    setAiAnalyzing(false)
    setMarketContext(null)
    setAiReport(null)
    setAiAnalysisDone(false)
    setAiOnlyMode(false)
    aiOnlyModeRef.current = false
    setStreamingStep('idle')
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
        llmAnalysis: aiEnabled ? { enabled: true } : undefined,
      })

      if (response.success) {
        setActiveAnalysis({ jobId: response.jobId ?? '', address: address.trim() })
        setAnalysisState({ ...initialAnalysisState, jobId: response.jobId ?? null, status: 'processing' })
        try {
          localStorage.setItem(LAST_ANALYSIS_KEY, JSON.stringify({ jobId: response.jobId ?? '', address: address.trim() }))
        } catch { /* ignore */ }

        // Result streams via SSE — connect immediately
        if (response.enrichment) {
          setEnrichmentStreamUrl(response.enrichment.streamUrl)
          setEnrichmentToken(response.enrichment.token)
        }

        // If route returned a sync result (legacy/fallback), show it immediately
        if (response.result) {
          setDurationMs(Date.now() - t0)
          setAnalysisResult(response.result as AnalyzeData)
          setPhase('ready')
          if (response.enrichment) setAiAnalyzing(true)
        }
        // Otherwise phase stays 'fetching' — SSE events will update it
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
  }, [address, skipCache, arvThreshold, asIsThreshold, appraisalFilters, appraisalAdjustments, clearAnalysis, setActiveAnalysis, setAnalysisResult, setAnalysisState])

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
          <h1 className="text-heading-lg text-foreground tracking-tight">Property Search</h1>
          <p className="text-body text-foreground-tertiary mt-1">Search an address. Underwrite the deal.</p>
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
              {streamingStep !== 'idle' && streamingStep !== 'done' && !error && (
                <div className="text-xs text-primary mt-0.5 flex items-center gap-1.5">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  {streamingStep === 'searching' && 'Searching property...'}
                  {streamingStep === 'subject' && 'Loading comparables...'}
                  {streamingStep === 'comps' && 'Enriching comp details...'}
                  {streamingStep === 'evaluating' && 'Evaluating comparables...'}
                </div>
              )}
              {error && (
                <div className="text-xs text-red-500 mt-0.5 truncate">{error}</div>
              )}
              {aiAnalyzing && streamingStep === 'done' && !error && (
                <div className="text-xs text-primary mt-0.5 flex items-center gap-1.5">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  AI selecting best comps...
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
                        subject: authoritativeData?.subject,
                        valuation: displayValuation,
                        comps: effectiveComps,
                        riskFlags: authoritativeData?.riskFlags,
                        floodZone: authoritativeData?.floodZone,
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
            <button
              type="button"
              onClick={() => setShowAdvanced((v) => !v)}
              className="text-[11px] text-foreground-tertiary hover:text-foreground transition-colors flex items-center gap-1"
            >
              Advanced
              <ChevronDown className={cn('w-3 h-3 transition-transform', showAdvanced && 'rotate-180')} />
            </button>
            {showAdvanced && (
              <div className="flex items-center gap-4 flex-wrap pt-2 border-t border-border/30">
                <div className="flex items-center gap-2">
                  <Switch id="skip-cache" checked={skipCache} onCheckedChange={setSkipCache} />
                  <Label htmlFor="skip-cache" className="flex items-center gap-1.5 text-[11px] text-foreground-tertiary cursor-pointer">
                    <RefreshCw className="w-3.5 h-3.5" />
                    Skip cache
                  </Label>
                </div>
                <div className="flex items-center gap-2">
                  <Switch id="ai-enabled" checked={aiEnabled} onCheckedChange={setAiEnabled} />
                  <Label htmlFor="ai-enabled" className="text-[11px] text-foreground-tertiary cursor-pointer">
                    AI Selection
                  </Label>
                </div>
              </div>
            )}
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

      {/* Loading skeleton — two-column layout matching the final result */}
      {isFetching && <AnalysisPageSkeleton />}

      {/* Analysis layout — map + valuation on left, comps on right */}
      {isReady && (
        <AnalysisPageLayout
          mapComps={effectiveComps ?? analysisResult?.comps}
          onMarkerSelect={handleMarkerSelect}
          activeMarkerKey={activeMarkerKey}
          riskFlags={authoritativeData?.riskFlags ?? renderData?.riskFlags}
          floodZone={authoritativeData?.floodZone ?? renderData?.floodZone}

          valuationCardRef={valuationCardRef}
          footer={
            isReady && hasResult ? (
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
                          navigator.clipboard.writeText(JSON.stringify(authoritativeData, null, 2))
                          const btn = e.currentTarget
                          btn.textContent = 'Copied!'
                          setTimeout(() => { btn.textContent = 'Copy JSON' }, 2000)
                        }}
                        className="absolute top-3 right-3 z-10 px-2.5 py-1 rounded-md bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs transition-colors border border-zinc-700"
                      >
                        Copy JSON
                      </button>
                      <pre className="bg-zinc-950 text-zinc-100 p-4 pt-10 overflow-auto max-h-[600px] text-xs font-mono">
                        {JSON.stringify(authoritativeData, null, 2)}
                      </pre>
                    </div>
                  </div>
                )}
              </div>
            ) : undefined
          }
        />
      )}

      {/* Evaluation Settings Sheet */}
      <EvaluationSettingsSheet
        open={settingsOpen}
        onOpenChange={(open) => {
          setSettingsOpen(open)
          if (open && appraisalFilters.length > 0) {
            setAppraisalFilters([])
            setAppraisalAdjustments([])
          }
        }}
        settingsHook={settingsHook}
        recalcData={recalcData}
      />

      {/* Subject vs Comp comparison dialog */}
      <CompComparisonDialog
        open={comparisonOpen}
        onOpenChange={setComparisonOpen}
        subject={renderData?.subject ?? null}
        comp={comparisonComp ? effectiveComps?.items?.find(comp => comp.address === comparisonComp.address) ?? comparisonComp : null}
        isSelected={comparisonComp && compOverride?.selectedCompKeys
          ? compOverride.selectedCompKeys.has(comparisonComp.address || '')
          : comparisonComp?.isEnabled !== false}
        onToggleSelection={isReady && comparisonComp ? () => {
          const key = comparisonComp.address || ''
          handleToggleComp(key)
        } : undefined}
        arv={displayValuation?.arv}
        proximityConfig={settingsHook.settings.proximityConfig}
      />

      {/* Existing Reports Dialog */}
      <ExistingReportsDialog
        open={showExistingDialog}
        onOpenChange={setShowExistingDialog}
        reports={existingReports}
        onNewAnalysis={runAnalysis}
      />
    </div>
  )
}
