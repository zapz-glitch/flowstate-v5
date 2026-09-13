'use client'

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import Link from 'next/link'
import { Upload, FileText, Loader2, Check, X, Download, ChevronRight, Flag, CheckCircle2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import { submitBatchAnalysis, getBatchStatus, getBatchJobs, retryFailedAddresses, recoverStuckBatch, getBatchStreamToken, type BatchResult } from './actions'

type Phase = 'upload' | 'processing' | 'complete'
type ConfBucket = 'high' | 'medium' | 'low' | 'unrated'

const CONF_LABELS: Record<ConfBucket, string> = {
  high: 'High confidence',
  medium: 'Medium confidence',
  low: 'Low confidence',
  unrated: 'Unrated',
}

function confBucket(r: BatchResult): ConfBucket {
  const c = r.confidence?.toLowerCase()
  if (c === 'high' || c === 'medium' || c === 'low') return c
  return 'unrated'
}

interface JobSummary { id: string; status: string; totalAddresses: number; completedCount: number; failedCount: number; createdAt: string }

export default function BatchPage() {
  const [phase, setPhase] = useState<Phase>('upload')
  const [addresses, setAddresses] = useState<string[]>([])
  const [fileName, setFileName] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Processing state
  const [batchId, setBatchId] = useState<string | null>(null)
  const [results, setResults] = useState<BatchResult[]>([])
  const [completedCount, setCompletedCount] = useState(0)
  const [failedCount, setFailedCount] = useState(0)
  const [isStuck, setIsStuck] = useState(false)

  // List picker + confidence filter
  const [allJobs, setAllJobs] = useState<JobSummary[]>([])
  const [viewAll, setViewAll] = useState(false) // aggregate across lists
  const [allResults, setAllResults] = useState<Array<BatchResult & { batchId: string }>>([])
  const [confFilter, setConfFilter] = useState<ConfBucket | 'all'>('all')

  const fileInputRef = useRef<HTMLInputElement>(null)
  const pollingRef = useRef<NodeJS.Timeout | null>(null)
  const eventSourceRef = useRef<EventSource | null>(null)

  // ─── Polling — reliable progress mechanism ───────────────────────────────

  const stopPolling = useCallback(() => {
    if (pollingRef.current) {
      clearInterval(pollingRef.current)
      pollingRef.current = null
    }
    eventSourceRef.current?.close()
    eventSourceRef.current = null
  }, [])

  const startPolling = useCallback((id: string) => {
    stopPolling()
    const poll = async () => {
      try {
        const job = await getBatchStatus(id)
        if (!job) return
        if (job.results?.length) setResults(job.results)
        setCompletedCount(job.completedCount)
        setFailedCount(job.failedCount)
        setIsStuck(job.isStuck ?? false)
        if (job.status === 'completed' || job.status === 'failed') {
          setPhase('complete')
          setIsStuck(false)
          stopPolling()
        }
      } catch { /* ignore */ }
    }
    // Poll immediately, then every 3 seconds
    poll()
    pollingRef.current = setInterval(poll, 3000)

    // Also try SSE for real-time updates (non-critical — polling is the fallback)
    getBatchStreamToken(id).then((tokenResult) => {
      if (!tokenResult) return
      try {
        const es = new EventSource(`${tokenResult.streamUrl}?token=${tokenResult.token}`)
        eventSourceRef.current = es

        es.addEventListener('batch_state', (e) => {
          const data = JSON.parse(e.data)
          if (data.results) setResults(data.results)
          setCompletedCount(data.completedCount ?? 0)
          setFailedCount(data.failedCount ?? 0)
        })
        es.addEventListener('address_started', (e) => {
          const data = JSON.parse(e.data)
          setResults((prev) => prev.map((r, i) => i === data.index ? { ...r, status: 'processing' } : r))
        })
        es.addEventListener('address_completed', (e) => {
          const data = JSON.parse(e.data)
          setResults((prev) => prev.map((r, i) => i === data.index ? { ...r, status: 'completed', jobId: data.jobId } : r))
          setCompletedCount((c) => c + 1)
        })
        es.addEventListener('address_failed', (e) => {
          const data = JSON.parse(e.data)
          setResults((prev) => prev.map((r, i) => i === data.index ? { ...r, status: 'failed', error: data.error } : r))
          setFailedCount((c) => c + 1)
        })
        es.addEventListener('batch_completed', (e) => {
          const data = JSON.parse(e.data)
          if (data.results) setResults(data.results)
          setCompletedCount(data.completedCount ?? 0)
          setFailedCount(data.failedCount ?? 0)
          setPhase('complete')
          stopPolling()
        })
        es.addEventListener('batch_done', () => { setPhase('complete'); stopPolling() })
        es.onerror = () => { es.close(); eventSourceRef.current = null } // Silent — polling continues
      } catch { /* SSE failed — polling continues */ }
    }).catch(() => { /* ignore */ })
  }, [stopPolling])

  // ─── Resume active batch on page load ────────────────────────────────────

  useEffect(() => {
    let cancelled = false
    async function resumeBatch() {
      try {
        const jobs = await getBatchJobs()
        if (cancelled) return
        setAllJobs(jobs)
        const active = jobs.find((j) => j.status === 'processing')
        const recent = active ?? jobs[0]
        if (!recent || cancelled) return

        setBatchId(recent.id)

        if (recent.status === 'processing') {
          setPhase('processing')
          // Load current state from DB then start polling
          const job = await getBatchStatus(recent.id)
          if (job && !cancelled) {
            if (job.results?.length) setResults(job.results)
            setCompletedCount(job.completedCount)
            setFailedCount(job.failedCount)
            startPolling(recent.id)
          }
        } else if (recent.status === 'completed' || recent.status === 'failed') {
          const job = await getBatchStatus(recent.id)
          if (job && !cancelled) {
            setResults(job.results ?? [])
            setCompletedCount(job.completedCount)
            setFailedCount(job.failedCount)
            setPhase('complete')
          }
        }
      } catch { /* show upload phase */ }
    }
    resumeBatch()
    return () => { cancelled = true; stopPolling() }
  }, [startPolling, stopPolling])

  // Cleanup on unmount
  useEffect(() => {
    return () => stopPolling()
  }, [stopPolling])

  // ─── CSV Parsing ──────────────────────────────────────────────────────────

  const parseCSV = useCallback((text: string): string[] => {
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    if (lines.length === 0) return []

    // Check if first line is a header
    const firstLine = lines[0].toLowerCase()
    const hasHeader = firstLine.includes('address') || firstLine.includes('street') || firstLine.includes('property')
    const headerLine = hasHeader ? lines[0] : null
    const dataLines = hasHeader ? lines.slice(1) : lines

    // Detect multi-column CSV: header must have many columns (>3)
    const headerCols = headerLine?.split(',').map((c) => c.replace(/^["']|["']$/g, '').trim().toLowerCase()) ?? []
    const isMultiColumn = headerCols.length > 3

    let addressColIndex = -1
    if (isMultiColumn) {
      addressColIndex = headerCols.findIndex((c) => c === 'address' || c === 'full address' || c === 'property address' || c === 'street address')
    }

    const parsed: string[] = []
    for (const line of dataLines) {
      let address: string
      if (isMultiColumn && addressColIndex >= 0) {
        const cols = line.split(',').map((c) => c.replace(/^["']|["']$/g, '').trim())
        address = cols[addressColIndex] || ''
      } else if (isMultiColumn) {
        continue
      } else {
        // Simple format: one full address per line (commas are part of the address)
        address = line.replace(/^["']|["']$/g, '').trim()
      }

      if (address.length > 5) {
        parsed.push(address)
      }
    }

    return [...new Set(parsed)]
  }, [])

  const handleFileSelect = useCallback((file: File) => {
    setError(null)
    if (!file.name.endsWith('.csv') && !file.name.endsWith('.txt')) {
      setError('Please upload a .csv or .txt file')
      return
    }

    const reader = new FileReader()
    reader.onload = (e) => {
      const text = e.target?.result as string
      const parsed = parseCSV(text)
      if (parsed.length === 0) {
        setError('No valid addresses found in file')
        return
      }
      if (parsed.length > 50) {
        setError(`Too many addresses (${parsed.length}). Maximum is 50.`)
        return
      }
      setAddresses(parsed)
      setFileName(file.name)
    }
    reader.readAsText(file)
  }, [parseCSV])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    const file = e.dataTransfer.files[0]
    if (file) handleFileSelect(file)
  }, [handleFileSelect])

  // ─── Start Batch ──────────────────────────────────────────────────────────

  const handleStart = useCallback(async () => {
    if (addresses.length === 0) return
    setError(null)
    setPhase('processing')
    setResults(addresses.map((address, i) => ({ address, index: i, status: 'pending' })))
    setCompletedCount(0)
    setFailedCount(0)

    const result = await submitBatchAnalysis(addresses)
    if (!result.success || !result.batchId) {
      setError(result.error || 'Failed to start batch')
      setPhase('upload')
      return
    }

    setBatchId(result.batchId)
    startPolling(result.batchId)
  }, [addresses, startPolling])

  // ─── CSV Export ───────────────────────────────────────────────────────────

  const handleExportCSV = useCallback(() => {
    const header = 'Address,Status,Error,Report Link'
    const rows = results.map((r) => {
      const reportUrl = r.jobId && r.status === 'completed' ? `${window.location.origin}/dashboard/reports/${r.jobId}` : ''
      return [
        `"${r.address}"`,
        r.status,
        r.error ? `"${r.error}"` : '',
        reportUrl,
      ].join(',')
    })

    const csv = [header, ...rows].join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `batch-results-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }, [results])

  // ─── Recover Stuck Batch ─────────────────────────────────────────────────

  const handleRecover = useCallback(async () => {
    if (!batchId) return
    const result = await recoverStuckBatch(batchId)
    if (!result.success) {
      setError(result.error || 'Recovery failed')
      return
    }
    // Refresh from DB
    const job = await getBatchStatus(batchId)
    if (job) {
      setResults(job.results ?? [])
      setCompletedCount(job.completedCount)
      setFailedCount(job.failedCount)
      setPhase('complete')
      setIsStuck(false)
      stopPolling()
    }
  }, [batchId, stopPolling])

  // ─── Retry Failed ─────────────────────────────────────────────────────────

  const handleRetryFailed = useCallback(async () => {
    if (!batchId || failedCount === 0) return
    setPhase('processing')
    setError(null)
    const result = await retryFailedAddresses(batchId)
    if (!result.success) {
      setError(result.error || 'Retry failed')
      setPhase('complete')
      return
    }
    startPolling(batchId)
  }, [batchId, failedCount, startPolling])

  // ─── Reset ────────────────────────────────────────────────────────────────

  const handleReset = useCallback(() => {
    stopPolling()
    setPhase('upload')
    setAddresses([])
    setFileName(null)
    setError(null)
    setBatchId(null)
    setResults([])
    setCompletedCount(0)
    setFailedCount(0)
    setIsStuck(false)
    setViewAll(false)
    setAllResults([])
    setConfFilter('all')
  }, [stopPolling])

  // ─── Progress calculation ─────────────────────────────────────────────────

  const totalDone = completedCount + failedCount
  const totalAddresses = results.length > 0 ? results.length : addresses.length
  const progressPercent = totalAddresses > 0 ? Math.round((totalDone / totalAddresses) * 100) : 0
  const currentIndex = results.findIndex((r) => r.status === 'processing')
  const remaining = totalAddresses - totalDone

  // ─── List picker ──────────────────────────────────────────────────────────

  const selectBatch = useCallback(async (id: string) => {
    if (id === batchId) return
    stopPolling()
    setViewAll(false)
    setConfFilter('all')
    setBatchId(id)
    setError(null)
    const job = await getBatchStatus(id)
    if (!job) return
    setResults(job.results ?? [])
    setCompletedCount(job.completedCount)
    setFailedCount(job.failedCount)
    setIsStuck(job.isStuck ?? false)
    if (job.status === 'processing') {
      setPhase('processing')
      startPolling(id)
    } else {
      setPhase('complete')
    }
  }, [batchId, startPolling, stopPolling])

  const selectAllLists = useCallback(async () => {
    stopPolling()
    setViewAll(true)
    setConfFilter('all')
    setPhase('complete')
    // Fetch every job's results and merge (stamps + confidence join server-side)
    const merged: Array<BatchResult & { batchId: string }> = []
    for (const j of allJobs) {
      const job = await getBatchStatus(j.id)
      if (job?.results?.length) {
        for (const r of job.results) merged.push({ ...r, batchId: j.id })
      }
    }
    setAllResults(merged)
  }, [allJobs, stopPolling])

  // ─── Confidence buckets ───────────────────────────────────────────────────

  // Rows for the current view — per-list results get their batchId attached for nav links
  const viewRows = useMemo((): Array<BatchResult & { batchId?: string }> => {
    if (viewAll) return allResults
    return results.map((r) => ({ ...r, batchId: batchId ?? undefined }))
  }, [viewAll, allResults, results, batchId])

  const completedRows = useMemo(() => viewRows.filter((r) => r.status === 'completed' && r.jobId), [viewRows])

  const buckets = useMemo(() => {
    const b: Record<ConfBucket, { total: number; reviewed: number; rows: typeof completedRows }> = {
      high: { total: 0, reviewed: 0, rows: [] },
      medium: { total: 0, reviewed: 0, rows: [] },
      low: { total: 0, reviewed: 0, rows: [] },
      unrated: { total: 0, reviewed: 0, rows: [] },
    }
    for (const r of completedRows) {
      const k = confBucket(r)
      b[k].total++
      if (r.feedbackStatus) b[k].reviewed++
      b[k].rows.push(r)
    }
    return b
  }, [completedRows])

  const filteredRows = useMemo(() => {
    if (confFilter === 'all') return viewRows
    return viewRows.filter((r) => r.status === 'completed' && confBucket(r) === confFilter)
  }, [viewRows, confFilter])

  // First unreviewed report in a bucket — where "Review" jumps to
  const firstUnreviewed = useCallback((bucket: ConfBucket) => {
    const rows = buckets[bucket].rows
    return rows.find((r) => !r.feedbackStatus) ?? rows[0] ?? null
  }, [buckets])

  const reportHref = (r: BatchResult & { batchId?: string }, conf?: string) =>
    r.jobId ? `/dashboard/reports/${r.jobId}${r.batchId ? `?batch=${r.batchId}&conf=${conf ?? (confFilter === 'all' ? 'all' : confFilter)}` : ''}` : '#'

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-foreground">Batch Import</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Upload a CSV with addresses to generate analysis reports in bulk.
        </p>
      </div>

      {/* Error */}
      {error && (
        <div className="border border-red-500/20 bg-red-500/5 px-4 py-3 rounded-sm text-sm text-red-500">
          {error}
        </div>
      )}

      {/* Phase: Upload */}
      {phase === 'upload' && (
        <div className="space-y-4">
          {/* Drop zone */}
          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
            className="border-2 border-dashed border-border rounded-sm p-10 text-center cursor-pointer hover:border-primary/50 transition-colors"
          >
            <Upload className="w-8 h-8 text-foreground-tertiary mx-auto mb-3" />
            <p className="text-sm text-foreground-secondary">
              Drag & drop a CSV file, or click to browse
            </p>
            <p className="text-xs text-foreground-tertiary mt-1">
              One address per line. Max 50 addresses.
            </p>
            <div className="mt-3 text-left inline-block bg-muted/50 border border-border/50 rounded-sm px-4 py-2.5">
              <p className="text-[10px] font-medium text-foreground-tertiary uppercase tracking-wider mb-1.5">Sample CSV format</p>
              <pre className="text-[11px] text-foreground-secondary leading-relaxed">{`address\n4207 W EMPEDRADO ST, TAMPA, FL 33629\n123 MAIN ST, ORLANDO, FL 32801\n456 OAK AVE, MIAMI, FL 33101`}</pre>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,.txt"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) handleFileSelect(file)
              }}
            />
          </div>

          {/* Preview */}
          {addresses.length > 0 && (
            <Card className="rounded-sm">
              <CardContent className="p-4">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <FileText className="w-4 h-4 text-foreground-tertiary" />
                    <span className="text-sm font-medium">{fileName}</span>
                    <span className="text-xs text-foreground-tertiary">({addresses.length} addresses)</span>
                  </div>
                  <Button size="sm" onClick={handleStart}>
                    Start Analysis
                  </Button>
                </div>
                <div className="max-h-60 overflow-y-auto border border-border rounded-sm divide-y divide-border/50">
                  {addresses.map((addr, i) => (
                    <div key={i} className="px-3 py-2 text-xs text-foreground-secondary flex items-center gap-2">
                      <span className="text-foreground-tertiary w-6 text-right flex-shrink-0">{i + 1}.</span>
                      {addr}
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* Phase: Processing / Complete */}
      {(phase === 'processing' || phase === 'complete') && (
        <div className="space-y-4">
          {/* List picker — which batch list to view, or all lists */}
          {allJobs.length > 0 && (
            <div className="flex items-center gap-1 flex-wrap">
              <button
                type="button"
                onClick={selectAllLists}
                className={cn(
                  'text-[11px] px-2.5 py-1 rounded transition-colors',
                  viewAll ? 'bg-primary/15 text-primary font-medium' : 'text-foreground-tertiary hover:text-foreground hover:bg-secondary'
                )}
              >
                All lists
              </button>
              {allJobs.map((j, i) => (
                <button
                  key={j.id}
                  type="button"
                  onClick={() => selectBatch(j.id)}
                  className={cn(
                    'text-[11px] px-2.5 py-1 rounded transition-colors inline-flex items-center gap-1',
                    !viewAll && batchId === j.id ? 'bg-primary/15 text-primary font-medium' : 'text-foreground-tertiary hover:text-foreground hover:bg-secondary'
                  )}
                >
                  List {allJobs.length - i}
                  <span className="text-[9px] opacity-70">· {j.completedCount}/{j.totalAddresses}</span>
                  {j.status === 'processing' && <Loader2 className="w-2.5 h-2.5 animate-spin" />}
                </button>
              ))}
            </div>
          )}

          {/* Queue card — how many in the list, how many left */}
          {!viewAll && (
          <Card className="rounded-sm">
            <CardContent className="p-4">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  {phase === 'processing' && <Loader2 className="w-4 h-4 animate-spin text-primary" />}
                  {phase === 'complete' && <Check className="w-4 h-4 text-emerald-500" />}
                  <span className="text-sm font-medium">
                    {phase === 'processing'
                      ? currentIndex >= 0 ? `Processing ${currentIndex + 1} of ${totalAddresses}...` : `Processing...`
                      : 'Batch Complete'}
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  {remaining > 0 && (
                    <span className="text-xs text-foreground-tertiary">{remaining} left in queue</span>
                  )}
                  {completedCount > 0 && (
                    <span className="text-xs text-emerald-500">{completedCount} completed</span>
                  )}
                  {failedCount > 0 && (
                    <span className="text-xs text-red-500">{failedCount} failed</span>
                  )}
                </div>
              </div>
              <div className="w-full h-2 bg-muted rounded-full overflow-hidden">
                <div
                  className="h-full bg-primary transition-all duration-300"
                  style={{ width: `${progressPercent}%` }}
                />
              </div>
              <div className="text-[10px] text-foreground-tertiary mt-1 text-right">
                {totalDone}/{totalAddresses} ({progressPercent}%)
              </div>
            </CardContent>
          </Card>
          )}

          {/* Confidence buckets — click a bucket to filter, Review jumps to first unreviewed */}
          {completedRows.length > 0 && (
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
              <button
                type="button"
                onClick={() => setConfFilter('all')}
                className={cn(
                  'rounded-sm border px-3 py-2.5 text-left transition-colors',
                  confFilter === 'all' ? 'border-primary/50 bg-primary/5' : 'border-border hover:border-foreground/20'
                )}
              >
                <div className="text-[10px] uppercase tracking-wider text-foreground-tertiary">All</div>
                <div className="text-lg font-bold tabular-nums">{completedRows.length}</div>
                <div className="text-[9px] text-foreground-tertiary">
                  {completedRows.filter((r) => r.feedbackStatus).length} reviewed
                </div>
              </button>
              {(['low', 'medium', 'high', 'unrated'] as ConfBucket[]).map((bucket) => {
                const b = buckets[bucket]
                const target = firstUnreviewed(bucket)
                return (
                  <div
                    key={bucket}
                    className={cn(
                      'rounded-sm border px-3 py-2.5 transition-colors',
                      confFilter === bucket ? 'border-primary/50 bg-primary/5' : 'border-border',
                      bucket === 'low' && 'border-l-2 border-l-red-500/50',
                      bucket === 'medium' && 'border-l-2 border-l-amber-500/50',
                      bucket === 'high' && 'border-l-2 border-l-emerald-500/50',
                    )}
                  >
                    <button type="button" onClick={() => setConfFilter(confFilter === bucket ? 'all' : bucket)} className="block w-full text-left">
                      <div className="text-[10px] uppercase tracking-wider text-foreground-tertiary">{CONF_LABELS[bucket]}</div>
                      <div className="text-lg font-bold tabular-nums">{b.total}</div>
                      <div className="text-[9px] text-foreground-tertiary">{b.reviewed} reviewed</div>
                    </button>
                    {target && (
                      <Link
                        href={reportHref(target, bucket)}
                        className="mt-1 inline-flex items-center gap-0.5 text-[10px] font-medium text-primary hover:underline"
                      >
                        Review <ChevronRight className="w-3 h-3" />
                      </Link>
                    )}
                  </div>
                )
              })}
            </div>
          )}

          {/* Stuck batch warning */}
          {isStuck && phase === 'processing' && (
            <div className="border border-amber-500/30 bg-amber-500/5 px-4 py-3 rounded-sm flex items-center justify-between gap-3">
              <div className="flex-1">
                <div className="text-sm font-medium text-amber-500">Batch appears stuck</div>
                <div className="text-xs text-foreground-tertiary mt-0.5">
                  No progress for 3+ minutes. You can force-complete to mark remaining addresses as failed.
                </div>
              </div>
              <Button size="sm" variant="outline" onClick={handleRecover}>
                Force Complete
              </Button>
            </div>
          )}

          {/* Actions */}
          {phase === 'complete' && (
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" onClick={handleExportCSV} className="gap-1.5">
                <Download className="w-3.5 h-3.5" />
                Export CSV
              </Button>
              {failedCount > 0 && (
                <Button size="sm" variant="outline" onClick={handleRetryFailed} className="gap-1.5">
                  Retry Failed ({failedCount})
                </Button>
              )}
              <Button size="sm" variant="outline" onClick={handleReset} className="gap-1.5">
                New Batch
              </Button>
            </div>
          )}

          {/* Results table */}
          <Card className="rounded-sm">
            <CardContent className="p-0">
              <div className="max-h-[60vh] overflow-y-auto">
                <table className="w-full text-xs">
                  <thead className="bg-muted/50 sticky top-0">
                    <tr>
                      <th className="text-left px-3 py-2 font-medium text-foreground-tertiary w-8">#</th>
                      <th className="text-left px-3 py-2 font-medium text-foreground-tertiary">Address</th>
                      <th className="text-left px-3 py-2 font-medium text-foreground-tertiary">Status</th>
                      <th className="text-left px-3 py-2 font-medium text-foreground-tertiary w-20">Confidence</th>
                      <th className="text-left px-3 py-2 font-medium text-foreground-tertiary w-24">Reviewed</th>
                      <th className="text-center px-3 py-2 font-medium text-foreground-tertiary w-20">Report</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/30">
                    {filteredRows.map((r, i) => (
                      <tr key={r.jobId ?? i} className={cn(
                        'transition-colors',
                        r.status === 'processing' && 'bg-primary/5',
                        r.status === 'failed' && 'bg-red-500/5',
                      )}>
                        <td className="px-3 py-2 text-foreground-tertiary">{i + 1}</td>
                        <td className="px-3 py-2 text-foreground-secondary truncate max-w-[300px]" title={r.address}>
                          {r.address}
                        </td>
                        <td className="px-3 py-2">
                          {r.status === 'pending' && <span className="text-foreground-tertiary">Pending</span>}
                          {r.status === 'processing' && (
                            <span className="inline-flex items-center gap-1 text-primary">
                              <Loader2 className="w-3 h-3 animate-spin" /> Processing
                            </span>
                          )}
                          {r.status === 'completed' && (
                            <span className="inline-flex items-center gap-1 text-emerald-500">
                              <Check className="w-3 h-3" /> Done
                            </span>
                          )}
                          {r.status === 'failed' && (
                            <span className="inline-flex items-center gap-1 text-red-500">
                              <X className="w-3 h-3" /> {r.error || 'Failed'}
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          {r.status === 'completed' ? (() => {
                            const b = confBucket(r)
                            return b === 'unrated'
                              ? <span className="text-foreground-tertiary">—</span>
                              : <span className={cn(
                                  'inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium',
                                  b === 'low' && 'bg-red-500/10 text-red-400',
                                  b === 'medium' && 'bg-amber-500/10 text-amber-500',
                                  b === 'high' && 'bg-emerald-500/10 text-emerald-500',
                                )}>{b}</span>
                          })() : <span className="text-foreground-tertiary">—</span>}
                        </td>
                        <td className="px-3 py-2">
                          {r.feedbackStatus === 'validated' && (
                            <span className="inline-flex items-center gap-1 text-emerald-500 text-[10px] font-medium">
                              <CheckCircle2 className="w-3 h-3" /> Validated
                            </span>
                          )}
                          {r.feedbackStatus === 'improve' && (
                            <span className="inline-flex items-center gap-1 text-amber-500 text-[10px] font-medium">
                              <Flag className="w-3 h-3" /> Flagged
                            </span>
                          )}
                          {!r.feedbackStatus && r.status === 'completed' && (
                            <span className="text-foreground-tertiary text-[10px]">—</span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-center">
                          {r.jobId && r.status === 'completed' ? (
                            <Link
                              href={reportHref(r, r.confidence?.toLowerCase() ?? 'unrated')}
                              className="text-primary hover:underline inline-flex items-center gap-0.5"
                            >
                              Review <ChevronRight className="w-2.5 h-2.5" />
                            </Link>
                          ) : '-'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  )
}
