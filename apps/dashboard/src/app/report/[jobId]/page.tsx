'use client'

import { useState, useEffect, useCallback, type FormEvent } from 'react'
import Link from 'next/link'
import { ArrowLeft, DollarSign, SlidersHorizontal, Lock, Share2, Navigation } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { ResizableLayout } from '@/components/ui/resizable'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet'
import { cn } from '@/lib/utils'
import { useAnalysisEvaluation } from '@/hooks/use-analysis-evaluation'
import { SettingsPanel } from '@/components/report/SettingsPanel'
import { DownloadReportButton } from '@/components/report/DownloadReportButton'
import { ShareReportDialog } from '@/components/report/ShareReportDialog'
import {
  SubjectPropertyCard,
  ValuationCard,
  ComparablesSection,
  RiskFloodCard,
  PropertyMap,
} from '@/components/analysis'
import type {
  AnalyzeData,
  ValuationData,
  CompsData,
  CompItem,
  FloodZoneData,
  NeighbourhoodData,
} from '@/components/analysis'
import { CompComparisonDialog } from '@/components/analysis/CompComparisonDialog'
import { getCompKey } from '@/components/analysis/format-helpers'

// ─── Types ───────────────────────────────────────────────────────────────────

interface AnalysisData {
  subject?: AnalyzeData['subject']
  valuation?: ValuationData
  comps?: CompsData
  riskFlags?: string[] | null
  permits?: { count?: number; totalValue?: number; recentTypes?: string[] } | null
  floodZone?: FloodZoneData | null
  neighbourhood?: NeighbourhoodData | null
  meta?: { analysisId?: string; timestamp?: string; dataProvider?: string }
}

interface ReportData {
  jobId: string
  address: string
  createdAt: string
  analysis: AnalysisData
}

// ─── Password Gate ───────────────────────────────────────────────────────────

const API_URL = process.env.NEXT_PUBLIC_API_URL!

