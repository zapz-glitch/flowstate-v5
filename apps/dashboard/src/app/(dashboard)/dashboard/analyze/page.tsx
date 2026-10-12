'use client'

import { isValidCoordinate } from '@/lib/property-map-geometry'

import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import dynamic from 'next/dynamic'
import { useAtomValue, useSetAtom } from 'jotai'
import { activeAnalysisAtom, analysisResultAtom, analysisStateAtom, evalProgressAtom, permitProgressAtom } from '@/atoms/analysis'
import { permitProgressFromEvent } from '@/lib/permit-progress'
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
import { PageHeader } from '@/components/ui/page-header'
import { SkinPreview } from '@/components/prototype/SkinPreview'
import { usePreloadOnIdle, useStayMounted } from '@/hooks/use-stay-mounted'
import { AddressAutocomplete } from '@/components/AddressAutocomplete'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { queueAnalysis, dispatchOfferPrep, declineOffer, type AnalyzeData } from './actions'
import { buildDealContext } from '@/lib/deal-context'
import { reloadForStaleAction } from '@/lib/server-action'
import { getArvThreshold, getLatestReport, getReportsByProperty, getSavedReport, runCompSelection, type ExistingReport, type OfferWorkflow } from '@/lib/client-api'
import { useAutoSave } from '@/hooks/use-auto-save'
// cn is used in the outer wrapper
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import { useAnalysis } from '@/hooks/use-analysis'
import { useAnalysisEvaluation } from '@/hooks/use-analysis-evaluation'
import type { AnalysisStep } from '@/types/analysis'
import { AnalysisPageSkeleton } from '@/components/analysis/AnalysisSkeletons'
import { useEnrichmentSSE, type EnrichmentEvent } from '@/hooks/use-enrichment-sse'
import type { FilterState, AdjustmentState } from '@/components/analysis/AppraisalFilterEditor'
import { DownloadReportButton } from '@/components/report/DownloadReportButton'
import { useMapInteraction } from '@/hooks/use-map-interaction'
import { useEvaluationSync } from '@/hooks/use-evaluation-sync'
import type { CompItem } from './actions'
import { ReportToolbar, REPORT_TOOLBAR_TILE } from '@/components/analysis/ReportToolbar'

// Keep the initial search route light; load report UI only when it is needed.
const AnalysisPageLayout = dynamic(
  () => import('@/components/analysis/AnalysisPageLayout').then((mod) => mod.AnalysisPageLayout),
  { loading: () => <AnalysisPageSkeleton /> },
)
const EvaluationSettingsSheet = dynamic(() => import('@/components/report/EvaluationSettingsSheet').then((mod) => mod.EvaluationSettingsSheet))
const loadCompComparisonDialog = () => import('@/components/analysis/CompComparisonDialog')
const CompComparisonDialog = dynamic(() => loadCompComparisonDialog().then((mod) => mod.CompComparisonDialog))
const ExistingReportsDialog = dynamic(() => import('./ExistingReportsDialog').then((mod) => mod.ExistingReportsDialog))
const AppraisalFilterEditor = dynamic(() => import('@/components/analysis/AppraisalFilterEditor').then((mod) => mod.AppraisalFilterEditor))

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
const LAST_ANALYSIS_TTL_MS = 7 * 24 * 60 * 60 * 1000 // restore window: 7 days

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

