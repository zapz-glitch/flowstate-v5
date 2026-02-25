'use client'

import { useState, useCallback, useEffect } from 'react'
import {
  Search,
  Play,
  MapPin,
  Home,
  DollarSign,
  Star,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Code,
  RefreshCw,
  StopCircle,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import {
  queueAnalysis,
  getJobStatus,
  type AnalyzeData,
  type CompItem,
  type SubjectData,
  type ValuationData,
  type CompsData,
  type ClassificationSummary,
} from './actions'
import { cn } from '@/lib/utils'
import { useAnalysisWebSocket, useAnalysisPolling } from '@/hooks/use-analysis-websocket'
import { RealtimeStatus } from '@/components/analysis/RealtimeStatus'
import type { AnalysisState } from '@/types/analysis'

// ─── Helper Functions for Formatting ─────────────────────────────────────────

const FILTER_TYPE_LABELS: Record<string, string> = {
  subdivision_match: 'Subdivision Match',
  sale_age: 'Sale Age',
  sqft_diff: 'Sqft Difference',
  year_built_diff: 'Year Built Diff',
  distance: 'Distance',
}

const ADJUSTMENT_TYPE_LABELS: Record<string, string> = {
  old_comp_discount: 'Old Comp Discount',
  bedroom: 'Bedroom Adjustment',
  bathroom: 'Bathroom Adjustment',
  pool: 'Pool Adjustment',
  garage: 'Garage Adjustment',
  carport: 'Carport Adjustment',
}

function formatFilterType(type: string): string {
  return FILTER_TYPE_LABELS[type] || type.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

function formatAdjustmentType(type: string): string {
  return ADJUSTMENT_TYPE_LABELS[type] || type.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount)
}

// ─── Classification Badge Component ─────────────────────────────────────────

function ClassificationBadge({ classification, showConfidence = true }: { classification: ClassificationSummary | null | undefined; showConfidence?: boolean }) {
  if (!classification) return null

  const getClassificationStyle = (type: string) => {
    switch (type) {
      case 'as_is':
        return 'bg-orange-500/10 text-orange-700 border-orange-500/30'
      case 'after_renovation':
        return 'bg-emerald-500/10 text-emerald-700 border-emerald-500/30'
      case 'transitional':
        return 'bg-blue-500/10 text-blue-700 border-blue-500/30'
      default:
        return 'bg-gray-500/10 text-gray-700 border-gray-500/30'
    }
  }

  const getClassificationLabel = (type: string) => {
    switch (type) {
      case 'as_is':
        return 'As-Is'
      case 'after_renovation':
        return 'Renovated'
      case 'transitional':
        return 'Transitional'
      default:
        return type
    }
  }

  return (
    <Badge variant="outline" className={cn('font-medium', getClassificationStyle(classification.type))}>
      {getClassificationLabel(classification.type)}
      {showConfidence && classification.confidence > 0 && (
        <span className="ml-1 opacity-70">({classification.confidence}%)</span>
      )}
    </Badge>
  )
}

export default function AnalyzePage() {
  const [address, setAddress] = useState('')
  const [isRunning, setIsRunning] = useState(false)
  const [skipCache, setSkipCache] = useState(false)
  const [result, setResult] = useState<{
    success: boolean
    data?: AnalyzeData
    error?: string
    timing?: { durationMs: number }
  } | null>(null)
  const [showRawJson, setShowRawJson] = useState(false)

  // Real-time analysis state
  const [streamUrl, setStreamUrl] = useState<string | null>(null)
  const [propertyKey, setPropertyKey] = useState<string | null>(null)
  const [jobId, setJobId] = useState<string | null>(null)
  const [usePolling, setUsePolling] = useState(false)

  // Handle real-time completion
  const handleRealtimeComplete = useCallback(async (completionData: unknown) => {
    // Fetch full result via polling endpoint
    if (jobId && propertyKey) {
      const statusResult = await getJobStatus(jobId, propertyKey)
      if (statusResult.success && statusResult.data?.result) {
        setResult({
          success: true,
          data: statusResult.data.result,
          timing: { durationMs: statusResult.data.totalDurationMs || 0 },
        })
      }
    }
    setIsRunning(false)
  }, [jobId, propertyKey])

  // Handle real-time error
  const handleRealtimeError = useCallback((error: string) => {
    setResult({ success: false, error })
    setIsRunning(false)
  }, [])

  // WebSocket hook
  const {
    state: wsState,
    connect: wsConnect,
    disconnect: wsDisconnect,
    reset: wsReset,
    isConnecting,
  } = useAnalysisWebSocket({
    url: streamUrl,
    propertyKey,
    onComplete: handleRealtimeComplete,
    onError: handleRealtimeError,
    autoReconnect: false,
  })

  // Polling hook (fallback)
  const { state: pollState, isPolling, reset: pollReset } = useAnalysisPolling({
    url: jobId ? `/api/analyze/jobs/${jobId}` : null,
    propertyKey,
    enabled: usePolling && isRunning,
    onComplete: handleRealtimeComplete,
  })

  // Use WebSocket state or polling state
  const analysisState: AnalysisState = usePolling ? pollState : wsState

  // Connect to WebSocket when streamUrl is available
  useEffect(() => {
    if (streamUrl && propertyKey && !usePolling) {
      wsConnect()
    }
  }, [streamUrl, propertyKey, usePolling, wsConnect])

  // Analysis handler (async with real-time updates)
  const handleAnalyze = async () => {
    if (!address.trim()) return

    setIsRunning(true)
    setResult(null)
    setStreamUrl(null)
    setPropertyKey(null)
    setJobId(null)
    setUsePolling(false)
    wsReset()
    pollReset()

    try {
      const response = await queueAnalysis({
        address: address.trim(),
        photoAnalysis: { enabled: true, maxComps: 10, requireBetterOrEqual: true },
        searchOptions: {
          radiusMiles: 1,
          maxComps: 10,
          monthsBack: 12,
        },
        skipCache,
      })

      if (response.success && response.streamUrl && response.propertyKey) {
        setJobId(response.jobId || null)
        setStreamUrl(response.streamUrl)
        setPropertyKey(response.propertyKey)
        // WebSocket will connect via useEffect
      } else {
        setResult({ success: false, error: response.error || 'Failed to queue analysis' })
        setIsRunning(false)
      }
    } catch (error) {
      setResult({ success: false, error: error instanceof Error ? error.message : 'Failed to start analysis' })
      setIsRunning(false)
    }
  }

  // Cancel running analysis
  const handleCancel = () => {
    wsDisconnect()
    setIsRunning(false)
    setStreamUrl(null)
    setPropertyKey(null)
    setJobId(null)
  }

  // Switch to polling fallback
  const handleSwitchToPolling = () => {
    wsDisconnect()
    setUsePolling(true)
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-semibold text-foreground">API Playground</h1>
        <p className="text-muted-foreground mt-1">Test the Flowstate API with real property data</p>
      </div>

      {/* Input Form */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Search className="w-5 h-5 text-primary" />
            /v1/analyze
          </CardTitle>
          <CardDescription>Enter an address to get property details, comparables, and valuation</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-3">
            <Input
              type="text"
              placeholder="123 Main St, Tampa, FL 33607"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !isRunning) {
                  handleAnalyze()
                }
              }}
              className="flex-1"
            />
            {isRunning ? (
              <Button variant="destructive" onClick={handleCancel}>
                <StopCircle className="w-4 h-4 mr-2" />
                Cancel
              </Button>
            ) : (
              <Button onClick={handleAnalyze} disabled={isRunning || !address.trim()}>
                {isRunning ? (
                  <>
                    <span className="animate-spin mr-2">⠋</span>
                    Analyzing...
                  </>
                ) : (
                  <>
                    <Play className="w-4 h-4 mr-2" />
                    Run
                  </>
                )}
              </Button>
            )}
          </div>
          <div className="flex items-center gap-6 flex-wrap">
            <div className="flex items-center gap-2">
              <Switch
                id="skip-cache"
                checked={skipCache}
                onCheckedChange={setSkipCache}
              />
              <Label htmlFor="skip-cache" className="flex items-center gap-1.5 text-sm text-muted-foreground cursor-pointer">
                <RefreshCw className="w-3.5 h-3.5" />
                Skip cache
              </Label>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Real-time Progress */}
      {isRunning && (
        <RealtimeStatus
          state={analysisState}
          isConnecting={isConnecting}
          onCancel={handleCancel}
          onSwitchToPolling={handleSwitchToPolling}
          usePolling={usePolling}
        />
      )}

      {/* Results */}
      {result && (
        <>
          {result.success && result.data ? (
            <div className="space-y-6">
              {/* Timing */}
              {result.timing && (
                <div className="text-sm text-muted-foreground">Completed in {result.timing.durationMs}ms</div>
              )}

              {/* Subject Property */}
              {result.data.subject && <SubjectPropertyCard subject={result.data.subject} />}

              {/* Risk Flags */}
              {result.data.riskFlags && result.data.riskFlags.length > 0 && (
                <RiskFlagsCard riskFlags={result.data.riskFlags} />
              )}

              {/* Valuation Summary */}
              {result.data.valuation && <ValuationCard valuation={result.data.valuation} />}

              {/* Comparables */}
              {result.data.comps && <ComparablesSection comps={result.data.comps} />}

              {/* Raw JSON Toggle */}
              <Card>
                <CardHeader className="cursor-pointer" onClick={() => setShowRawJson(!showRawJson)}>
                  <CardTitle className="flex items-center gap-2 text-base">
                    {showRawJson ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                    <Code className="w-4 h-4" />
                    Raw JSON Response
                  </CardTitle>
                </CardHeader>
                {showRawJson && (
                  <CardContent>
                    <pre className="bg-zinc-950 text-zinc-100 rounded-lg p-4 overflow-auto max-h-[600px] text-xs font-mono">
                      {JSON.stringify(result.data, null, 2)}
                    </pre>
                  </CardContent>
                )}
              </Card>
            </div>
          ) : (
            <Card className="border-red-500/20 bg-red-500/5">
              <CardContent className="py-6">
                <div className="text-red-500 font-medium">Error</div>
                <div className="text-muted-foreground mt-1">{result.error}</div>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  )
}

// ─── Subject Property Card ────────────────────────────────────────────────────

function SubjectPropertyCard({ subject }: { subject: SubjectData }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <MapPin className="w-5 h-5 text-primary" />
          Subject Property
          {subject.classification && (
            <ClassificationBadge classification={subject.classification} />
          )}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="col-span-2">
            <div className="text-sm text-muted-foreground">Address</div>
            <div className="font-medium">{subject.address || 'Unknown'}</div>
            {subject.subdivision && <div className="text-sm text-muted-foreground">{subject.subdivision}</div>}
            {subject.county && <div className="text-sm text-muted-foreground">{subject.county} County</div>}
          </div>
          <div>
            <div className="text-sm text-muted-foreground">Beds / Baths</div>
            <div className="font-medium">{subject.bedrooms ?? '-'} / {subject.bathrooms ?? '-'}</div>
          </div>
          <div>
            <div className="text-sm text-muted-foreground">Square Feet</div>
            <div className="font-medium">{subject.squareFeet?.toLocaleString() || '?'} sqft</div>
          </div>
          <div>
            <div className="text-sm text-muted-foreground">Year Built</div>
            <div className="font-medium">{subject.yearBuilt || '?'}</div>
          </div>
          <div>
            <div className="text-sm text-muted-foreground">Lot Size</div>
            <div className="font-medium">{subject.lotSizeAcres ? `${subject.lotSizeAcres} acres` : '?'}</div>
          </div>
          {subject.lastSale && (
            <>
              <div>
                <div className="text-sm text-muted-foreground">Last Sale</div>
                <div className="font-medium">${subject.lastSale.price?.toLocaleString() || '?'}</div>
                {subject.lastSale.date && (
                  <div className="text-xs text-muted-foreground">{subject.lastSale.date}</div>
                )}
              </div>
              {subject.lastSale.pricePerSqft && (
                <div>
                  <div className="text-sm text-muted-foreground">$/SqFt</div>
                  <div className="font-medium">${subject.lastSale.pricePerSqft.toFixed(0)}</div>
                </div>
              )}
            </>
          )}
        </div>

        {/* Subject Photos */}
        {subject.photos && subject.photos.length > 0 && (
          <div className="mt-4">
            <div className="text-sm text-muted-foreground mb-2">Photos ({subject.photos.length})</div>
            <div className="flex gap-2 overflow-x-auto pb-2">
              {subject.photos.slice(0, 6).map((photo, i) => (
                <img
                  key={i}
                  src={photo}
                  alt={`Subject photo ${i + 1}`}
                  className="w-28 h-20 object-cover rounded border flex-shrink-0"
                  onError={(e) => {
                    ;(e.target as HTMLImageElement).style.display = 'none'
                  }}
                />
              ))}
              {subject.photos.length > 6 && (
                <div className="w-28 h-20 bg-muted rounded border flex items-center justify-center text-sm text-muted-foreground flex-shrink-0">
                  +{subject.photos.length - 6} more
                </div>
              )}
            </div>
          </div>
        )}

        {/* Classification Reasoning */}
        {subject.classification?.reasoning && (
          <div className="mt-4 p-3 rounded-lg bg-muted/50 border">
            <div className="text-sm font-medium text-muted-foreground mb-1">Classification Reasoning</div>
            <div className="text-sm text-foreground/80">{subject.classification.reasoning}</div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ─── Risk Flags Card ──────────────────────────────────────────────────────────

function RiskFlagsCard({ riskFlags }: { riskFlags: string[] }) {
  return (
    <Card className="border-amber-500/30 bg-amber-500/5">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-amber-600">
          <AlertTriangle className="w-5 h-5" />
          Risk Flags
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap gap-2">
          {riskFlags.map((flag, i) => (
            <Badge key={i} variant="outline" className="bg-amber-500/10 text-amber-700 border-amber-500/30">
              {flag}
            </Badge>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}

// ─── Valuation Card ───────────────────────────────────────────────────────────

function ValuationCard({ valuation }: { valuation: ValuationData }) {
  const getRecommendationStyle = (rec?: string) => {
    if (!rec) return 'default'
    const upper = rec.toUpperCase()
    if (upper.includes('PURSUE') || upper.includes('BUY')) return 'success'
    if (upper.includes('PASS') || upper.includes('AVOID')) return 'destructive'
    if (upper.includes('REVIEW') || upper.includes('CAUTION')) return 'warning'
    return 'default'
  }

  const recStyle = getRecommendationStyle(valuation.recommendation)

  return (
    <Card className="border-primary/20 bg-primary/5">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <DollarSign className="w-5 h-5 text-primary" />
          Underwriter Valuation
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
          <div>
            <div className="text-sm text-muted-foreground">ARV</div>
            <div className="text-2xl font-bold text-primary">${valuation.arv?.toLocaleString() || '?'}</div>
            {valuation.arvPerSqft && (
              <div className="text-xs text-muted-foreground">${valuation.arvPerSqft.toFixed(0)}/sqft</div>
            )}
            {valuation.arvSource && (
              <div className="text-xs text-muted-foreground">Source: {valuation.arvSource}</div>
            )}
          </div>
          <div>
            <div className="text-sm text-muted-foreground">Max Buy Price</div>
            <div className="text-2xl font-bold">${valuation.buyPrice?.toLocaleString() || '?'}</div>
            {valuation.buyPricePercent && (
              <div className="text-xs text-muted-foreground">{valuation.buyPricePercent}% of ARV</div>
            )}
          </div>
          <div>
            <div className="text-sm text-muted-foreground">Rehab Cost</div>
            <div className="text-xl font-semibold">${valuation.rehabCost?.toLocaleString() || '?'}</div>
            {valuation.rehabLevel && (
              <Badge variant="outline" className="mt-1">
                {valuation.rehabLevel}
              </Badge>
            )}
            {valuation.rehabPerSqft && (
              <div className="text-xs text-muted-foreground">${valuation.rehabPerSqft}/sqft</div>
            )}
          </div>
          <div>
            <div className="text-sm text-muted-foreground">Projected Profit</div>
            <div className={cn('text-xl font-semibold', (valuation.projectedProfit ?? 0) > 0 ? 'text-emerald-600' : 'text-red-600')}>
              ${valuation.projectedProfit?.toLocaleString() || '?'}
            </div>
            {valuation.projectedROI && (
              <div className="text-xs text-muted-foreground">{valuation.projectedROI.toFixed(1)}% ROI</div>
            )}
          </div>
        </div>

        {/* Investment Summary Row */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-6 mt-4 pt-4 border-t">
          {valuation.totalCosts && (
            <div>
              <div className="text-sm text-muted-foreground">Total Costs</div>
              <div className="font-medium">${valuation.totalCosts.toLocaleString()}</div>
            </div>
          )}
          {valuation.totalInvestment && (
            <div>
              <div className="text-sm text-muted-foreground">Total Investment</div>
              <div className="font-medium">${valuation.totalInvestment.toLocaleString()}</div>
            </div>
          )}
          {valuation.wholesalePrice && (
            <div>
              <div className="text-sm text-muted-foreground">Wholesale Price</div>
              <div className="font-medium">${valuation.wholesalePrice.toLocaleString()}</div>
            </div>
          )}
        </div>

        {/* Recommendation */}
        {valuation.recommendation && (
          <div className="mt-4 pt-4 border-t">
            <div className="flex items-center gap-3">
              <Badge
                variant={recStyle === 'success' ? 'default' : recStyle === 'destructive' ? 'destructive' : 'outline'}
                className={cn(
                  'text-sm px-3 py-1',
                  recStyle === 'success' && 'bg-emerald-500',
                  recStyle === 'warning' && 'bg-amber-500 text-amber-950'
                )}
              >
                {valuation.recommendation}
              </Badge>
              {valuation.recommendationReason && (
                <span className="text-sm text-muted-foreground">{valuation.recommendationReason}</span>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ─── Comparables Section ──────────────────────────────────────────────────────

function ComparablesSection({ comps }: { comps: CompsData }) {
  const [expandedComps, setExpandedComps] = useState<Set<number>>(new Set())

  const toggleComp = (index: number) => {
    const newExpanded = new Set(expandedComps)
    if (newExpanded.has(index)) {
      newExpanded.delete(index)
    } else {
      newExpanded.add(index)
    }
    setExpandedComps(newExpanded)
  }

  const compItems = comps.items || []

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Home className="w-5 h-5 text-primary" />
            Comparables ({comps.count || compItems.length})
          </div>
          {comps.avgPricePerSqft && (
            <Badge variant="outline">Avg: ${comps.avgPricePerSqft.toFixed(0)}/sqft</Badge>
          )}
        </CardTitle>
        {comps.medianPrice && (
          <CardDescription>Median Price: ${comps.medianPrice.toLocaleString()}</CardDescription>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        {compItems.map((comp, index) => {
          const isExpanded = expandedComps.has(index)

          return (
            <CompCard key={index} comp={comp} index={index} isExpanded={isExpanded} onToggle={() => toggleComp(index)} />
          )
        })}
      </CardContent>
    </Card>
  )
}

// ─── Individual Comp Card ─────────────────────────────────────────────────────

function CompCard({
  comp,
  index,
  isExpanded,
  onToggle,
}: {
  comp: CompItem
  index: number
  isExpanded: boolean
  onToggle: () => void
}) {
  return (
    <div
      className={cn(
        'border rounded-lg transition-colors',
        comp.isBestComp ? 'border-amber-500/50 bg-amber-500/5 ring-2 ring-amber-500/30' : 'border-border'
      )}
    >
      {/* Comp Header */}
      <div className="p-4 cursor-pointer" onClick={onToggle}>
        <div className="flex items-start justify-between">
          <div className="flex items-start gap-3">
            <div className="mt-1 w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center text-xs font-medium text-primary">
              {index + 1}
            </div>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-medium">{comp.address || 'Unknown Address'}</span>
                {comp.isBestComp && (
                  <Badge className="bg-amber-500/20 text-amber-600 border-amber-500/30">
                    <Star className="w-3 h-3 mr-1" />
                    Best Comp
                  </Badge>
                )}
                {comp.condition && (
                  <Badge
                    variant="outline"
                    className={cn(
                      comp.condition === 'better' && 'bg-emerald-500/10 text-emerald-600 border-emerald-500/30',
                      comp.condition === 'similar' && 'bg-blue-500/10 text-blue-600 border-blue-500/30',
                      comp.condition === 'worse' && 'bg-red-500/10 text-red-600 border-red-500/30'
                    )}
                  >
                    {comp.condition}
                  </Badge>
                )}
                {comp.classification && (
                  <ClassificationBadge classification={comp.classification} showConfidence={false} />
                )}
              </div>
              <div className="text-sm text-muted-foreground mt-1">
                {comp.distanceMiles !== undefined && comp.distanceMiles !== null && `${comp.distanceMiles.toFixed(2)} mi away`}
              </div>
            </div>
          </div>
          <div className="text-right">
            <div className="font-bold text-lg">${comp.salePrice?.toLocaleString() || '?'}</div>
            {comp.pricePerSqft && (
              <div className="text-xs text-muted-foreground">${comp.pricePerSqft.toFixed(0)}/sqft</div>
            )}
            {comp.adjustedPrice && comp.salePrice !== comp.adjustedPrice && (
              <div className="text-xs text-emerald-600">Adj: ${comp.adjustedPrice.toLocaleString()}</div>
            )}
            <div className="flex items-center justify-end mt-1">
              {isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
            </div>
          </div>
        </div>

        {/* Quick stats row */}
        <div className="flex gap-4 mt-3 text-sm text-muted-foreground flex-wrap">
          <span>{comp.bedrooms ?? '-'} bd / {comp.bathrooms ?? '-'} ba</span>
          <span>{comp.squareFeet?.toLocaleString() || '?'} sqft</span>
          <span>Built {comp.yearBuilt || '?'}</span>
          {comp.saleDate && <span>Sold {new Date(comp.saleDate).toLocaleDateString()}</span>}
          {comp.qualityScore !== undefined && comp.qualityScore !== null && (
            <span className="text-primary">Quality: {comp.qualityScore}/100</span>
          )}
        </div>
      </div>

      {/* Expanded Details */}
      {isExpanded && (
        <div className="border-t px-4 py-3 bg-background/50 space-y-3">
          {/* Subdivision */}
          {comp.subdivision && (
            <div>
              <div className="text-sm font-medium text-muted-foreground">Subdivision</div>
              <div className="text-sm">{comp.subdivision}</div>
            </div>
          )}

          {/* Classification Details */}
          {comp.classification && (
            <div>
              <div className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                Classification
                <ClassificationBadge classification={comp.classification} />
              </div>
              <div className="text-sm text-foreground/80 mt-1">{comp.classification.reasoning}</div>
              {comp.weightInArv !== null && comp.weightInArv !== undefined && (
                <div className="text-xs text-muted-foreground mt-1">
                  ARV Weight: {(comp.weightInArv * 100).toFixed(1)}%
                </div>
              )}
            </div>
          )}

          {/* Selection Reason / Analysis */}
          {comp.selectionReason && (
            <div>
              <div className="text-sm font-medium text-muted-foreground">
                {comp.isBestComp ? 'Why Best Comp' : 'Analysis'}
              </div>
              <div className="text-sm text-foreground/80">{comp.selectionReason}</div>
            </div>
          )}

          {/* Key Features */}
          {comp.keyFeatures && comp.keyFeatures.length > 0 && (
            <div>
              <div className="text-sm font-medium text-muted-foreground mb-1">Key Features</div>
              <div className="flex flex-wrap gap-1">
                {comp.keyFeatures.map((feature, i) => (
                  <Badge key={i} variant="outline" className="text-xs">
                    {feature}
                  </Badge>
                ))}
              </div>
            </div>
          )}

          {/* Appraisal Rules */}
          {comp.appraisalRules && (
            <div className="space-y-2">
              <div className="text-sm font-medium text-muted-foreground">Appraisal Rules</div>

              {/* Filters */}
              <div className="space-y-1">
                <div className="text-xs font-medium text-muted-foreground">Filters Applied</div>
                <div className="grid gap-1">
                  {comp.appraisalRules.filters.map((filter, i) => (
                    <div
                      key={i}
                      className={cn(
                        'text-xs px-2 py-1 rounded flex items-center justify-between',
                        filter.passed ? 'bg-emerald-500/10 text-emerald-700' : 'bg-red-500/10 text-red-700'
                      )}
                    >
                      <span className="font-medium">{formatFilterType(filter.type)}</span>
                      <span>
                        {filter.passed ? '✓' : '✗'}
                        {filter.actualValue !== null && filter.actualValue !== undefined && (
                          <span className="ml-1 opacity-70">
                            ({String(filter.actualValue)}{filter.threshold ? ` / ${filter.threshold}` : ''})
                          </span>
                        )}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Adjustments */}
              {comp.appraisalRules.adjustments.length > 0 && (
                <div className="space-y-1">
                  <div className="text-xs font-medium text-muted-foreground">Price Adjustments</div>
                  <div className="grid gap-1">
                    {comp.appraisalRules.adjustments.map((adj, i) => (
                      <div
                        key={i}
                        className="text-xs px-2 py-1 rounded bg-blue-500/10 text-blue-700 flex items-center justify-between"
                      >
                        <span className="font-medium">{formatAdjustmentType(adj.type)}</span>
                        <span className={adj.amount >= 0 ? 'text-emerald-600' : 'text-red-600'}>
                          {adj.amount >= 0 ? '+' : ''}{formatCurrency(adj.amount)}
                        </span>
                      </div>
                    ))}
                  </div>
                  <div className="text-xs text-right text-muted-foreground">
                    Total Adjustment:{' '}
                    <span className={comp.appraisalRules.totalAdjustment >= 0 ? 'text-emerald-600' : 'text-red-600'}>
                      {comp.appraisalRules.totalAdjustment >= 0 ? '+' : ''}
                      {formatCurrency(comp.appraisalRules.totalAdjustment)}
                    </span>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Photos */}
          {comp.photos && comp.photos.length > 0 && (
            <div>
              <div className="text-sm font-medium mb-2">Photos</div>
              <div className="flex gap-2 overflow-x-auto pb-2">
                {comp.photos.slice(0, 5).map((photo, i) => (
                  <img
                    key={i}
                    src={photo}
                    alt={`Comp photo ${i + 1}`}
                    className="w-24 h-16 object-cover rounded border flex-shrink-0"
                    onError={(e) => {
                      ;(e.target as HTMLImageElement).style.display = 'none'
                    }}
                  />
                ))}
                {comp.photos.length > 5 && (
                  <div className="w-24 h-16 bg-muted rounded border flex items-center justify-center text-sm text-muted-foreground flex-shrink-0">
                    +{comp.photos.length - 5} more
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
