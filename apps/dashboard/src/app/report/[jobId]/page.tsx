'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { ArrowLeft, DollarSign, SlidersHorizontal } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
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
import {
  SubjectPropertyCard,
  ValuationCard,
  ComparablesSection,
  RiskFloodCard,
} from '@/components/analysis'
import type {
  AnalyzeData,
  ValuationData,
  CompsData,
  FloodZoneData,
} from '@/components/analysis'

// ─── Types ───────────────────────────────────────────────────────────────────

interface AnalysisData {
  subject?: AnalyzeData['subject']
  valuation?: ValuationData
  comps?: CompsData
  riskFlags?: string[] | null
  floodZone?: FloodZoneData | null
  meta?: { analysisId?: string; timestamp?: string; dataProvider?: string }
}

interface ReportData {
  jobId: string
  address: string
  createdAt: string
  analysis: AnalysisData
}

// ─── Main Page Component ─────────────────────────────────────────────────────

const API_URL = process.env.NEXT_PUBLIC_API_URL!

export default function ReportPage({ params }: { params: Promise<{ jobId: string }> }) {
  const [report, setReport] = useState<ReportData | null>(null)
  const [error, setError] = useState(false)
  const [loading, setLoading] = useState(true)

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

  useEffect(() => {
    params.then(({ jobId }) => {
      fetch(`${API_URL}/reports/${jobId}`)
        .then((res) => {
          if (!res.ok) throw new Error('Not found')
          return res.json() as Promise<{ success: boolean; data?: ReportData }>
        })
        .then((result) => {
          if (result.success && result.data) {
            setReport(result.data)
          } else {
            setError(true)
          }
        })
        .catch(() => setError(true))
        .finally(() => setLoading(false))
    })
  }, [params])

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-foreground-tertiary text-body">Loading report...</div>
      </div>
    )
  }

  if (error || !report) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center space-y-2">
          <h1 className="text-heading-lg text-foreground">Report Not Found</h1>
          <p className="text-body text-foreground-tertiary">This report may have been removed or the link is invalid.</p>
        </div>
      </div>
    )
  }

  const { analysis } = report

  return (
    <div className="min-h-screen playground-bg">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-8 space-y-6">
        {/* Header */}
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
        </div>

        {/* Sticky Valuation Summary Bar */}
        {displayValuation && showStickyBar && (
          <div className="sticky top-0 z-10 no-print">
            <div className={cn(
              'border-x-0 border-b border-border overflow-hidden bg-background/90 backdrop-blur-xl rounded-b-xl',
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

        {/* Report Content */}
        <div className="space-y-6">
          {displayValuation && (
            <div ref={valuationCardRef}>
              <ValuationCard valuation={displayValuation} isRecalculated={isRecalculated} onOpenSettings={() => setSettingsOpen(true)} />
            </div>
          )}

          {analysis.subject && <SubjectPropertyCard subject={analysis.subject} />}

          {effectiveComps && (
            <ComparablesSection
              comps={effectiveComps}
              subjectSubdivision={analysis.subject?.subdivision}
              selectedCompKeys={compOverride?.selectedCompKeys}
              isManual={compOverride?.isManual ?? false}
              recalculatedArv={isRecalculated ? displayValuation?.arv : undefined}
              onToggleComp={handleToggleComp}
              onReset={handleResetComps}
            />
          )}

          <RiskFloodCard riskFlags={analysis.riskFlags} floodZone={analysis.floodZone} />
        </div>

        {/* Footer */}
        <div className="pt-6 border-t border-border text-center">
          <p className="text-caption text-foreground-tertiary">Generated by Flowstate</p>
        </div>
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
    </div>
  )
}
