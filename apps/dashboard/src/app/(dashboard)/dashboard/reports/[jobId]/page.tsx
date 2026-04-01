'use client'

import { useState, useEffect, useCallback, useRef, use, useLayoutEffect } from 'react'
import Link from 'next/link'
import { ArrowLeft, Share2, RefreshCw, AlertTriangle, History, Clock } from 'lucide-react'
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
import { updateSavedReport, getReportHistory, type ReportHistoryEntry } from '@/lib/client-api'
import { getSavedReport } from '@/lib/client-api'
import { useAnalysisEvaluation } from '@/hooks/use-analysis-evaluation'
import { SettingsPanel } from '@/components/report/SettingsPanel'
import { DownloadReportButton } from '@/components/report/DownloadReportButton'
import { ShareReportDialog } from '@/components/report/ShareReportDialog'
import { AnalysisPageLayout } from '@/components/analysis'
import type { AnalyzeData, CompItem } from '@/components/analysis'
import { queueAnalysis, type AnalyzeData as ActionAnalyzeData } from '@/app/(dashboard)/dashboard/analyze/actions'
import { CompComparisonDialog } from '@/components/analysis/CompComparisonDialog'
import { getCompKey } from '@/components/analysis/format-helpers'
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
  const [aiAnalyzing, setAiAnalyzing] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [historyEntries, setHistoryEntries] = useState<ReportHistoryEntry[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [refreshResult, setRefreshResult] = useState<{
    type: 'success' | 'no_change' | 'error'
    message: string
    changes?: string[]
  } | null>(null)

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
  const [autoSaveStatus, setAutoSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle')
  const saveTimerRef = useRef<NodeJS.Timeout | null>(null)
  const lastSavedRef = useRef<string | null>(null)
  const initialLoadRef = useRef(true)

  useEffect(() => {
    // Skip when no data
    if (!report || !displayValuation || !recalcData) return

    const fingerprint = JSON.stringify({
      arv: displayValuation.arv,
      buyPrice: displayValuation.buyPrice,
      comps: compOverride?.selectedCompKeys ? Array.from(compOverride.selectedCompKeys).sort() : null,
      settingsChanged: settingsHook.settingsChanged,
    })

    // On initial load (and when settings are still loading/changing),
    // just capture the fingerprint without saving
    if (initialLoadRef.current) {
      lastSavedRef.current = fingerprint
      // Only clear the flag once settings have stabilized (not in a "changed" state from async loading)
      if (!settingsHook.settingsChanged) {
        initialLoadRef.current = false
      }
      return
    }

    // No change from last save
    if (fingerprint === lastSavedRef.current) return

    // Debounce: wait 2s after last change before saving
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(async () => {
      setAutoSaveStatus('saving')

      // Build change description
      const changes: string[] = []
      if (compOverride?.isManual) changes.push('Comp selection changed')
      if (settingsHook.settingsChanged) changes.push('Evaluation settings adjusted')
      if (recalcData.valuation.proximityDeduction > 0) changes.push('Proximity adjustment applied')

      const description = changes.length > 0
        ? changes.join(', ')
        : 'Evaluation updated'

      try {
        // Patch fullResponseJson with updated comp selection so it persists on reload
        let updatedJson: string | undefined
        if (compOverride?.selectedCompKeys && report?.analysis) {
          const patched = { ...report.analysis }
          if (patched.comps?.items) {
            patched.comps = {
              ...patched.comps,
              items: patched.comps.items.map((comp: CompItem, i: number) => {
                const key = comp.address || `comp-${i}`
                return { ...comp, isEnabled: compOverride.selectedCompKeys!.has(key) }
              }),
            }
          }
          updatedJson = JSON.stringify(patched)
        }

        await updateSavedReport(jobId, {
          ...(updatedJson ? { fullResponseJson: updatedJson } : {}),
          arv: displayValuation.arv,
          maxAllowableOffer: displayValuation.buyPrice,
          estimatedRepairs: displayValuation.rehabCost,
          historyAction: 'evaluation_update',
          historyDescription: description,
          historyChanges: {
            arv: displayValuation.arv,
            buyPrice: displayValuation.buyPrice,
            rehabCost: displayValuation.rehabCost,
            selectedComps: compOverride?.selectedCompKeys ? Array.from(compOverride.selectedCompKeys) : null,
            proximityDeduction: recalcData.valuation.proximityDeduction,
          },
        })
        lastSavedRef.current = fingerprint
        setAutoSaveStatus('saved')
        setTimeout(() => setAutoSaveStatus('idle'), 2000)
        if (historyOpen) loadHistory()
      } catch {
        setAutoSaveStatus('idle')
      }
    }, 2000)

    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    }
  }, [displayValuation, compOverride, recalcData, settingsHook.settingsChanged, report, jobId])

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

  const handleRefresh = useCallback(async () => {
    if (!report?.address) return
    setRefreshing(true)
    setRefreshOpen(false)
    setRefreshResult(null)

    const oldAnalysis = report.analysis
    try {
      const response = await queueAnalysis({
        address: report.address,
        searchOptions: { radiusMiles: 1, maxComps: 15, monthsBack: 12 },
        skipCache: true,
        marketData: { enabled: true },
      })
      if (response.success && response.result) {
        const newAnalysis = response.result as AnalyzeData

        // Compare old vs new
        const changes: string[] = []
        const oldArv = oldAnalysis.valuation?.arv
        const newArv = newAnalysis.valuation?.arv
        if (oldArv && newArv && oldArv !== newArv) {
          const diff = newArv - oldArv
          changes.push(`ARV: $${oldArv.toLocaleString()} → $${newArv.toLocaleString()} (${diff > 0 ? '+' : ''}$${diff.toLocaleString()})`)
        }

        const oldBuy = oldAnalysis.valuation?.buyPrice
        const newBuy = newAnalysis.valuation?.buyPrice
        if (oldBuy && newBuy && oldBuy !== newBuy) {
          const diff = newBuy - oldBuy
          changes.push(`Buy Price: $${oldBuy.toLocaleString()} → $${newBuy.toLocaleString()} (${diff > 0 ? '+' : ''}$${diff.toLocaleString()})`)
        }

        const oldComps = oldAnalysis.comps?.enabledCount ?? oldAnalysis.comps?.items?.filter((c: { isEnabled?: boolean }) => c.isEnabled !== false).length ?? 0
        const newComps = newAnalysis.comps?.enabledCount ?? newAnalysis.comps?.items?.filter((c: { isEnabled?: boolean }) => c.isEnabled !== false).length ?? 0
        if (oldComps !== newComps) {
          changes.push(`Selected comps: ${oldComps} → ${newComps}`)
        }

        const oldTotal = oldAnalysis.comps?.count ?? oldAnalysis.comps?.items?.length ?? 0
        const newTotal = newAnalysis.comps?.count ?? newAnalysis.comps?.items?.length ?? 0
        if (oldTotal !== newTotal) {
          changes.push(`Total comps: ${oldTotal} → ${newTotal}`)
        }

        setReport({
          jobId: response.jobId ?? jobId,
          address: report.address,
          createdAt: new Date().toISOString(),
          analysis: newAnalysis,
        })

        if (changes.length > 0) {
          setRefreshResult({ type: 'success', message: 'Data refreshed with changes', changes })
        } else {
          setRefreshResult({ type: 'no_change', message: 'Data refreshed — no significant changes detected' })
        }

        // Auto-dismiss after 10 seconds
        setTimeout(() => setRefreshResult(null), 10000)
      } else {
        setRefreshResult({ type: 'error', message: response.error || 'Refresh failed' })
        setTimeout(() => setRefreshResult(null), 5000)
      }
    } catch (err) {
      setRefreshResult({ type: 'error', message: err instanceof Error ? err.message : 'Refresh failed' })
      setTimeout(() => setRefreshResult(null), 5000)
    } finally {
      setRefreshing(false)
    }
  }, [report, jobId])

  const handleRunAiAnalysis = useCallback(async () => {
    if (!report?.address || aiAnalyzing) return
    setAiAnalyzing(true)
    try {
      const response = await queueAnalysis({
        address: report.address,
        searchOptions: { radiusMiles: 1, maxComps: 15, monthsBack: 12 },
        skipCache: false,
        marketData: { enabled: true },
        llmAnalysis: { enabled: true },
      })
      if (response.success && response.result) {
        setReport({
          jobId: response.jobId ?? jobId,
          address: report.address,
          createdAt: report.createdAt,
          analysis: response.result as AnalyzeData,
        })
      }
    } catch {
      // AI analysis failed — keep existing data
    } finally {
      setAiAnalyzing(false)
    }
  }, [report, jobId, aiAnalyzing])

  // Map marker → scroll to card + comparison dialog
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

    if (type === 'comp' && compKey && analyzeData) {
      const compItems = (analyzeData.comps?.items ?? []) as CompItem[]
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
  }, [scrollAndHighlight, analyzeData])

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

      {/* Analysis layout — same component as playground */}
      <AnalysisPageLayout
        subject={analysis.subject}
        comps={effectiveComps}
        valuation={displayValuation}
        isRecalculated={isRecalculated}
        selectedCompKeys={compOverride?.selectedCompKeys}
        isManual={compOverride?.isManual ?? false}
        onToggleComp={handleToggleComp}
        onResetComps={handleResetComps}
        onMarkerSelect={handleMarkerSelect}
        activeMarkerKey={activeMarkerKey}
        settingsHook={settingsHook}
        recalcData={recalcData}
        onOpenSettings={() => setSettingsOpen(true)}
        aiAnalyzing={aiAnalyzing}
        onRunAiAnalysis={!aiAnalyzing ? handleRunAiAnalysis : undefined}
        onCompClick={(comp) => { setComparisonComp(comp as CompItem); setComparisonOpen(true) }}
        riskFlags={analysis.riskFlags}
        floodZone={analysis.floodZone}
        visionAnalysis={analysis.visionAnalysis}
        valuationCardRef={valuationCardRef}
      />

      {/* Evaluation Settings Sheet */}
      <Sheet open={settingsOpen} onOpenChange={setSettingsOpen}>
        <SheetContent side="right" className="w-full sm:w-[400px] sm:max-w-[400px] p-0 flex flex-col">
          <SheetHeader className="px-5 pt-5 pb-3 border-b border-border">
            <SheetTitle className="text-body font-semibold">Evaluation Settings</SheetTitle>
            <SheetDescription className="text-caption text-foreground-tertiary">
              Adjust filters, adjustments, and deal parameters to see real-time recalculation.
            </SheetDescription>
          </SheetHeader>
          <SettingsPanel settingsHook={settingsHook} recalcData={recalcData} />
        </SheetContent>
      </Sheet>

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
            {historyLoading ? (
              <div className="flex items-center justify-center py-16">
                <RefreshCw className="w-5 h-5 animate-spin text-muted-foreground" />
              </div>
            ) : historyEntries.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-center px-5">
                <Clock className="w-8 h-8 text-muted-foreground/30 mb-3" />
                <p className="text-sm text-muted-foreground">No changes recorded yet</p>
                <p className="text-xs text-muted-foreground/60 mt-1">Changes to comp selection, settings, and AI analysis will appear here.</p>
              </div>
            ) : (
              <div className="relative">
                {/* Timeline line */}
                <div className="absolute left-[23px] top-0 bottom-0 w-px bg-border" />

                {historyEntries.map((entry, i) => {
                  const isFirst = i === 0
                  const changes = entry.changes as Record<string, unknown> | null
                  const actionColor = entry.action === 'evaluation_update' ? 'bg-emerald-500'
                    : entry.action === 'ai_analysis' ? 'bg-primary'
                    : entry.action === 'reanalyzed' ? 'bg-amber-500'
                    : entry.action === 'created' ? 'bg-blue-500'
                    : 'bg-muted-foreground'

                  return (
                    <div key={entry.id} className={`relative pl-12 pr-5 py-3 ${isFirst ? 'bg-muted/20' : ''}`}>
                      {/* Timeline dot */}
                      <div className={`absolute left-[19px] top-4 w-[9px] h-[9px] rounded-full border-2 border-background ${actionColor}`} />

                      <div className="text-xs font-medium text-foreground">{entry.description}</div>
                      <div className="text-[10px] text-foreground-tertiary mt-0.5">
                        {new Date(entry.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                        {' · '}
                        {new Date(entry.createdAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
                      </div>

                      {/* Change details */}
                      {!!changes && (
                        <div className="mt-1.5 space-y-0.5 text-[10px] text-foreground-tertiary">
                          {changes.arv != null && (
                            <div>ARV: <span className="text-foreground tabular-nums">${Number(changes.arv).toLocaleString()}</span></div>
                          )}
                          {changes.buyPrice != null && (
                            <div>Buy: <span className="text-foreground tabular-nums">${Number(changes.buyPrice).toLocaleString()}</span></div>
                          )}
                          {changes.proximityDeduction != null && Number(changes.proximityDeduction) > 0 && (
                            <div>Proximity: <span className="text-red-500 tabular-nums">−${Number(changes.proximityDeduction).toLocaleString()}</span></div>
                          )}
                          {!!changes.selectedComps && Array.isArray(changes.selectedComps) && (
                            <div>Comps: <span className="text-foreground">{(changes.selectedComps as string[]).length} selected</span></div>
                          )}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
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
