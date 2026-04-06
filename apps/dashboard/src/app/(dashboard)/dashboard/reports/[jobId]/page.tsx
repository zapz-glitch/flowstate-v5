'use client'

import { useState, useEffect, useCallback, useRef, use } from 'react'
import Link from 'next/link'
import { ArrowLeft, Share2, RefreshCw, AlertTriangle, History, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
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
import { getSavedReport } from '@/lib/client-api'
import { useAnalysisEvaluation } from '@/hooks/use-analysis-evaluation'
import { EvaluationSettingsSheet } from '@/components/report/EvaluationSettingsSheet'
import { DownloadReportButton } from '@/components/report/DownloadReportButton'
import { ShareReportDialog } from '@/components/report/ShareReportDialog'
import { ReportHistoryTimeline } from '@/components/report/ReportHistoryTimeline'
import { AnalysisPageLayout } from '@/components/analysis'
import type { AnalyzeData, CompItem } from '@/components/analysis'
import { queueAnalysis, type AnalyzeData as ActionAnalyzeData } from '@/app/(dashboard)/dashboard/analyze/actions'
import { CompComparisonDialog } from '@/components/analysis/CompComparisonDialog'
import { useMapInteraction } from '@/hooks/use-map-interaction'
import { useEvaluationSync } from '@/hooks/use-evaluation-sync'
import { useEnrichmentSSE, type EnrichmentEvent } from '@/hooks/use-enrichment-sse'
import { useSidebar } from '@/components/SidebarProvider'

// ─── Main Page ──────────────────────────────────────────────────────────────

export default function DashboardReportPage({ params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = use(params)

  // Collapse sidebar on mount, restore on unmount
  const { collapsed: sidebarCollapsed, setCollapsed: setSidebarCollapsed } = useSidebar()
  const prevCollapsedRef = useRef(sidebarCollapsed)
  useEffect(() => {
    prevCollapsedRef.current = sidebarCollapsed
    if (!sidebarCollapsed) setSidebarCollapsed(true)
    return () => {
      if (!prevCollapsedRef.current) setSidebarCollapsed(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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

  const analyzeData = report?.analysis ?? null

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
    data: analyzeData,
    stickyBarRootMargin: '-60px 0px 0px 0px',
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
    analysisData: report?.analysis,
    displayValuation,
    recalcData,
    compOverride,
    settingsHook,
    onSaved: historyOpen ? loadHistory : undefined,
  })

  const fetchReport = useCallback(async () => {
    try {
      setLoading(true)
      setError(null)
      const data = await getSavedReport(jobId)
      setReport({
        jobId: data.jobId,
        address: data.address,
        createdAt: data.createdAt,
        analysis: data.analysis as AnalyzeData,
      })
    } catch {
      setError('Report not found')
    } finally {
      setLoading(false)
    }
  }, [jobId])

  useEffect(() => {
    fetchReport()
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
        if (data.updatedResult && report) {
          setReport((prev) => prev ? {
            ...prev,
            analysis: data.updatedResult as AnalyzeData,
          } : prev)
          setRefreshResult({ type: 'success', message: 'AI comp selection updated' })
          setTimeout(() => setRefreshResult(null), 5000)
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

  const handleRefresh = useCallback(async () => {
    if (!report?.address) return
    setRefreshing(true)
    setRefreshOpen(false)
    setRefreshResult(null)

    try {
      const response = await queueAnalysis({
        address: report.address,
        existingJobId: jobId,
        searchOptions: { radiusMiles: 1, maxComps: 15, monthsBack: 12 },
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
    (analyzeData?.comps?.items ?? []) as CompItem[]
  )

  // ─── Sync evaluation state to Jotai atoms ────────────────────────────────
  useEvaluationSync({
    evaluation: { isRecalculated, recalcData, compOverride, handleToggleComp, handleResetComps },
    subject: analyzeData?.subject,
    displayValuation,
    effectiveComps,
    aiAnalyzing,
    onOpenSettings: () => setSettingsOpen(true),
    onCompClick: (comp) => { setComparisonComp(comp as CompItem); setComparisonOpen(true) },
  })

  if (loading) {
    return (
      <div className="flex items-center justify-center py-32">
        <div className="text-foreground-tertiary text-body">Loading report...</div>
      </div>
    )
  }

  if (error || !report) {
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

  const { analysis } = report

  const hasMapData = !!(analysis.subject?.latitude && analysis.subject?.longitude)

  return (
    <div className={cn(hasMapData ? '-m-4 sm:-m-6 lg:-m-8 min-h-screen lg:h-[100dvh] flex flex-col lg:overflow-hidden' : 'max-w-[1600px] mx-auto space-y-6')}>
      {/* Header toolbar — address + actions only */}
      <div className="sticky top-0 z-20 no-print border-b border-border bg-background/95 backdrop-blur-xl">
        <div className="px-3 sm:px-5 py-2 flex items-center gap-2 sm:gap-4">
          <Link href="/dashboard/reports" className="p-1 rounded-lg hover:bg-secondary transition-colors flex-shrink-0">
            <ArrowLeft className="w-4 h-4 text-foreground-tertiary" />
          </Link>
          <span className="text-body-sm font-medium truncate flex-1 min-w-0" title={report.address || undefined}>
            {report.address || 'Property Report'}
          </span>
          {autoSaveStatus === 'saving' && (
            <span className="text-[10px] text-foreground-tertiary flex items-center gap-1 flex-shrink-0">
              <RefreshCw className="w-3 h-3 animate-spin" /> Saving...
            </span>
          )}
          {autoSaveStatus === 'saved' && (
            <span className="text-[10px] text-emerald-500 flex-shrink-0">Saved</span>
          )}
          <div className="flex items-center gap-1.5 flex-shrink-0">
            <button type="button" onClick={() => setHistoryOpen(true)} className="p-1.5 rounded-lg text-foreground-tertiary hover:text-foreground hover:bg-secondary transition-colors" title="History">
              <History className="w-3.5 h-3.5" />
            </button>
            <button type="button" onClick={() => setShareOpen(true)} className="p-1.5 rounded-lg text-foreground-tertiary hover:text-foreground hover:bg-secondary transition-colors" title="Share">
              <Share2 className="w-3.5 h-3.5" />
            </button>
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

      {/* Refresh result banner */}
      {refreshResult && (
        <div className={cn(
          'mx-4 sm:mx-6 mt-2 px-4 py-3 border text-sm flex items-start justify-between gap-3 no-print',
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
          <div className="flex items-center gap-2 px-4 py-1.5 rounded-full bg-background/90 border border-border shadow-sm">
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
        />

      {/* Evaluation Settings Sheet */}
      <EvaluationSettingsSheet
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        settingsHook={settingsHook}
        recalcData={recalcData}
      />

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
      <ShareReportDialog
        open={shareOpen}
        onOpenChange={setShareOpen}
        jobId={jobId}
      />

      {/* Subject vs Comp comparison dialog */}
      <CompComparisonDialog
        open={comparisonOpen}
        onOpenChange={setComparisonOpen}
        subject={analyzeData?.subject ?? null}
        comp={comparisonComp}
        isSelected={comparisonComp && compOverride?.selectedCompKeys
          ? compOverride.selectedCompKeys.has(comparisonComp.address || '')
          : comparisonComp?.isEnabled !== false}
        onToggleSelection={comparisonComp ? () => {
          const key = comparisonComp.address || ''
          handleToggleComp(key)
        } : undefined}
        arv={displayValuation?.arv}
        proximityConfig={settingsHook.settings.proximityConfig}
      />

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
    </div>
  )
}
