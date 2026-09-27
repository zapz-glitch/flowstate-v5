'use client'

import { isValidCoordinate } from '@/lib/property-map-geometry'

import { useState, useEffect, useCallback, useMemo, useRef, use } from 'react'
import Link from 'next/link'
import dynamic from 'next/dynamic'
import ReportLoading from './loading'
import { useRouter } from 'next/navigation'
import { ArrowLeft, ArrowRight, Share2, RefreshCw, AlertTriangle, History, Loader2, ListChecks, FileSignature, CircleSlash, Check, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { CopyButton } from '@/components/ui/copy-button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet'
import { cn } from '@/lib/utils'
import { getReportHistory, type ReportHistoryEntry } from '@/lib/client-api'
import { useAutoSave } from '@/hooks/use-auto-save'
import { getSavedReport, runCompSelection, type OfferWorkflow } from '@/lib/client-api'
import { dispatchOfferPrep, declineOffer } from '../../analyze/actions'
import { useAnalysisEvaluation } from '@/hooks/use-analysis-evaluation'
import { toast } from 'sonner'
import { DownloadReportButton } from '@/components/report/DownloadReportButton'
import { UpdateCrmButton } from '@/components/report/UpdateCrmButton'
import { AnalysisPageLayout } from '@/components/analysis/AnalysisPageLayout'
import { RealtorNotesCard } from '@/components/analysis/RealtorNotesCard'
import type { AnalyzeData, CompItem } from '@/components/analysis'
import { queueAnalysis, type AnalyzeData as ActionAnalyzeData } from '@/app/(dashboard)/dashboard/analyze/actions'
import { reloadForStaleAction } from '@/lib/server-action'
import { useMapInteraction } from '@/hooks/use-map-interaction'
import { useEvaluationSync } from '@/hooks/use-evaluation-sync'
import { useEnrichmentSSE, type EnrichmentEvent } from '@/hooks/use-enrichment-sse'
import { getBatchStatus } from '@/lib/batch-client'

const EvaluationSettingsSheet = dynamic(() => import('@/components/report/EvaluationSettingsSheet').then((mod) => mod.EvaluationSettingsSheet))
const ShareReportDialog = dynamic(() => import('@/components/report/ShareReportDialog').then((mod) => mod.ShareReportDialog))
const ReportHistoryTimeline = dynamic(() => import('@/components/report/ReportHistoryTimeline').then((mod) => mod.ReportHistoryTimeline))
const CompComparisonDialog = dynamic(() => import('@/components/analysis/CompComparisonDialog').then((mod) => mod.CompComparisonDialog))

// ─── Give Offer fallback — queue disposition when the report can't load ────

function QueueFallback({ queue }: {
  queue: {
    node: React.ReactNode
    onDecided: () => void
    fallback?: { leadId: string | null; address: string; wholesalePrice: number | null; listPrice?: number | null; opportunityId?: string | null }
  }
}) {
  const item = queue.fallback!
  const [busy, setBusy] = useState<'prep_offer' | 'no_margin' | null>(null)
  const [result, setResult] = useState<{ ok: boolean; label: string } | null>(null)

  // Offers dispatch at the queue's computed price only — no overrides.
  const canOffer = item.wholesalePrice != null && item.wholesalePrice > 0

  const decide = async (workflow: 'prep_offer' | 'no_margin') => {
    if (busy) return
    setBusy(workflow)
    try {
      const res = workflow === 'prep_offer'
        ? await dispatchOfferPrep({
            leadId: item.leadId ?? undefined,
            propertyAddress: item.address,
            purchasePrice: item.wholesalePrice ?? 0,
            opportunityId: item.opportunityId ?? undefined,
          })
        : await declineOffer({ leadId: item.leadId ?? undefined, propertyAddress: item.address })
      if (!res.ok) {
        setResult({ ok: false, label: res.error ?? 'Dispatch failed' })
        return
      }
      setResult({
        ok: true,
        label: workflow === 'prep_offer' ? (res.idempotent ? 'Already dispatched' : 'Offer prep dispatched') : 'Decline recorded',
      })
      queue.onDecided()
    } catch {
      setResult({ ok: false, label: 'Dispatch failed' })
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="playground-bg -mx-4 sm:-mx-6 lg:-mx-8 min-h-screen flex flex-col">
      {queue.node}
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="w-full max-w-md border border-border/60 bg-background shadow-sm corner-accents corner-accents-bottom">
          <div className="px-4 pt-4 pb-3 border-b border-border">
            <div className="text-[9px] uppercase tracking-wider text-foreground-tertiary mb-1">Ready for offer</div>
            <div className="text-base font-semibold">{item.address}</div>
            <div className="text-xs text-foreground-secondary mt-1 tabular-nums">
              List <b className="text-foreground">{item.listPrice != null ? `$${item.listPrice.toLocaleString('en-US')}` : '—'}</b>
            </div>
            {item.wholesalePrice != null && (
              <div className="text-xs text-foreground-secondary mt-1 tabular-nums">
                Wholesale <b className="text-foreground">${item.wholesalePrice.toLocaleString('en-US')}</b>
              </div>
            )}
            <div className="text-[10px] text-foreground-tertiary mt-1">
              Report data unavailable in this environment — the disposition still dispatches normally.
            </div>
          </div>
          <div className="px-4 py-3">
            {result ? (
              <div className={cn('flex items-center gap-1.5 text-xs font-medium animate-in fade-in duration-300',
                result.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500')}>
                {result.ok ? <Check size={14} /> : <X size={14} />}
                {result.label}
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => decide('prep_offer')}
                  disabled={busy != null || !canOffer}
                  className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded border border-emerald-600/40 text-xs font-medium text-emerald-600 hover:bg-emerald-500/10 transition-colors disabled:opacity-50 dark:text-emerald-400"
                  title={canOffer ? `Prep offer at $${item.wholesalePrice!.toLocaleString('en-US')}` : 'No computed offer price'}
                >
                  {busy === 'prep_offer' ? <RefreshCw size={13} className="animate-spin" /> : <FileSignature size={13} />}
                  Prep offer
                </button>
                <button
                  type="button"
                  onClick={() => decide('no_margin')}
                  disabled={busy != null}
                  className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded border border-border text-xs text-foreground-secondary hover:bg-secondary transition-colors disabled:opacity-50"
                >
                  {busy === 'no_margin' ? <RefreshCw size={13} className="animate-spin" /> : <CircleSlash size={13} />}
                  No margin
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Main Page ──────────────────────────────────────────────────────────────

export default function DashboardReportPage({ params, queue }: {
  params: Promise<{ jobId: string }>
  /** Give Offer queue chrome — toolbar node + advance callback after disposition.
   *  `fallback` renders a disposition card when the report itself can't load
   *  (e.g. queue item's jobId lives in a different env's DB). */
  queue?: {
    node: React.ReactNode
    onDecided: () => void
    /** False while the queue fetch is still in flight — an unresolved
     *  fallback doesn't mean "not found" yet. */
    loaded?: boolean
    /** Queue controls rendered inside the header card (loaded view) —
     *  a standalone strip sits off the shared band baseline. */
    inline?: React.ReactNode
    /** Where the card's back tile points in queue context */
    backHref?: string
    fallback?: { leadId: string | null; address: string; wholesalePrice: number | null; listPrice?: number | null; opportunityId?: string | null }
    /** Live realtor notes from the queue item — fallback until the report
     *  carries its own `sellerNotes` snapshot. */
    notes?: string[] | null
  }
}) {
  const { jobId } = use(params)

  const [report, setReport] = useState<{
    jobId: string
    address: string
    createdAt: string
    analysis: AnalyzeData
  } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [shareOpen, setShareOpen] = useState(false)
  const [refreshOpen, setRefreshOpen] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [historyEntries, setHistoryEntries] = useState<ReportHistoryEntry[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [refreshResult, setRefreshResult] = useState<{
    type: 'success' | 'no_change' | 'error'
    message: string
    changes?: string[]
  } | null>(null)
  const [refreshStreamUrl, setRefreshStreamUrl] = useState<string | null>(null)
  const [refreshToken, setRefreshToken] = useState<string | null>(null)
  const [aiAnalyzing, setAiAnalyzing] = useState(false)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [marketContext, setMarketContext] = useState<Record<string, any> | null>(null)
  const [aiReport, setAiReport] = useState<{ summary: string; selected: number; total: number; model: string } | null>(null)
  const [aiAnalysisDone, setAiAnalysisDone] = useState(false)
  const preAiCompsRef = useRef<unknown>(null)

  const analyzeData = report?.jobId === jobId ? report.analysis : null

  // Realtor notes — persisted snapshot wins (it carries classified rehab
  // intel); the live queue item's notes fill in for reports that predate
  // the sellerNotes field.
  const realtorNotesCard = useMemo(() => {
    const persisted = analyzeData?.sellerNotes?.notes ?? null
    const queued = queue?.notes ?? null
    const entries = persisted ?? (queued ?? [])
      .map((t, i) => ({
        id: `queue-${i}`,
        createdAt: '',
        text: t.replace(/^\s*FLOWSTATE CONVERSATION LOG\s*-?\s*/, ''),
      }))
    if (!entries.length && !analyzeData?.rehabAdvisories?.length && !analyzeData?.rehabAdditions?.length) {
      return null
    }
    return (
      <RealtorNotesCard
        notes={entries}
        advisories={analyzeData?.rehabAdvisories}
        additions={analyzeData?.rehabAdditions}
        fetchedAt={analyzeData?.sellerNotes?.fetchedAt}
      />
    )
  }, [analyzeData, queue?.notes])

  // ─── Batch review mode — ?batch=<id>&conf=<bucket> ──────────────────────
  // When opened from the batch list, load that batch's review queue so the
  // user can step through reports with prev/next and auto-advance on Notify.
  const router = useRouter()
  const [batchQueue, setBatchQueue] = useState<{
    batchId: string
    conf: string
    items: Array<{ jobId: string; address: string; feedbackStatus?: string | null }>
  } | null>(null)

  useEffect(() => {
    const qs = new URLSearchParams(window.location.search)
    const bId = qs.get('batch')
    const conf = qs.get('conf') ?? 'all'
    if (!bId) { setBatchQueue(null); return }
    let cancelled = false
    setBatchQueue(null)
    getBatchStatus(bId).then((job) => {
      if (cancelled || !job?.results) return
      const items = job.results
        .filter((r) => r.status === 'completed' && r.jobId)
        .filter((r) => {
          if (conf === 'all') return true
          if (conf === 'validated') return r.feedbackStatus === 'validated'
          if (conf === 'improve') return r.feedbackStatus === 'improve'
          const c = r.confidence?.toLowerCase()
          const bucket = c === 'high' || c === 'medium' || c === 'low' ? c : 'unrated'
          return bucket === conf
        })
        .map((r) => ({ jobId: r.jobId!, address: r.address, feedbackStatus: r.feedbackStatus }))
      if (!cancelled) setBatchQueue({ batchId: bId, conf, items })
    }).catch(() => { if (!cancelled) setBatchQueue(null) })
    return () => { cancelled = true }
  }, [jobId])

  const navIndex = batchQueue ? batchQueue.items.findIndex((q) => q.jobId === jobId) : -1
  const prevItem = batchQueue && navIndex > 0 ? batchQueue.items[navIndex - 1] : null
  const nextItem = batchQueue && navIndex >= 0 && navIndex < batchQueue.items.length - 1 ? batchQueue.items[navIndex + 1] : null
  const nextUnreviewed = batchQueue?.items.find((q, i) => i > navIndex && !q.feedbackStatus) ?? nextItem
  const reviewedCount = batchQueue?.items.filter((q) => q.feedbackStatus).length ?? 0
  const batchNavHref = (item: { jobId: string }) =>
    `/dashboard/reports/${item.jobId}?batch=${batchQueue!.batchId}&conf=${batchQueue!.conf}`

  // Auto-advance to the next unreviewed report after stamping
  const handleFeedbackSubmitted = useCallback(() => {
    if (nextUnreviewed && batchQueue) {
      router.push(batchNavHref(nextUnreviewed))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nextUnreviewed, batchQueue, router])

  // ─── Back-button trap: overlays push history; back closes topmost ────────
  const overlayStackRef = useRef<string[]>([])
  const suppressPopRef = useRef(false)
  const overlayClosersRef = useRef<Record<string, () => void>>({})

  useEffect(() => {
    const onPop = () => {
      if (suppressPopRef.current) { suppressPopRef.current = false; return }
      const top = overlayStackRef.current.pop()
      if (top) overlayClosersRef.current[top]?.()
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

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
    data: analyzeData,
    stickyBarRootMargin: '-60px 0px 0px 0px',
    aiAnalyzing,
  })

  // ─── History loading ────────────────────────────────────────────────────
  const loadHistory = useCallback(async () => {
    setHistoryLoading(true)
    try {
      const { history } = await getReportHistory(jobId)
      setHistoryEntries(history)
    } catch {
      // Failed to load history
    } finally {
      setHistoryLoading(false)
    }
  }, [jobId])

  useEffect(() => {
    if (historyOpen) loadHistory()
  }, [historyOpen, loadHistory])

  // ─── Auto-save on evaluation/comp changes ──────────────────────────────
  const { autoSaveStatus } = useAutoSave({
    jobId,
    analysisData: analyzeData,
    displayValuation,
    recalcData,
    compOverride,
    settingsHook,
    aiReport,
    preAiComps: preAiCompsRef.current,
    onSaved: historyOpen ? loadHistory : undefined,
  })

  const reportRequestRef = useRef(0)
  const fetchReport = useCallback(async () => {
    const requestId = ++reportRequestRef.current
    try {
      setLoading(true)
      setError(null)
      const data = await getSavedReport(jobId)
      if (requestId !== reportRequestRef.current) return
      const analysis = data.analysis as AnalyzeData & {
        aiReport?: { summary: string; selected: number; total: number; model: string }
        preAiComps?: unknown
      }
      setReport({
        jobId: data.jobId,
        address: data.address,
        createdAt: data.createdAt,
        analysis,
      })
      setAiReport(null)
      setAiAnalysisDone(false)
      preAiCompsRef.current = null
      // Restore persisted AI analysis report and pre-AI comps for undo
      if (analysis.aiReport) {
        setAiReport(analysis.aiReport)
        setAiAnalysisDone(true)
        if (analysis.preAiComps) {
          preAiCompsRef.current = analysis.preAiComps
        }
      }
    } catch {
      if (requestId === reportRequestRef.current) setError('Report not found')
    } finally {
      if (requestId === reportRequestRef.current) setLoading(false)
    }
  }, [jobId])

  useEffect(() => {
    fetchReport()
    return () => { reportRequestRef.current++ }
  }, [fetchReport])

  // SSE handler for refresh streaming
  const handleRefreshEvent = useCallback((event: EnrichmentEvent) => {
    const { event: eventType, data } = event
    switch (eventType) {
      case 'subject_found':
      case 'comps_found':
        // Intermediate streaming events — refresh spinner stays
        break
      case 'evaluation_complete':
        if (data.updatedResult && report) {
          setReport({
            jobId: data.updatedResult.meta?.analysisId ?? jobId,
            address: report.address,
            createdAt: new Date().toISOString(),
            analysis: data.updatedResult as AnalyzeData,
          })
          setRefreshing(false)
          setRefreshResult({ type: 'success', message: 'Data refreshed — evaluation complete' })
          setTimeout(() => setRefreshResult(null), 10000)
        }
        break
      case 'llm_started':
        setAiAnalyzing(true)
        break
      case 'llm_complete':
        setAiAnalyzing(false)
        setAiAnalysisDone(true)
        if (data.updatedResult && report) {
          // Snapshot current comps before AI overwrites them (for undo)
          if (!preAiCompsRef.current && report.analysis?.comps) {
            preAiCompsRef.current = report.analysis.comps
          }
          // Only merge comp selection from AI — let client-side recalc derive valuation
          const updated = data.updatedResult as AnalyzeData
          setReport((prev) => {
            if (!prev) return prev
            return {
              ...prev,
              analysis: {
                ...prev.analysis,
                comps: updated.comps,
              },
            }
          })
          setRefreshResult({ type: 'success', message: 'AI comp selection updated' })
          setTimeout(() => setRefreshResult(null), 5000)
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
          setReport((prev) => prev ? { ...prev, analysis: { ...prev.analysis, riskFlags: data.riskFlags as string[] } } : prev)
        }
        break
      case 'enrichment_done':
        setAiAnalyzing(false)
        setRefreshing(false)
        setRefreshStreamUrl(null)
        setRefreshToken(null)
        break
      case 'error':
        setAiAnalyzing(false)
        if (data.message) {
          setRefreshResult({ type: 'error', message: data.message as string })
          setTimeout(() => setRefreshResult(null), 5000)
        }
        setRefreshing(false)
        break
    }
  }, [report, jobId])

  useEnrichmentSSE({
    streamUrl: refreshStreamUrl,
    token: refreshToken,
    onEvent: handleRefreshEvent,
  })

  // ─── Offer workflows (Devin listener session + engine) ───────────────
  // The hero owns the busy→result animation; this just returns the outcome.
  const handleOfferWorkflow = useCallback(async (workflow: OfferWorkflow, offerPrice?: number): Promise<{ ok: boolean; label: string }> => {
    if (!report?.address) return { ok: false, label: 'No address' }
    const purchasePrice = offerPrice ?? displayValuation?.wholesalePrice ?? displayValuation?.buyPrice
    if (workflow === 'prep_offer' && !(purchasePrice && purchasePrice > 0)) return { ok: false, label: 'Valuation incomplete' }
    const res = workflow === 'prep_offer'
      ? await dispatchOfferPrep({
          leadId: analyzeData?.leadId ?? undefined,
          propertyAddress: report.address,
          purchasePrice: purchasePrice!,
          opportunityId: analyzeData?.opportunityId ?? undefined,
        })
      : await declineOffer({ leadId: analyzeData?.leadId ?? undefined, propertyAddress: report.address })
    if (!res.ok) return { ok: false, label: res.error ?? 'Dispatch failed' }
    queue?.onDecided()
    return workflow === 'prep_offer'
      ? { ok: true, label: res.idempotent ? 'Already dispatched' : 'Offer prep dispatched' }
      : { ok: true, label: 'Decline recorded' }
  }, [report?.address, analyzeData, displayValuation, queue])

  const handleRefresh = useCallback(async () => {
    if (!report?.address) return
    setRefreshing(true)
    setRefreshOpen(false)
    setRefreshResult(null)

    try {
      const response = await queueAnalysis({
        address: report.address,
        existingJobId: jobId,
        leadId: analyzeData?.leadId ?? undefined,
        // maxComps omitted — API applies the configured provider-max limit.
        searchOptions: { radiusMiles: 1, monthsBack: 12 },
        skipCache: true,
        llmAnalysis: { enabled: true },
      })
      if (response.success) {
        // Connect to SSE for streaming updates
        if (response.enrichment) {
          setRefreshStreamUrl(response.enrichment.streamUrl)
          setRefreshToken(response.enrichment.token)
        }
        // If sync result returned (legacy), apply directly
        if (response.result) {
          setReport({
            jobId: response.jobId ?? jobId,
            address: report.address,
            createdAt: new Date().toISOString(),
            analysis: response.result as AnalyzeData,
          })
          setRefreshing(false)
          setRefreshResult({ type: 'success', message: 'Data refreshed' })
          setTimeout(() => setRefreshResult(null), 10000)
        }
      } else {
        setRefreshResult({ type: 'error', message: response.error || 'Refresh failed' })
        setTimeout(() => setRefreshResult(null), 5000)
        setRefreshing(false)
      }
    } catch (err) {
      if (reloadForStaleAction(err)) return
      setRefreshResult({ type: 'error', message: err instanceof Error ? err.message : 'Refresh failed' })
      setTimeout(() => setRefreshResult(null), 5000)
      setRefreshing(false)
    }
  }, [report, jobId])

  // Map marker → scroll to card + comparison dialog
  const {
    activeMarkerKey,
    comparisonComp,
    setComparisonComp,
    comparisonOpen,
    setComparisonOpen,
    handleMarkerSelect,
  } = useMapInteraction(() =>
    (effectiveComps?.items ?? []) as CompItem[]
  )

  // ─── Back-button trap (cont.) — sync overlay flags with history stack ────
  useEffect(() => {
    overlayClosersRef.current = {
      comparison: () => setComparisonOpen(false),
      share: () => setShareOpen(false),
      refresh: () => setRefreshOpen(false),
      history: () => setHistoryOpen(false),
      settings: () => setSettingsOpen(false),
    }
    const flags: Array<[string, boolean]> = [
      ['comparison', comparisonOpen],
      ['share', shareOpen],
      ['refresh', refreshOpen],
      ['history', historyOpen],
      ['settings', settingsOpen],
    ]
    for (const [id, open] of flags) {
      const idx = overlayStackRef.current.lastIndexOf(id)
      if (open && idx === -1) {
        // Opened via UI → push a sentinel so Back closes it instead of leaving
        overlayStackRef.current.push(id)
        window.history.pushState({ overlay: id }, '')
      } else if (!open && idx !== -1) {
        // Closed via UI → consume the sentinel without closing another overlay
        overlayStackRef.current.splice(idx, 1)
        suppressPopRef.current = true
        window.history.back()
      }
    }
  }, [comparisonOpen, shareOpen, refreshOpen, historyOpen, settingsOpen])

  // Run AI comp selection on existing report — lightweight LLM-only call
  const handleRunAiAnalysis = useCallback(async () => {
    const analysis = report?.analysis
    if (!analysis?.subject || !analysis?.comps?.items?.length || aiAnalyzing) return
    setAiAnalyzing(true)
    try {
      // Snapshot current comps before AI overwrites them (for undo)
      if (!preAiCompsRef.current && analysis.comps) {
        preAiCompsRef.current = analysis.comps
      }
      const s = settingsHook.settings
      const response = await runCompSelection({
        subject: analysis.subject as Record<string, unknown>,
        comps: analysis.comps as { items: Array<Record<string, unknown>> },
        riskFlags: (analysis as Record<string, unknown>).riskFlags as string[] | undefined,
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
        setReport((prev) => {
          if (!prev) return prev
          return { ...prev, analysis: { ...prev.analysis, comps: response.updatedComps as typeof prev.analysis.comps } }
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
        handleResetComps()
      }
    } catch {
      preAiCompsRef.current = null
    } finally {
      setAiAnalyzing(false)
    }
  }, [report, aiAnalyzing, settingsHook.settings, handleResetComps])

  const handleUndoAiSelection = useCallback(() => {
    // Restore original math-based comp selection
    if (preAiCompsRef.current) {
      setReport((prev) => {
        if (!prev) return prev
        return { ...prev, analysis: { ...prev.analysis, comps: preAiCompsRef.current as typeof prev.analysis.comps } }
      })
      preAiCompsRef.current = null
    }
    handleResetComps()
    setAiReport(null)
    setAiAnalysisDone(false)
  }, [handleResetComps])

  // ─── Sync evaluation state to Jotai atoms ────────────────────────────────
  // Stable props — inline objects/callbacks would retrigger the sync effect
  // on every render and rewrite the atom.
  const evalFeedback = useMemo(() => ({
    appliedFilters: analyzeData?.appliedSettings?.filters ?? null,
    fallbackUsed: analyzeData?.report?.arv?.compPool?.fallbackUsed ?? null,
    fallbackReason: analyzeData?.report?.arv?.compPool?.fallbackReason ?? null,
    jobId,
    subjectAddress: report?.address ?? analyzeData?.subject?.address ?? null,
  }), [analyzeData, jobId, report?.address])
  const openSettings = useCallback(() => setSettingsOpen(true), [setSettingsOpen])
  const handleCompClick = useCallback((comp: CompItem) => {
    setComparisonComp(comp)
    setComparisonOpen(true)
  }, [setComparisonComp, setComparisonOpen])
  const handlePermitsPulled = useCallback(
    (a: ActionAnalyzeData) => setReport((prev) => (prev ? { ...prev, analysis: a } : prev)),
    [],
  )

  useEvaluationSync({
    evaluation: { isRecalculated, recalcData, compOverride, handleToggleComp, handleResetComps },
    subject: analyzeData?.subject,
    displayValuation,
    effectiveComps,
    feedback: evalFeedback,
    aiAnalyzing,
    marketContext,
    aiReport,
    jevOutcome: analyzeData?.jevOutcome ?? null,
    jevCompClassification: analyzeData?.jevCompClassification ?? null,
    jevAttributeScreen: analyzeData?.jevAttributeScreen ?? null,
    jevHybrid: analyzeData?.jevHybrid ?? null,
    onOpenSettings: openSettings,
    onCompClick: handleCompClick,
    onRunAiAnalysis: handleRunAiAnalysis,
    onUndoAiSelection: aiAnalysisDone ? handleUndoAiSelection : undefined,
    onFeedbackSubmitted: batchQueue ? handleFeedbackSubmitted : undefined,
    onPermitsPulled: handlePermitsPulled,
  })

  if (loading || (report && report.jobId !== jobId && !error)) {
    return (
      <div className="playground-bg -mx-4 sm:-mx-6 lg:-mx-8 min-h-screen">
        {queue?.node}
        <ReportLoading />
      </div>
    )
  }

  if (error || !report) {
    // In the Give Offer flow, the report row may live in another env's DB —
    // still let the user disposition the lead from its queue fields.
    if (queue?.fallback) {
      return <QueueFallback queue={queue} />
    }
    // Queue still loading — the item may resolve to a fallback once it
    // lands; keep the skeleton up instead of flashing "Report Not Found".
    if (queue && queue.loaded === false) {
      return (
        <div className="playground-bg -mx-4 sm:-mx-6 lg:-mx-8 min-h-screen">
          {queue.node}
          <ReportLoading />
        </div>
      )
    }
    return (
      <div className="flex items-center justify-center py-32">
        <div className="text-center space-y-2">
          <h1 className="text-heading-lg text-foreground">Report Not Found</h1>
          <p className="text-body text-foreground-tertiary">
            This report may have been removed or the link is invalid.
          </p>
          <Link href="/dashboard/reports" className="text-primary text-body-sm hover:underline">
            Back to Reports
          </Link>
        </div>
      </div>
    )
  }

  const analysis = authoritativeData ?? report.analysis

  const hasMapData = isValidCoordinate({ lat: analysis.subject?.latitude, lng: analysis.subject?.longitude })

  return (
    <div className={cn('playground-bg -m-4 sm:-m-6 lg:-m-8', hasMapData ? 'min-h-screen lg:h-[100dvh] flex flex-col lg:overflow-hidden' : 'min-h-screen p-4 sm:p-6 lg:p-8 space-y-6')}>
      {/* Header toolbar — same band geometry + card chrome as Property Search */}
      <div className={cn(
        'no-print z-20',
        hasMapData && 'sticky top-[calc(3.5rem+var(--sat))] lg:top-0 bg-background lg:bg-transparent px-4 sm:px-6 lg:px-4 pt-3 pb-1 lg:pt-4 lg:pb-0 lg:h-20 lg:flex lg:items-center lg:border-b lg:border-border flex-shrink-0',
      )}>
        <div className="w-full border border-border/60 overflow-hidden bg-background shadow-sm corner-accents corner-accents-bottom">
          <div className="px-4 py-3 flex items-center gap-3 flex-wrap">
            <Link href={queue?.backHref ?? '/dashboard/reports'} className="w-7 h-7 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0 hover:bg-primary/20 transition-colors" title={queue?.backHref ? 'Back to the offer queue' : 'Back to reports'}>
              <ArrowLeft className="w-3.5 h-3.5 text-primary" />
            </Link>
            <span className="text-body-sm text-foreground-secondary truncate flex-1 min-w-0" title={report.address || undefined}>
              {report.address || 'Property Report'}
              {report.address && <CopyButton text={report.address} title="Copy address" className="ml-1.5" />}
            </span>
            {autoSaveStatus === 'saving' && (
              <span className="text-[10px] text-foreground-tertiary flex items-center gap-1 flex-shrink-0">
                <RefreshCw className="w-3 h-3 animate-spin" /> Saving...
              </span>
            )}
            {autoSaveStatus === 'saved' && (
              <span className="text-[10px] text-emerald-500 flex-shrink-0">Saved</span>
            )}
            {queue?.inline}
            <div className="flex items-center gap-1.5 flex-shrink-0">
              <button type="button" onClick={() => setHistoryOpen(true)} className="p-1.5 rounded-lg text-foreground-tertiary hover:text-foreground hover:bg-secondary transition-colors" title="History">
                <History className="w-3.5 h-3.5" />
              </button>
              <button type="button" onClick={() => setShareOpen(true)} className="p-1.5 rounded-lg text-foreground-tertiary hover:text-foreground hover:bg-secondary transition-colors" title="Share">
                <Share2 className="w-3.5 h-3.5" />
              </button>
              <UpdateCrmButton
                jobId={jobId}
                leadId={analyzeData?.leadId}
                values={displayValuation ? {
                  listPrice: displayValuation.listPrice,
                  arv: displayValuation.arv,
                  wholesalePrice: displayValuation.wholesalePrice,
                  rehabCost: displayValuation.rehabCost,
                  buyPrice: displayValuation.buyPrice,
                  asIsValue: displayValuation.asIsValue,
                  listPriceRealism: displayValuation.listPriceRealism?.verdict ?? null,
                  confidence: displayValuation.confidence,
                  recommendation: displayValuation.recommendation,
                  recommendationReason: displayValuation.recommendationReason,
                  condition: analyzeData?.subject?.condition,
                  riskFlags: analyzeData?.riskFlags,
                } : null}
              />
              <DownloadReportButton
                reportProps={{
                  address: report.address || 'Property Report',
                  date: report.createdAt,
                  reportId: report.jobId,
                  subject: analysis.subject,
                  valuation: displayValuation,
                  comps: effectiveComps,
                  riskFlags: analysis.riskFlags,
                  floodZone: analysis.floodZone,
                  isRecalculated,
                }}
              />
              <Button
                variant="outline"
                size="sm"
                onClick={() => setRefreshOpen(true)}
                disabled={refreshing}
                className="gap-1.5"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
                {refreshing ? 'Refreshing...' : 'Refresh'}
              </Button>
            </div>
            </div>
        </div>
      </div>

      {/* Refresh result banner */}
      {refreshResult && (
        <div className={cn(
          'px-4 py-3 border text-sm flex items-start justify-between gap-3 no-print',
          hasMapData && 'mx-4 sm:mx-6 mt-2',
          refreshResult.type === 'success' && 'border-emerald-500/20 bg-emerald-500/5 text-emerald-700 dark:text-emerald-400',
          refreshResult.type === 'no_change' && 'border-blue-500/20 bg-blue-500/5 text-blue-700 dark:text-blue-400',
          refreshResult.type === 'error' && 'border-red-500/20 bg-red-500/5 text-red-700 dark:text-red-400',
        )}>
          <div>
            <div className="font-medium text-xs">{refreshResult.message}</div>
            {refreshResult.changes && refreshResult.changes.length > 0 && (
              <ul className="mt-1 space-y-0.5 text-[11px] opacity-80">
                {refreshResult.changes.map((c, i) => <li key={i}>{c}</li>)}
              </ul>
            )}
          </div>
          <button type="button" onClick={() => setRefreshResult(null)} className="text-xs opacity-60 hover:opacity-100 flex-shrink-0 mt-0.5">
            Dismiss
          </button>
        </div>
      )}

      {/* Refresh/AI status pill */}
      {(refreshing || aiAnalyzing) && (
        <div className="flex justify-center py-1.5 flex-shrink-0 no-print">
          <div className="flex items-center gap-2 px-4 py-1.5 rounded-full bg-background border border-border shadow-sm">
            <Loader2 className="w-3.5 h-3.5 text-primary animate-spin" />
            <span className="text-xs font-medium text-foreground-secondary">
              {refreshing ? 'Refreshing data...' : 'AI selecting comps...'}
            </span>
          </div>
        </div>
      )}

      {/* Analysis layout — same component as playground */}
      <AnalysisPageLayout
          onMarkerSelect={handleMarkerSelect}
          activeMarkerKey={activeMarkerKey}
          riskFlags={analysis.riskFlags}
          floodZone={analysis.floodZone}

          valuationCardRef={valuationCardRef}
          onRerun={() => setRefreshOpen(true)}
          rerunning={refreshing}
          onOfferWorkflow={handleOfferWorkflow}
          notesSlot={realtorNotesCard}
        />

      {/* Evaluation Settings Sheet */}
      {settingsOpen && <EvaluationSettingsSheet
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        settingsHook={settingsHook}
        recalcData={recalcData}
      />}

      {/* History Sidebar */}
      <Sheet open={historyOpen} onOpenChange={setHistoryOpen}>
        <SheetContent side="right" className="w-full sm:w-[380px] sm:max-w-[380px] p-0 flex flex-col">
          <SheetHeader className="px-5 pt-5 pb-3 border-b border-border">
            <SheetTitle className="text-body font-semibold flex items-center gap-2">
              <History className="w-4 h-4" /> Change History
            </SheetTitle>
            <SheetDescription className="text-caption text-foreground-tertiary">
              All modifications to this report
            </SheetDescription>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto">
            <ReportHistoryTimeline entries={historyEntries} loading={historyLoading} />
          </div>
        </SheetContent>
      </Sheet>

      {/* Share Dialog */}
      {shareOpen && <ShareReportDialog
        open={shareOpen}
        onOpenChange={setShareOpen}
        jobId={jobId}
      />}

      {/* Subject vs Comp comparison dialog */}
      {comparisonOpen && <CompComparisonDialog
        open={comparisonOpen}
        onOpenChange={setComparisonOpen}
        subject={analyzeData?.subject ?? null}
        comp={comparisonComp ? effectiveComps?.items?.find(comp => comp.address === comparisonComp.address) ?? comparisonComp : null}
        isSelected={comparisonComp && compOverride?.selectedCompKeys
          ? compOverride.selectedCompKeys.has(comparisonComp.address || '')
          : comparisonComp?.isEnabled !== false}
        onToggleSelection={comparisonComp ? () => {
          const key = comparisonComp.address || ''
          handleToggleComp(key)
        } : undefined}
        arv={displayValuation?.arv}
        proximityConfig={settingsHook.settings.proximityConfig}
        proximityToggles={settingsHook.settings.proximityAdjustments}
        onProximityChange={settingsHook.updateProximityAdjustments}
      />}

      {/* Refresh Confirmation Dialog */}
      <Dialog open={refreshOpen} onOpenChange={setRefreshOpen}>
        <DialogContent className="max-w-sm p-0 gap-0">
          <DialogHeader className="px-5 pt-5 pb-3">
            <DialogTitle className="text-body font-semibold flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-500" />
              Refresh Report Data
            </DialogTitle>
          </DialogHeader>
          <div className="px-5 pb-4 space-y-3">
            <p className="text-caption text-foreground-secondary">
              This will fetch fresh property and comparable sales data from CoreLogic. The new analysis may produce different results than the current report.
            </p>
            <div className="rounded-lg bg-amber-500/5 border border-amber-500/20 px-3 py-2.5 text-[11px] text-amber-600 dark:text-amber-400 space-y-1">
              <p>What changes:</p>
              <ul className="list-disc pl-4 space-y-0.5">
                <li>New comparable sales may be available</li>
                <li>Sale prices and dates will be updated</li>
                <li>ARV and valuation may differ from previous analysis</li>
                <li>Comp selection will be re-evaluated</li>
              </ul>
            </div>
          </div>
          <DialogFooter className="px-5 pb-4 pt-0">
            <Button variant="outline" size="sm" onClick={() => setRefreshOpen(false)}>
              Cancel
            </Button>
            <Button size="sm" onClick={handleRefresh} className="gap-1.5">
              <RefreshCw className="w-3.5 h-3.5" />
              Refresh Data
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Batch review bar — prev / queue position / next, fixed at bottom */}
      {batchQueue && navIndex >= 0 && (
        <div className="fixed inset-x-0 z-30 no-print border-t border-border bg-background bottom-[calc(3.5rem+var(--sab))] lg:bottom-0">
          <div className="px-3 sm:px-5 py-2 flex items-center justify-between gap-3">
            <div className="flex-1 min-w-0">
              {prevItem ? (
                <Link href={batchNavHref(prevItem)} className="inline-flex items-center gap-1.5 text-body-sm text-foreground-secondary hover:text-foreground transition-colors">
                  <ArrowLeft className="w-3.5 h-3.5 flex-shrink-0" />
                  <span className="truncate max-w-[220px]">{prevItem.address}</span>
                </Link>
              ) : <span />}
            </div>
            <div className="flex items-center gap-2.5 flex-shrink-0">
              <Link href="/dashboard/batch" className="inline-flex items-center gap-1 text-[10px] text-foreground-tertiary hover:text-foreground transition-colors">
                <ListChecks className="w-3 h-3" />
                Batch
              </Link>
              <span className="text-[10px] text-foreground-tertiary tabular-nums">
                {navIndex + 1} of {batchQueue.items.length}
                {batchQueue.conf !== 'all' && ` · ${{ improve: 'flagged', validated: 'validated' }[batchQueue.conf] ?? batchQueue.conf}`}
                {` · ${reviewedCount} reviewed`}
              </span>
            </div>
            <div className="flex-1 min-w-0 flex justify-end">
              {nextItem ? (
                <Link href={batchNavHref(nextItem)} className="inline-flex items-center gap-1.5 text-body-sm text-foreground-secondary hover:text-foreground transition-colors">
                  <span className="truncate max-w-[220px]">{nextItem.address}</span>
                  <ArrowRight className="w-3.5 h-3.5 flex-shrink-0" />
                </Link>
              ) : <span />}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