function PasswordGate({ jobId, onSuccess }: { jobId: string; onSuccess: () => void }) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setSubmitting(true)
    setError('')
    try {
      const res = await fetch(`${API_URL}/reports/${jobId}/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ password }),
      })
      const data = (await res.json()) as { success: boolean; error?: string }
      if (data.success) {
        onSuccess()
      } else {
        setError(data.error || 'Incorrect password')
      }
    } catch {
      setError('Failed to verify. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="min-h-screen bg-background flex items-center justify-center px-4">
      <Card className="w-full max-w-sm p-6">
        <div className="text-center mb-6">
          <Lock className="w-10 h-10 mx-auto mb-3 text-foreground-tertiary" />
          <h1 className="text-heading-md text-foreground">Protected Report</h1>
          <p className="text-body-sm text-foreground-tertiary mt-1">
            Enter the password to view this report
          </p>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          <Input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
          />
          {error && <p className="text-body-sm text-red-500">{error}</p>}
          <button
            type="submit"
            disabled={submitting || !password}
            className="w-full px-4 py-2 rounded-lg bg-primary text-white text-body-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {submitting ? 'Verifying...' : 'View Report'}
          </button>
        </form>
      </Card>
    </div>
  )
}

// ─── Main Page Component ─────────────────────────────────────────────────────

export default function ReportPage({ params }: { params: Promise<{ jobId: string }> }) {
  const [report, setReport] = useState<ReportData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [requiresPassword, setRequiresPassword] = useState(false)
  const [isOwner, setIsOwner] = useState(false)
  const [resolvedJobId, setResolvedJobId] = useState<string | null>(null)
  const [shareOpen, setShareOpen] = useState(false)

  // Cast AnalysisData to AnalyzeData for the evaluation hook (same shape)
  const analyzeData = report?.analysis as AnalyzeData | null

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
    data: analyzeData,
    stickyBarRootMargin: '-10px 0px 0px 0px',
  })

  const fetchReport = useCallback((jobId: string) => {
    setLoading(true)
    setError(null)
    setRequiresPassword(false)
    fetch(`${API_URL}/reports/${jobId}`, { credentials: 'include' })
      .then(async (res) => {
        const result = (await res.json()) as {
          success: boolean
          data?: ReportData
          isOwner?: boolean
          requiresPassword?: boolean
          error?: string
        }
        if (res.status === 401 && result.requiresPassword) {
          setRequiresPassword(true)
          return
        }
        if (res.status === 403) {
          setError('This report is private')
          return
        }
        if (!res.ok) {
          setError('Report not found')
          return
        }
        if (result.success && result.data) {
          setReport(result.data)
          setIsOwner(!!result.isOwner)
        } else {
          setError('Report not found')
        }
      })
      .catch(() => setError('Failed to load report'))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    params.then(({ jobId }) => {
      setResolvedJobId(jobId)
      fetchReport(jobId)
    })
  }, [params, fetchReport])

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

    if (type === 'comp' && compKey && report) {
      const compItems = (report.analysis?.comps?.items ?? []) as CompItem[]
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
  }, [scrollAndHighlight, report])

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-foreground-tertiary text-body">Loading report...</div>
      </div>
    )
  }

  if (requiresPassword && resolvedJobId) {
    return (
      <PasswordGate
        jobId={resolvedJobId}
        onSuccess={() => fetchReport(resolvedJobId)}
      />
    )
  }

  if (error || !report) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center space-y-2">
          <h1 className="text-heading-lg text-foreground">
            {error === 'This report is private' ? 'Private Report' : 'Report Not Found'}
          </h1>
          <p className="text-body text-foreground-tertiary">
            {error === 'This report is private'
              ? 'This report is private and cannot be accessed.'
              : 'This report may have been removed or the link is invalid.'}
          </p>
        </div>
      </div>
    )
  }

  const { analysis } = report

  const hasMapData = !!(analysis.subject?.latitude && analysis.subject?.longitude)

  return (
    <div className="min-h-screen playground-bg">
      <div className={cn(hasMapData ? 'px-0' : 'max-w-[1600px] mx-auto px-4 sm:px-6 space-y-6', 'py-0')}>
        {/* Header */}
        <div className={cn(hasMapData ? 'px-4 sm:px-6 pt-8 pb-4 space-y-6' : 'pt-8 space-y-6')}>
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <Link href="/dashboard/reports" className="p-2 mt-0.5 rounded-lg hover:bg-secondary transition-colors flex-shrink-0">
              <ArrowLeft className="w-5 h-5 text-foreground-tertiary" />
            </Link>
            <div className="space-y-1">
              <div className="flex items-center gap-3">
                <h1 className="text-heading-lg text-foreground tracking-tight">{report.address || 'Property Report'}</h1>
                {isRecalculated && (
                  <Badge variant="outline" className="bg-blue-500/10 text-blue-600 border-blue-500/30 text-caption-sm">
                    Recalculated
                  </Badge>
                )}
              </div>
              <p className="text-body-sm text-foreground-tertiary">
                Analyzed on {new Date(report.createdAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {isOwner && (
              <button
                type="button"
                onClick={() => setShareOpen(true)}
                className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-body-sm text-foreground-secondary hover:text-foreground hover:bg-secondary transition-colors border border-border no-print"
              >
                <Share2 className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Share</span>
              </button>
            )}
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
                // neighbourhood: analysis.neighbourhood, // TODO: re-enable when neighbourhood data source is available
                isRecalculated,
              }}
            />
          </div>
        </div>

        </div>{/* end header wrapper */}

        {/* Two-column resizable layout */}
        {hasMapData ? (
        <ResizableLayout
          left={
            <div className="sticky top-10 h-[calc(100vh-2.5rem)] overflow-hidden">
              <PropertyMap subject={analysis.subject} comps={effectiveComps} subjectSubdivision={analysis.subject?.subdivision} selectedCompKeys={compOverride?.selectedCompKeys} onToggleComp={handleToggleComp} onMarkerSelect={handleMarkerSelect} activeMarkerKey={activeMarkerKey} />
            </div>
          }
          right={
            <>
            {/* Sticky valuation bar — appears when ValuationCard scrolls out */}
            {displayValuation && (
              <div className="sticky top-0 z-10 no-print border-b border-border bg-background/95 backdrop-blur-xl">
                <div className="px-4 sm:px-6 py-2 flex items-center gap-3 sm:gap-4 flex-wrap">
                  <DollarSign className="w-3.5 h-3.5 text-primary flex-shrink-0" />
                  <div className="flex items-center gap-3 sm:gap-4 flex-1 min-w-0 flex-wrap text-caption-sm tabular-nums">
                    <span className="text-foreground-tertiary">ARV <span className="font-bold text-primary">${displayValuation.arv?.toLocaleString() || '-'}</span></span>
                    <span className="text-foreground-tertiary">Max Buy <span className="font-semibold text-foreground">${displayValuation.buyPrice?.toLocaleString() || '-'}</span></span>
                    <span className="text-foreground-tertiary">Profit <span className={cn('font-semibold', (displayValuation.projectedProfit ?? 0) > 0 ? 'text-emerald-600' : 'text-red-600')}>${displayValuation.projectedProfit?.toLocaleString() || '-'}</span></span>
                  </div>
                  {displayValuation.recommendation && (
                    <Badge variant="outline" className={cn(
                      'text-[10px] px-1.5 py-0 flex-shrink-0',
                      displayValuation.recommendation.toUpperCase().includes('PURSUE') && 'bg-emerald-500/10 text-emerald-700 border-emerald-500/30',
                      displayValuation.recommendation.toUpperCase().includes('PASS') && 'bg-red-500/10 text-red-700 border-red-500/30',
                      displayValuation.recommendation.toUpperCase().includes('REVIEW') && 'bg-amber-500/10 text-amber-700 border-amber-500/30',
                    )}>{displayValuation.recommendation}</Badge>
                  )}
                  <button type="button" onClick={() => setSettingsOpen(true)} className="p-1 rounded-lg text-foreground-tertiary hover:text-foreground hover:bg-secondary transition-colors flex-shrink-0" title="Evaluation Settings">
                    <SlidersHorizontal className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            )}
            <div className="space-y-6 p-4 sm:p-6">
              {analysis.subject && <SubjectPropertyCard subject={analysis.subject} />}

              {displayValuation && (
                <div ref={valuationCardRef}>
                  <ValuationCard valuation={displayValuation} isRecalculated={isRecalculated} onOpenSettings={() => setSettingsOpen(true)} />
                </div>
              )}

              {/* Proximity Adjustments */}
              {displayValuation && (
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

              <RiskFloodCard riskFlags={analysis.riskFlags} floodZone={analysis.floodZone} permits={analysis.permits} />

              {effectiveComps && (
                <ComparablesSection
                  comps={effectiveComps}
                  subject={analysis.subject}
                  subjectSubdivision={analysis.subject?.subdivision}
                  selectedCompKeys={compOverride?.selectedCompKeys}
                  isManual={compOverride?.isManual ?? false}
                  recalculatedArv={isRecalculated ? displayValuation?.arv : undefined}
                  onToggleComp={handleToggleComp}
                  onReset={handleResetComps}
                  highlightedCompKey={activeMarkerKey}
                />
              )}

              {/* Footer */}
              <div className="pt-6 border-t border-border text-center">
                <p className="text-caption text-foreground-tertiary">Generated by Flowstate</p>
              </div>
            </div>
            </>
          }
        />
        ) : (
        <div className="flex-1 space-y-6 p-4 sm:p-6 max-w-5xl mx-auto">
          {analysis.subject && <SubjectPropertyCard subject={analysis.subject} />}
          {displayValuation && (
            <div ref={valuationCardRef}>
              <ValuationCard valuation={displayValuation} isRecalculated={isRecalculated} onOpenSettings={() => setSettingsOpen(true)} />
            </div>
          )}
          {/* Proximity Adjustments */}
          {displayValuation && (
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
          <RiskFloodCard riskFlags={analysis.riskFlags} floodZone={analysis.floodZone} permits={analysis.permits} />
          {effectiveComps && (
            <ComparablesSection comps={effectiveComps} subject={analysis.subject} subjectSubdivision={analysis.subject?.subdivision} selectedCompKeys={compOverride?.selectedCompKeys} isManual={compOverride?.isManual ?? false} recalculatedArv={isRecalculated ? displayValuation?.arv : undefined} onToggleComp={handleToggleComp} onReset={handleResetComps} />
          )}
        </div>
        )}
      </div>

      {/* Evaluation Settings Sheet */}
      <Sheet open={settingsOpen} onOpenChange={setSettingsOpen}>
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

      {/* Share Dialog */}
      {isOwner && resolvedJobId && (
        <ShareReportDialog
          open={shareOpen}
          onOpenChange={setShareOpen}
          jobId={resolvedJobId}
        />
      )}

      {/* Subject vs Comp comparison dialog */}
      <CompComparisonDialog
        open={comparisonOpen}
        onOpenChange={setComparisonOpen}
        subject={report?.analysis?.subject ?? null}
        comp={comparisonComp}
        isSelected={comparisonComp && compOverride?.selectedCompKeys
          ? compOverride.selectedCompKeys.has(comparisonComp.address || '')
          : comparisonComp?.isEnabled !== false}
        onToggleSelection={comparisonComp ? () => {
          const key = comparisonComp.address || ''
          handleToggleComp(key)
        } : undefined}
      />
    </div>
  )
}
