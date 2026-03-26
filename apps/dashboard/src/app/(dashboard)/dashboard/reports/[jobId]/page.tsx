'use client'

import { useState, useEffect, useCallback, use } from 'react'
import Link from 'next/link'
import { ArrowLeft, DollarSign, SlidersHorizontal, Share2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet'
import { cn } from '@/lib/utils'
import { getSavedReport } from '@/lib/client-api'
import { useAnalysisEvaluation } from '@/hooks/use-analysis-evaluation'
import { SettingsPanel } from '@/components/report/SettingsPanel'
import { DownloadReportButton } from '@/components/report/DownloadReportButton'
import { ShareReportDialog } from '@/components/report/ShareReportDialog'
import {
  SubjectPropertyCard,
  ValuationCard,
  ComparablesSection,
  RiskFloodCard,
  ApiCallStatsCard,
  VisionAnalysisButton,
  PropertyMap,
} from '@/components/analysis'
import type { AnalyzeData } from '@/components/analysis'

// ─── Main Page ──────────────────────────────────────────────────────────────

export default function DashboardReportPage({ params }: { params: Promise<{ jobId: string }> }) {
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

  // Map marker → scroll to card (must be before early returns)
  const [activeMarkerKey, setActiveMarkerKey] = useState<string | null>(null)
  const handleMarkerSelect = useCallback((type: 'subject' | 'comp', compKey?: string) => {
    const key = type === 'subject' ? 'subject' : compKey
    if (!key) return
    setActiveMarkerKey(key)
    const el = document.querySelector(`[data-card-key="${key}"]`)
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      el.classList.add('ring-2', 'ring-primary', 'ring-offset-2', 'ring-offset-background')
      setTimeout(() => {
        el.classList.remove('ring-2', 'ring-primary', 'ring-offset-2', 'ring-offset-background')
        setActiveMarkerKey(null)
      }, 2000)
    }
  }, [])

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
    <div className={cn(hasMapData ? '-m-4 sm:-m-6 lg:-m-8' : 'max-w-[1600px] mx-auto space-y-6')}>
      {/* Header */}
      <div className={cn(hasMapData && 'px-4 sm:px-6 lg:px-8 pt-4 sm:pt-6 lg:pt-8 space-y-6')}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-3 min-w-0">
          <Link href="/dashboard/reports" className="p-2 rounded-lg hover:bg-secondary transition-colors flex-shrink-0">
            <ArrowLeft className="w-5 h-5 text-foreground-tertiary" />
          </Link>
          <span className="text-body-sm text-foreground-tertiary">
            Analyzed on {new Date(report.createdAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
          </span>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <button
            type="button"
            onClick={() => setShareOpen(true)}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-body-sm text-foreground-secondary hover:text-foreground hover:bg-secondary transition-colors border border-border no-print"
          >
            <Share2 className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Share</span>
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
              // neighbourhood: analysis.neighbourhood, // TODO: re-enable when neighbourhood data source is available
              isRecalculated,
            }}
          />
        </div>
      </div>

      </div>{/* end header wrapper */}

      {/* Full-width sticky valuation bar */}
      {displayValuation && (
        <div className="sticky top-0 z-20 no-print border-b border-border bg-background/95 backdrop-blur-xl">
          <div className="px-4 sm:px-6 py-2.5 flex items-center gap-3 sm:gap-5 flex-wrap">
            <div className="flex items-center gap-2 flex-shrink-0">
              <DollarSign className="w-4 h-4 text-primary" />
              {isRecalculated && (
                <Badge className="bg-amber-500/15 text-amber-700 border-amber-500/30 text-[10px] px-1.5 py-0">Recalculated</Badge>
              )}
            </div>
            <div className="flex items-center gap-4 sm:gap-5 flex-1 min-w-0 flex-wrap">
              <div className="flex items-baseline gap-1">
                <span className="text-caption-sm text-foreground-tertiary">ARV</span>
                <span className="text-body-sm font-bold text-primary tabular-nums">${displayValuation.arv?.toLocaleString() || '-'}</span>
              </div>
              <div className="flex items-baseline gap-1">
                <span className="text-caption-sm text-foreground-tertiary">Max Buy Price</span>
                <span className="text-body-sm font-semibold tabular-nums">${displayValuation.buyPrice?.toLocaleString() || '-'}</span>
              </div>
              <div className="flex items-baseline gap-1">
                <span className="text-caption-sm text-foreground-tertiary">Rehab</span>
                <span className="text-body-sm font-medium tabular-nums">${displayValuation.rehabCost?.toLocaleString() || '-'}</span>
              </div>
              <div className="flex items-baseline gap-1">
                <span className="text-caption-sm text-foreground-tertiary">Profit</span>
                <span className={cn('text-body-sm font-semibold tabular-nums', (displayValuation.projectedProfit ?? 0) > 0 ? 'text-emerald-600' : 'text-red-600')}>
                  ${displayValuation.projectedProfit?.toLocaleString() || '-'}
                </span>
              </div>
              {displayValuation.projectedROI != null && (
                <div className="flex items-baseline gap-1">
                  <span className="text-caption-sm text-foreground-tertiary">ROI</span>
                  <span className={cn('text-body-sm font-semibold tabular-nums', displayValuation.projectedROI > 15 ? 'text-emerald-600' : displayValuation.projectedROI > 0 ? 'text-foreground' : 'text-red-600')}>
                    {displayValuation.projectedROI.toFixed(1)}%
                  </span>
                </div>
              )}
            </div>
            {displayValuation.recommendation && (
              <Badge variant="outline" className={cn(
                'text-[10px] px-2 py-0 flex-shrink-0',
                displayValuation.recommendation.toUpperCase().includes('PURSUE') && 'bg-emerald-500/10 text-emerald-700 border-emerald-500/30',
                displayValuation.recommendation.toUpperCase().includes('PASS') && 'bg-red-500/10 text-red-700 border-red-500/30',
                displayValuation.recommendation.toUpperCase().includes('REVIEW') && 'bg-amber-500/10 text-amber-700 border-amber-500/30',
              )}>{displayValuation.recommendation}</Badge>
            )}
            <button type="button" onClick={() => setSettingsOpen(true)} className="p-1.5 rounded-lg text-foreground-tertiary hover:text-foreground hover:bg-secondary transition-colors flex-shrink-0" title="Evaluation Settings">
              <SlidersHorizontal className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* Two-column layout: Map (left, sticky) + Content (right, scrollable) */}
      <div className="flex flex-col xl:flex-row flex-1">
        {/* Left column: Sticky Map — 1/3 width */}
        {hasMapData && (
          <div className="xl:w-1/3 xl:flex-shrink-0 no-print">
            <div className="xl:sticky xl:top-10 xl:h-[calc(100vh-2.5rem)] overflow-hidden">
              <PropertyMap subject={analysis.subject} comps={effectiveComps} subjectSubdivision={analysis.subject?.subdivision} selectedCompKeys={compOverride?.selectedCompKeys} onToggleComp={handleToggleComp} onMarkerSelect={handleMarkerSelect} activeMarkerKey={activeMarkerKey} />
            </div>
          </div>
        )}

        {/* Right column: All content cards */}
        <div className={cn('flex-1 min-w-0', hasMapData && 'border-l border-border')}>
          <div className="space-y-6 p-4 sm:p-6">
          {analysis.subject && (
            <SubjectPropertyCard
              subject={analysis.subject}
              footer={analysis.subject.photos?.length ? (
                <VisionAnalysisButton
                  photoUrls={analysis.subject.photos}
                  propertyContext={{
                    address: analysis.subject.address,
                    squareFeet: analysis.subject.squareFeet ?? undefined,
                    yearBuilt: analysis.subject.yearBuilt ?? undefined,
                  }}
                  existingAnalysis={analysis.visionAnalysis}
                />
              ) : undefined}
            />
          )}

          {displayValuation && (
            <div ref={valuationCardRef}>
              <ValuationCard valuation={displayValuation} isRecalculated={isRecalculated} onOpenSettings={() => setSettingsOpen(true)} />
            </div>
          )}

          <RiskFloodCard riskFlags={analysis.riskFlags} floodZone={analysis.floodZone} permits={analysis.permits} asIsMarketIntel={analysis.valuation?.asIsMarketIntel} />

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
            />
          )}

          {analysis.apiCallStats && (
            <ApiCallStatsCard stats={analysis.apiCallStats} />
          )}

          {/* Footer */}
          <div className="pt-6 border-t border-border text-center">
            <p className="text-caption text-foreground-tertiary">Generated by Flowstate</p>
          </div>
          </div>{/* end inner content padding */}
        </div>{/* end right column */}
      </div>{/* end two-column flex */}

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

      {/* Share Dialog */}
      <ShareReportDialog
        open={shareOpen}
        onOpenChange={setShareOpen}
        jobId={jobId}
      />
    </div>
  )
}