/** Reads evalProgressAtom — SSE ticks re-render this leaf, not the whole page. */
function EvalProgressLabel({ fallback = 'Evaluating comparables...' }: { fallback?: string }) {
  const evalProgress = useAtomValue(evalProgressAtom)
  return <>{evalProgress ?? fallback}</>
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
  // Global analysis context (Jotai)
  const {
    activeAnalysis,
    analysisState,
    analysisResult,
    displayData,
    clearAnalysis,
    cancelAnalysis,
  } = useAnalysis()

  // Search & options
  const [address, setAddress] = useState(activeAnalysis?.address ?? '')
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
  const [phase, setPhase] = useState<AnalysisPhase>(analysisResult ? 'ready' : 'idle')
  const [aiAnalyzing, setAiAnalyzing] = useState(false)
  const [streamingStep, setStreamingStep] = useState<'idle' | 'searching' | 'subject' | 'comps' | 'evaluating' | 'done'>('idle')
  // Atom, not useState — eval_progress SSE ticks re-render only the label leaf.
  const setEvalProgress = useSetAtom(evalProgressAtom)
  const picksShownRef = useRef(false)
  const pocketShownRef = useRef(false)
  const setPermitProgress = useSetAtom(permitProgressAtom)
  const [enrichmentStreamUrl, setEnrichmentStreamUrl] = useState<string | null>(null)
  const [enrichmentToken, setEnrichmentToken] = useState<string | null>(null)

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

  // Restore in the background. Typing or starting a search takes precedence
  // over a late response, so an old report cannot replace the user's new work.
  const restoreCancelledRef = useRef(false)
  const [restoringReport, setRestoringReport] = useState(false)
  const cancelRestore = useCallback(() => {
    restoreCancelledRef.current = true
    setRestoringReport(false)
  }, [])

  useEffect(() => {
    if (analysisResult || activeAnalysis || restoreCancelledRef.current) return
    if (new URLSearchParams(window.location.search).has('address')) return
    let cancelled = false
    const isCancelled = () => cancelled || restoreCancelledRef.current
    setRestoringReport(true)

    async function resumeReport() {
      let last: { jobId?: string; address?: string; savedAt?: number } | null = null
      try { last = JSON.parse(localStorage.getItem(LAST_ANALYSIS_KEY) || 'null') } catch { /* ignore */ }
      const fresh = last?.jobId && !(last.savedAt && Date.now() - last.savedAt > LAST_ANALYSIS_TTL_MS)
      if (!fresh) {
        if (last?.jobId) {
          try { localStorage.removeItem(LAST_ANALYSIS_KEY) } catch { /* ignore */ }
        }
        const latest = await getLatestReport()
        if (isCancelled() || !latest || Date.now() - new Date(latest.createdAt).getTime() > LAST_ANALYSIS_TTL_MS) return
        last = latest
      }
      if (isCancelled() || !last?.jobId) return
      const res = await getSavedReport(last.jobId)
      if (isCancelled() || !res?.analysis) return
      const jobId = res.jobId ?? last.jobId
      const restoredAddress = res.address || last.address || ''
      setAnalysisResult(res.analysis as AnalyzeData)
      setActiveAnalysis({ jobId, address: restoredAddress })
      setAddress(restoredAddress)
      try { localStorage.setItem(LAST_ANALYSIS_KEY, JSON.stringify({ jobId, address: restoredAddress, savedAt: Date.now() })) } catch { /* ignore */ }
      setPhase('ready')
      setRestoringReport(false)
    }

    void resumeReport().catch(() => {}).finally(() => {
      if (!isCancelled()) setRestoringReport(false)
    })
    return () => { cancelled = true }
  }, [analysisResult, activeAnalysis, setAnalysisResult, setActiveAnalysis])

  // ─── SSE Event Handler ────────────────────────────────────────────────────

  const lastEventAtRef = useRef(0)
  const handleEnrichmentEvent = useCallback((event: EnrichmentEvent) => {
    lastEventAtRef.current = Date.now()
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

      case 'geo_done': {
        if (isAiOnly) break
        // Live pocket reveal — stamp each comp's census geography + pocket
        // tier so the map colors pins by block-group/tract/off-pocket.
        const geoComps = (data.comps ?? []) as Array<{ id: string; censusTract: string | null; censusBlockGroup: string | null; pocketTier: string }>
        if (geoComps.length) {
          const byId = new Map(geoComps.map((g) => [String(g.id), g]))
          setAnalysisResult((prev) => prev?.comps?.items ? ({
            ...prev,
            comps: {
              ...prev.comps,
              items: prev.comps.items.map((c) => {
                const g = byId.get(String((c as { id?: unknown }).id))
                return g ? { ...c, censusTract: g.censusTract, censusBlockGroup: g.censusBlockGroup, pocketTier: g.pocketTier } : c
              }),
            },
          } as AnalyzeData) : prev)
        }
        const pm = data.pocketMedianPpsf
        setEvalProgress(`${data.pocketCount ?? 0} comp(s) in your block group${pm ? ` · pocket median $${pm}/sqft` : ''}`)
        // The pocket line holds until the picks land on the typescript lane —
        // bookkeeping ticks would otherwise erase it inside a second.
        if (data.harness === 'typescript') pocketShownRef.current = true
        break
      }

      case 'appraiser_done': {
        // Seat finished — highlight the picks on the map and surface the ARV
        // before the full report lands.
        const pickIds = new Set(((data.selectedCompIds ?? []) as string[]).map(String))
        if (pickIds.size) {
          setAnalysisResult((prev) => prev?.comps?.items ? ({
            ...prev,
            comps: {
              ...prev.comps,
              items: prev.comps.items.map((c) =>
                pickIds.has(String((c as { id?: unknown }).id)) ? { ...c, picked: true } : c),
            },
          } as AnalyzeData) : prev)
        }
        if (data.arv) {
          setEvalProgress(`Picked ${pickIds.size || 0} comp(s) · ARV $${Number(data.arv).toLocaleString()}${data.conf ? ` (${data.conf})` : ''}`)
          picksShownRef.current = true
        }
        break
      }

      // Progress is reset at run start; clearing here would wipe the
      // geo_done pocket line that lands before evaluation starts.
      case 'evaluation_started':
        if (!isAiOnly) setStreamingStep('evaluating')
        break

      case 'eval_progress': {
        // Permit stages go to the Permits row; every other message is the evaluation's own label
        const permitStage = permitProgressFromEvent(data)
        if (permitStage) setPermitProgress(permitStage)
        // The picks/ARV line holds until completion — phase-2 bookkeeping
        // ticks would otherwise replace it within milliseconds. The pocket
        // line gets the same hold on the typescript lane (no per-comp reads
        // follow it there; other lanes keep their live ticks).
        else if (typeof data.message === 'string' && !picksShownRef.current && !pocketShownRef.current) setEvalProgress(data.message)
        break
      }

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

  // Stall watchdog — if the pipeline goes silent mid-run (e.g. a dev-server
  // reload killed the worker isolate), surface an error instead of spinning
  // forever. 4 min silence is comfortably past any single step's duration.
  useEffect(() => {
    if (phase !== 'fetching') return
    const id = setInterval(() => {
      if (lastEventAtRef.current > 0 && Date.now() - lastEventAtRef.current > 4 * 60_000) {
        setPhase('idle')
        setEnrichmentStreamUrl(null)
        setError('Analysis stalled — the run may have been interrupted. Re-run to retry.')
      }
    }, 30_000)
    return () => clearInterval(id)
  }, [phase])

  // ─── Evaluation Hook ─────────────────────────────────────────────────────

  const {
    authoritativeData,
    settingsHook,
    recalcData,
    compOverride,
    handleToggleComp,
    handleResetComps,
    handlePinTier,
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
        comps: analysisResult.comps as unknown as { items: Array<Record<string, unknown>> },
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

  // Stable props for the evaluation atom — inline objects/callbacks would
  // retrigger the sync effect on every render and rewrite the atom.
  const evalFeedback = useMemo(() => isReady ? {
    appliedFilters: analysisResult?.appliedSettings?.filters ?? null,
    fallbackUsed: analysisResult?.report?.arv?.compPool?.fallbackUsed ?? null,
    fallbackReason: analysisResult?.report?.arv?.compPool?.fallbackReason ?? null,
    jobId: analysisResult?.meta?.analysisId ?? null,
    subjectAddress: analysisResult?.subject?.address ?? null,
  } : null, [isReady, analysisResult])
  const openSettings = useCallback(() => setSettingsOpen(true), [setSettingsOpen])
  const handleCompClick = useCallback((comp: CompItem) => {
    setComparisonComp(comp)
    setComparisonOpen(true)
  }, [setComparisonComp, setComparisonOpen])
  const handlePermitsPulled = useCallback((a: AnalyzeData) => setAnalysisResult(a), [setAnalysisResult])

  useEvaluationSync({
    evaluation: { isRecalculated, recalcData, compOverride, handleToggleComp, handleResetComps, handlePinTier },
    subject: renderData?.subject,
    displayValuation: isReady ? displayValuation : undefined,
    effectiveComps: isReady ? effectiveComps : undefined,
    feedback: evalFeedback,
    aiAnalyzing,
    isStreaming: streamingStep !== 'idle' && streamingStep !== 'done',
    marketContext,
    aiReport,
    onOpenSettings: openSettings,
    onCompClick: handleCompClick,
    onRunAiAnalysis: handleRunAiAnalysis,
    onUndoAiSelection: aiAnalysisDone ? handleUndoAiSelection : undefined,
    onPermitsPulled: handlePermitsPulled,
    arvOverride: settingsHook.settings.arvOverride,
    arvAdjustmentRules: settingsHook.settings.arvAdjustmentRules,
    arvAdjustments: settingsHook.settings.arvAdjustments,
    onArvOverride: settingsHook.setArvOverride,
    onArvAdjustment: settingsHook.setArvAdjustment,
  })

  // ─── Analysis Handler ────────────────────────────────────────────────────

  // Core analysis runner. `forceFresh` bypasses the 21-day eval-result cache —
  // used when the user explicitly picks "New Analysis" on a known address.
  const runAnalysis = useCallback(async (forceFresh = false, targetAddress?: string) => {
    cancelRestore()
    // Autocomplete select fires in the same tick as onChange — the state
    // read would be a beat stale, so the picked address threads through.
    const target = (targetAddress ?? address).trim()
    // Explicit rerun with results on screen: keep them mounted so the page
    // doesn't blank for the whole pipeline — SSE events overwrite them
    // progressively as fresh data arrives.
    const keepResults = forceFresh && analysisResult !== null
    if (!keepResults) {
      clearAnalysis()
    }
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
    setEvalProgress(null)
    picksShownRef.current = false
    pocketShownRef.current = false
    // Last run's comp grid doesn't linger under the new run's status line.
    setAnalysisResult((prev) => prev?.comps ? ({ ...prev, comps: { ...prev.comps, items: [] } } as AnalyzeData) : prev)
    setPermitProgress(null)
    setPhase('fetching')
    lastEventAtRef.current = Date.now()

    const t0 = Date.now()
    try {
      const overrides = appraisalFilters.length > 0 ? {
        filters: appraisalFilters,
        adjustments: appraisalAdjustments,
      } : undefined

      const response = await queueAnalysis({
        address: target,
        // maxComps omitted — pool size is system config on the API
        // (COMPARABLE_CANDIDATE_LIMIT, provider max 100), not a client choice.
        searchOptions: { radiusMiles: 1, monthsBack: 12 },
        skipCache: skipCache || forceFresh,
        marketData: { enabled: true },
        arvThresholdPercent: arvThreshold,
        asIsThresholdPercent: asIsThreshold,
        appraisalOverrides: overrides,
        llmAnalysis: aiEnabled ? { enabled: true } : undefined,
      })

      if (response.success) {
        if (response.alreadyRunning) {
          toast.info('Analysis already running — joining the live evaluation')
        }
        setActiveAnalysis({ jobId: response.jobId ?? '', address: target })
        setAnalysisState({ ...initialAnalysisState, jobId: response.jobId ?? null, status: 'processing' })
        try {
          localStorage.setItem(LAST_ANALYSIS_KEY, JSON.stringify({ jobId: response.jobId ?? '', address: target, savedAt: Date.now() }))
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
      if (reloadForStaleAction(err)) return
      setPhase('idle')
      setError(err instanceof Error ? err.message : 'Failed to start analysis')
    }
  }, [address, skipCache, arvThreshold, asIsThreshold, appraisalFilters, appraisalAdjustments, cancelRestore, clearAnalysis, setActiveAnalysis, setAnalysisResult, setAnalysisState, analysisResult])

  // ─── Offer workflows (Devin listener session + engine) ───────────────
  // The hero owns the busy→result animation; this just returns the outcome.
  const handleOfferWorkflow = useCallback(async (workflow: OfferWorkflow, offerPrice?: number): Promise<{ ok: boolean }> => {
    const propertyAddress = analysisResult?.subject?.address ?? address
    if (!propertyAddress) return { ok: false }
    const purchasePrice = offerPrice ?? displayValuation?.wholesalePrice ?? displayValuation?.buyPrice
    if (workflow === 'prep_offer' && !(purchasePrice && purchasePrice > 0)) return { ok: false }
    const deal = buildDealContext(
      workflow,
      displayValuation ? { ...displayValuation, wholesalePrice: purchasePrice ?? displayValuation.wholesalePrice } : null,
      analysisResult?.comps?.items,
      compOverride?.isManual ? compOverride.selectedCompKeys : undefined,
    )
    const res = workflow === 'prep_offer'
      ? await dispatchOfferPrep({
          leadId: analysisResult?.leadId ?? undefined,
          propertyAddress,
          purchasePrice: purchasePrice!,
          opportunityId: analysisResult?.opportunityId ?? undefined,
          deal,
        })
      : await declineOffer({ leadId: analysisResult?.leadId ?? undefined, propertyAddress, purchasePrice: purchasePrice ?? undefined, deal })
    return { ok: res.ok }
  }, [analysisResult, address, displayValuation, compOverride])

  // Entry point — checks for existing reports first
  const handleAnalyze = useCallback(async (targetAddress?: string) => {
    const target = (targetAddress ?? address).trim()
    if (!target) return
    cancelRestore()

    try {
      const { reports } = await getReportsByProperty({ address: target })
      if (reports.length > 0) {
        setExistingReports(reports)
        setShowExistingDialog(true)
        return
      }
    } catch {
      // Lookup failed — proceed with analysis
    }

    runAnalysis(false, target)
  }, [address, runAnalysis, cancelRestore])

  // Auto-retry after "Apply & Retry"
  useEffect(() => {
    if (pendingRetry) {
      setPendingRetry(false)
      handleAnalyze()
    }
  }, [pendingRetry, handleAnalyze])

  // ?address=<addr> — browser-extension / shared-link entry point.
  // Prefills the search bar and runs through the normal flow, so the
  // existing-report dialog still intercepts when a report already exists.
  const pendingUrlAddress = useRef<string | null>(null)
  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get('address')?.trim()
    if (q) {
      pendingUrlAddress.current = q
      setAddress(q)
      setSearchExpanded(true)
    }
  }, [])
  useEffect(() => {
    if (pendingUrlAddress.current && pendingUrlAddress.current === address) {
      pendingUrlAddress.current = null
      handleAnalyze()
    }
  }, [address, handleAnalyze])

  const handleCancel = useCallback(() => {
    setPhase('idle')
    cancelAnalysis()
  }, [cancelAnalysis])

  // Overlays are built on first open, then kept mounted so they can animate out
  const mountSettings = useStayMounted(settingsOpen)
  const mountComparison = useStayMounted(comparisonOpen)
  const mountExisting = useStayMounted(showExistingDialog)
  usePreloadOnIdle(loadCompComparisonDialog)

  // ─── Layout Flags ────────────────────────────────────────────────────────

  const isSearchCollapsed = isActive && !searchExpanded
  const hasMapData = isValidCoordinate({ lat: renderData?.subject?.latitude, lng: renderData?.subject?.longitude })
  const showTwoColumn = isActive && hasMapData

  // ─── Render ──────────────────────────────────────────────────────────────

  return (
    <div className={cn('playground-bg -m-4 sm:-m-6 lg:-m-8', showTwoColumn ? 'min-h-screen lg:h-[100dvh] flex flex-col lg:overflow-hidden' : 'min-h-screen p-4 sm:p-6 lg:p-8 space-y-6')}>
      {/* PROTOTYPE: switchable look, only while this page is open (see SkinPreview) */}
      <SkinPreview />
      {/* Search bar + controls — collapsed state renders as a fixed-height header
          band whose bottom border lands at 64px, aligned with the sidebar logo divider */}
      <div className={cn(
        showTwoColumn
          ? isSearchCollapsed
            ? 'px-4 sm:px-6 lg:px-4 pt-3 pb-1 lg:pt-4 lg:pb-0 lg:h-20 lg:flex lg:items-center lg:space-y-0 lg:border-b lg:border-border space-y-3 flex-shrink-0'
            : 'px-4 sm:px-6 lg:px-4 pt-3 pb-1 lg:pt-8 space-y-3 flex-shrink-0'
          : 'space-y-6'
      )}>
      {phase === 'idle' && !error && <PageHeader title="Property Search" />}

      {/* Input Form — collapses to compact bar once active. The bar's input
          stays editable: type or pick a suggestion and the run starts on
          its own — Enter also runs. The chevron still opens the full card
          for Advanced options. */}
      {isSearchCollapsed ? (
        <ReportToolbar
          allowOverflow
          lead={
            <div className={REPORT_TOOLBAR_TILE}>
              <Search className="w-3.5 h-3.5 text-primary" />
            </div>
          }
          title={
            <AddressAutocomplete
              value={address}
              onChange={(value) => { cancelRestore(); setAddress(value) }}
              onSelect={(result) => { if (!isFetching) handleAnalyze(result.address) }}
              onSubmit={() => { if (!isFetching && address.trim()) handleAnalyze() }}
              className="flex-1"
              disabled={isFetching}
            />
          }
          subline={
            <>
              {error && (
                <div className="text-xs text-red-500 mt-0.5 truncate">{error}</div>
              )}
              {aiAnalyzing && streamingStep === 'done' && !error && (
                <div className="text-xs text-primary mt-0.5 flex items-center gap-1.5">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  AI selecting best comps...
                </div>
              )}
            </>
          }
        >
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
        </ReportToolbar>
      ) : (
        <div
          data-surface="card"
          className="relative z-20 border border-border/60 bg-background shadow-sm corner-accents corner-accents-bottom"
        >
          {/* Title and the collapse arrow · only while a property is loaded. With nothing
              loaded the page header above is the title. */}
          {isActive && (
            <div className="px-6 py-3 border-b border-border flex items-center justify-between gap-3">
              <h2 className="text-heading-sm text-foreground">Search an address</h2>
              <button
                type="button"
                onClick={() => setSearchExpanded(false)}
                aria-label="Collapse search"
                className="p-1.5 rounded-lg hover:text-foreground hover:bg-secondary transition-colors text-foreground-tertiary"
              >
                <ChevronDown className="w-4 h-4 rotate-180" />
              </button>
            </div>
          )}
          <div className="px-6 py-5 space-y-4">
            <div className="flex gap-3">
              <AddressAutocomplete
                value={address}
                onChange={(value) => { cancelRestore(); setAddress(value) }}
                onSelect={(result) => {
                  if (!isFetching) {
                    handleAnalyze(result.address)
                    setSearchExpanded(false)
                  }
                }}
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
                <Button data-action="run" onClick={() => { handleAnalyze(); setSearchExpanded(false) }} disabled={isFetching || !address.trim()}>
                  <Play className="w-4 h-4 mr-2" />
                  Run
                </Button>
              )}
            </div>
            <button
              type="button"
              onClick={() => setShowAdvanced((v) => !v)}
              className="text-[11px] text-foreground-tertiary hover:text-foreground hover:bg-secondary transition-colors flex items-center gap-1"
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

      {/* One loader type for the whole opening sequence: the same skeleton as the route and the dynamic layout */}
      {restoringReport && (
        <div role="status" aria-busy="true" className="space-y-4">
          <p className="text-caption text-foreground-tertiary">Restoring your last report. You can start a new search now.</p>
          <AnalysisPageSkeleton />
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

      {/* Loading skeleton — two-column layout matching the final result.
          Suppressed during reruns that keep prior results on screen. */}
      {isFetching && !hasResult && <AnalysisPageSkeleton />}

      {/* Analysis layout — map + valuation on left, comps on right.
          During an explicit rerun the previous result stays mounted
          (fetching + hasResult) while SSE streams the fresh data in. */}
      {(isReady || (isFetching && hasResult)) && (
        <AnalysisPageLayout
          mapComps={effectiveComps ?? analysisResult?.comps}
          onMarkerSelect={handleMarkerSelect}
          activeMarkerKey={activeMarkerKey}
          riskFlags={authoritativeData?.riskFlags ?? renderData?.riskFlags}
          floodZone={authoritativeData?.floodZone ?? renderData?.floodZone}

          valuationCardRef={valuationCardRef}
          onRerun={() => runAnalysis(true)}
          rerunning={isFetching}
          busy={isFetching || (streamingStep !== 'idle' && streamingStep !== 'done')}
          onOfferWorkflow={handleOfferWorkflow}
          statusLabel={
            streamingStep === 'idle' && isFetching ? 'Starting analysis...'
            : streamingStep === 'searching' ? 'Searching property...'
            : streamingStep === 'subject' ? 'Loading comparables...'
            : streamingStep === 'comps' ? <EvalProgressLabel fallback="Enriching comp details..." />
            : streamingStep === 'evaluating' ? <EvalProgressLabel />
            : null
          }
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
      {mountSettings && <EvaluationSettingsSheet
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
      />}

      {/* Subject vs Comp comparison dialog */}
      {mountComparison && <CompComparisonDialog
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
        proximityToggles={settingsHook.settings.proximityAdjustments}
        onProximityChange={settingsHook.updateProximityAdjustments}
      />}

      {/* Existing Reports Dialog */}
      {mountExisting && <ExistingReportsDialog
        open={showExistingDialog}
        onOpenChange={setShowExistingDialog}
        reports={existingReports}
        onNewAnalysis={() => runAnalysis(true)}
      />}
    </div>
  )
}
