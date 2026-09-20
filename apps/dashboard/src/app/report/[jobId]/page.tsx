'use client'

import { useState, useEffect, useCallback, type FormEvent } from 'react'
import Link from 'next/link'
import { ArrowLeft, Share2, Lock } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { useAnalysisEvaluation } from '@/hooks/use-analysis-evaluation'
import { useEvaluationSync } from '@/hooks/use-evaluation-sync'
import { useMapInteraction } from '@/hooks/use-map-interaction'
import { EvaluationSettingsSheet } from '@/components/report/EvaluationSettingsSheet'
import { DownloadReportButton } from '@/components/report/DownloadReportButton'
import { ShareReportDialog } from '@/components/report/ShareReportDialog'
import { AnalysisPageLayout } from '@/components/analysis'
import { CompComparisonDialog } from '@/components/analysis/CompComparisonDialog'
import type { AnalyzeData, CompItem } from '@/components/analysis'

// ─── Types ───────────────────────────────────────────────────────────────────

interface ReportData {
  jobId: string
  address: string
  createdAt: string
  analysis: AnalyzeData
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
    stickyBarRootMargin: '-10px 0px 0px 0px',
  })

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

  // Sync evaluation state to Jotai atoms for child components
  useEvaluationSync({
    evaluation: { isRecalculated, recalcData, compOverride, handleToggleComp, handleResetComps },
    subject: analyzeData?.subject,
    displayValuation,
    effectiveComps,
    feedback: {
      appliedFilters: analyzeData?.appliedSettings?.filters ?? null,
      fallbackUsed: analyzeData?.report?.arv?.compPool?.fallbackUsed ?? null,
      fallbackReason: analyzeData?.report?.arv?.compPool?.fallbackReason ?? null,
      jobId: resolvedJobId,
      subjectAddress: report?.address ?? analyzeData?.subject?.address ?? null,
    },
    jevOutcome: analyzeData?.jevOutcome ?? null,
    jevCompClassification: analyzeData?.jevCompClassification ?? null,
    onOpenSettings: () => setSettingsOpen(true),
    onCompClick: (comp) => { setComparisonComp(comp as CompItem); setComparisonOpen(true) },
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

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-foreground-tertiary text-body">Loading report...</div>
      </div>
    )
  }

  if (requiresPassword && resolvedJobId) {
    return <PasswordGate jobId={resolvedJobId} onSuccess={() => fetchReport(resolvedJobId)} />
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

  return (
    <div className="min-h-screen playground-bg flex flex-col">
      {/* Header */}
      <div className="px-4 sm:px-6 pt-8 pb-4 space-y-6 flex-shrink-0">
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
                isRecalculated,
              }}
            />
          </div>
        </div>
      </div>

      {/* Unified analysis layout (same components as playground + dashboard reports) */}
      <AnalysisPageLayout
        mapComps={effectiveComps}
        onMarkerSelect={handleMarkerSelect}
        activeMarkerKey={activeMarkerKey}
        riskFlags={analysis.riskFlags}
        floodZone={analysis.floodZone}

        valuationCardRef={valuationCardRef}
        footer={
          <div className="pt-6 border-t border-border text-center">
            <p className="text-caption text-foreground-tertiary">Generated by Flowstate</p>
          </div>
        }
      />

      {/* Evaluation Settings Sheet */}
      <EvaluationSettingsSheet
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        settingsHook={settingsHook}
        recalcData={recalcData}
      />

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
        arv={displayValuation?.arv}
      />
    </div>
  )
}
