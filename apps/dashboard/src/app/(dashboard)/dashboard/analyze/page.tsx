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
  SlidersHorizontal,
  Check,
  Plus,
  Trash2,
  Loader2,
  Pencil,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  createAppraisalPreset,
  setDefaultAppraisalPreset,
  deleteAppraisalPreset,
  getAppraisalDefaults,
  getAppraisalPreset,
  updateAppraisalPreset,
  type AppraisalDefaults,
  type AppraisalPreset,
  type FilterType,
  type AdjustmentType,
} from '@/lib/client-api'
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

// Preset interface
interface PresetOption {
  id: string
  name: string
  isDefault: boolean
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

  // Appraisal presets
  const [presets, setPresets] = useState<PresetOption[]>([])
  const [selectedPresetId, setSelectedPresetId] = useState<string | null>(null)
  const [presetsLoading, setPresetsLoading] = useState(true)

  // Preset management
  const [showCreateDialog, setShowCreateDialog] = useState(false)
  const [newPresetName, setNewPresetName] = useState('')
  const [newPresetIsDefault, setNewPresetIsDefault] = useState(false)
  const [presetActionLoading, setPresetActionLoading] = useState(false)
  const [presetToDelete, setPresetToDelete] = useState<PresetOption | null>(null)

  // Preset rules editor state
  const [appraisalDefaults, setAppraisalDefaults] = useState<AppraisalDefaults | null>(null)
  const [editingFilters, setEditingFilters] = useState<Array<{ filterType: FilterType; enabled: boolean; value: number }>>([])
  const [editingAdjustments, setEditingAdjustments] = useState<Array<{ adjustmentType: AdjustmentType; enabled: boolean; amount: number; percentage: number }>>([])
  const [showRulesEditor, setShowRulesEditor] = useState(false)
  const [editingPreset, setEditingPreset] = useState<PresetOption | null>(null) // null = create mode, preset = edit mode

  // Fetch presets on mount
  useEffect(() => {
    async function fetchPresets() {
      try {
        const response = await fetch('/api/presets')
        if (response.ok) {
          const data = (await response.json()) as { presets?: PresetOption[] }
          setPresets(data.presets || [])
          // Auto-select default preset
          const defaultPreset = data.presets?.find((p) => p.isDefault)
          if (defaultPreset) {
            setSelectedPresetId(defaultPreset.id)
          }
        }
      } catch {
        // Silently fail - presets are optional
      } finally {
        setPresetsLoading(false)
      }
    }
    fetchPresets()
  }, [])

  // Refresh presets helper
  const refreshPresets = useCallback(async () => {
    try {
      const response = await fetch('/api/presets')
      if (response.ok) {
        const data = (await response.json()) as { presets?: PresetOption[] }
        setPresets(data.presets || [])
        return data.presets || []
      }
    } catch {
      // Silently fail
    }
    return []
  }, [])

  // Load appraisal defaults
  const loadDefaults = useCallback(async () => {
    if (appraisalDefaults) return appraisalDefaults
    try {
      const defaults = await getAppraisalDefaults()
      setAppraisalDefaults(defaults)
      return defaults
    } catch (error) {
      console.error('Failed to load appraisal defaults:', error)
      return null
    }
  }, [appraisalDefaults])

  // Open create dialog
  const handleOpenCreateDialog = async () => {
    setEditingPreset(null)
    setShowCreateDialog(true)
    setNewPresetName('')
    setNewPresetIsDefault(false)
    setShowRulesEditor(false)

    const defaults = await loadDefaults()
    if (defaults) {
      setEditingFilters(defaults.filters.map(f => ({
        filterType: f.type,
        enabled: f.enabled,
        value: f.value,
      })))
      setEditingAdjustments(defaults.adjustments.map(a => ({
        adjustmentType: a.type,
        enabled: a.enabled,
        amount: a.amount,
        percentage: a.percent ?? 0,
      })))
    }
  }

  // Open edit dialog for a preset
  const handleOpenEditDialog = async (preset: PresetOption) => {
    setEditingPreset(preset)
    setShowCreateDialog(true)
    setNewPresetName(preset.name)
    setNewPresetIsDefault(preset.isDefault)
    setShowRulesEditor(true)
    setPresetActionLoading(true)

    try {
      // Load defaults for labels
      await loadDefaults()
      // Load preset's actual rules
      const fullPreset = await getAppraisalPreset(preset.id)
      setEditingFilters(fullPreset.filters.map(f => ({
        filterType: f.filterType as FilterType,
        enabled: f.enabled,
        value: f.value,
      })))
      setEditingAdjustments(fullPreset.adjustments.map(a => ({
        adjustmentType: a.adjustmentType as AdjustmentType,
        enabled: a.enabled,
        amount: a.amount,
        percentage: a.percentage,
      })))
    } catch (error) {
      console.error('Failed to load preset:', error)
    } finally {
      setPresetActionLoading(false)
    }
  }

  // Handle create or update preset
  const handleSavePreset = async () => {
    if (!newPresetName.trim()) return

    setPresetActionLoading(true)
    try {
      if (editingPreset) {
        // Update existing preset
        await updateAppraisalPreset(editingPreset.id, {
          name: newPresetName.trim(),
          isDefault: newPresetIsDefault,
          filters: editingFilters,
          adjustments: editingAdjustments,
        })
        const updatedPresets = await refreshPresets()
        if (newPresetIsDefault) {
          setPresets(updatedPresets.map(p => ({
            ...p,
            isDefault: p.id === editingPreset.id
          })))
        }
      } else {
        // Create new preset
        const created = await createAppraisalPreset({
          name: newPresetName.trim(),
          isDefault: newPresetIsDefault,
          filters: editingFilters,
          adjustments: editingAdjustments,
        })
        const updatedPresets = await refreshPresets()
        setSelectedPresetId(created.id)
        if (newPresetIsDefault) {
          setPresets(updatedPresets.map(p => ({
            ...p,
            isDefault: p.id === created.id
          })))
        }
      }
      setShowCreateDialog(false)
      setEditingPreset(null)
      setNewPresetName('')
      setNewPresetIsDefault(false)
    } catch (error) {
      console.error('Failed to save preset:', error)
    } finally {
      setPresetActionLoading(false)
    }
  }

  // Legacy handler for backwards compatibility
  const handleCreatePreset = handleSavePreset

  // Update a filter value
  const updateFilter = (index: number, field: 'enabled' | 'value', value: boolean | number) => {
    setEditingFilters(prev => prev.map((f, i) =>
      i === index ? { ...f, [field]: value } : f
    ))
  }

  // Update an adjustment value
  const updateAdjustment = (index: number, field: 'enabled' | 'amount' | 'percentage', value: boolean | number) => {
    setEditingAdjustments(prev => prev.map((a, i) =>
      i === index ? { ...a, [field]: value } : a
    ))
  }

  // Handle set default preset
  const handleSetDefaultPreset = async (presetId: string) => {
    setPresetActionLoading(true)
    try {
      await setDefaultAppraisalPreset(presetId)
      setPresets(presets.map(p => ({
        ...p,
        isDefault: p.id === presetId
      })))
    } catch (error) {
      console.error('Failed to set default preset:', error)
    } finally {
      setPresetActionLoading(false)
    }
  }

  // Handle delete preset
  const handleDeletePreset = async () => {
    if (!presetToDelete) return

    setPresetActionLoading(true)
    try {
      await deleteAppraisalPreset(presetToDelete.id)
      // If deleted preset was selected, clear selection
      if (selectedPresetId === presetToDelete.id) {
        setSelectedPresetId(null)
      }
      await refreshPresets()
      setPresetToDelete(null)
    } catch (error) {
      console.error('Failed to delete preset:', error)
    } finally {
      setPresetActionLoading(false)
    }
  }

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
        appraisalPresetId: selectedPresetId || undefined,
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
    <div className="space-y-8">
      {/* Header */}
      <div className="space-y-1">
        <h1 className="text-heading-lg text-foreground tracking-tight">API Playground</h1>
        <p className="text-body text-foreground-tertiary">Test the Flowstate API with real property data</p>
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
            {/* Appraisal Preset Selection */}
            <div className="flex items-center gap-2">
              <SlidersHorizontal className="w-3.5 h-3.5 text-foreground-tertiary" />
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button className="flex items-center gap-2 text-body-sm text-foreground-secondary hover:text-foreground transition-colors">
                    {presetsLoading ? (
                      'Loading...'
                    ) : selectedPresetId ? (
                      presets.find((p) => p.id === selectedPresetId)?.name || 'Select preset'
                    ) : (
                      'Default rules'
                    )}
                    <ChevronDown className="w-3.5 h-3.5" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-64">
                  <DropdownMenuLabel className="text-caption">Appraisal Rules</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={() => setSelectedPresetId(null)}
                    className="flex items-center justify-between"
                  >
                    <span>Default rules</span>
                    {!selectedPresetId && <Check className="w-4 h-4 text-primary" />}
                  </DropdownMenuItem>
                  {presets.length > 0 && <DropdownMenuSeparator />}
                  {presets.map((preset) => (
                    <div key={preset.id} className="group relative">
                      <DropdownMenuItem
                        onClick={() => setSelectedPresetId(preset.id)}
                        className="flex items-center justify-between pr-16"
                      >
                        <span className="flex items-center gap-2 truncate">
                          {preset.name}
                          {preset.isDefault && (
                            <Badge variant="outline" className="text-caption-sm py-0 px-1 flex-shrink-0">
                              Default
                            </Badge>
                          )}
                        </span>
                        {selectedPresetId === preset.id && <Check className="w-4 h-4 text-primary flex-shrink-0" />}
                      </DropdownMenuItem>
                      {/* Preset actions */}
                      <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            handleOpenEditDialog(preset)
                          }}
                          className="p-1 rounded hover:bg-secondary text-foreground-tertiary hover:text-foreground transition-colors"
                          title="Edit preset"
                        >
                          <Pencil className="w-3 h-3" />
                        </button>
                        {!preset.isDefault && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              handleSetDefaultPreset(preset.id)
                            }}
                            className="p-1 rounded hover:bg-secondary text-foreground-tertiary hover:text-foreground transition-colors"
                            title="Set as default"
                          >
                            <Star className="w-3 h-3" />
                          </button>
                        )}
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            setPresetToDelete(preset)
                          }}
                          className="p-1 rounded hover:bg-red-500/10 text-foreground-tertiary hover:text-red-500 transition-colors"
                          title="Delete preset"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>
                    </div>
                  ))}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={handleOpenCreateDialog}
                    className="text-primary"
                  >
                    <Plus className="w-4 h-4 mr-2" />
                    Create new preset
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>

            {/* Skip Cache Toggle */}
            <div className="flex items-center gap-2">
              <Switch
                id="skip-cache"
                checked={skipCache}
                onCheckedChange={setSkipCache}
              />
              <Label htmlFor="skip-cache" className="flex items-center gap-1.5 text-body-sm text-foreground-tertiary cursor-pointer">
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
                <div className="text-caption text-foreground-tertiary">Completed in {result.timing.durationMs}ms</div>
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

      {/* Create/Edit Preset Dialog */}
      <Dialog open={showCreateDialog} onOpenChange={(open) => {
        setShowCreateDialog(open)
        if (!open) setEditingPreset(null)
      }}>
        <DialogContent className={cn("sm:max-w-lg transition-all duration-200", showRulesEditor && "sm:max-w-xl max-h-[85vh] overflow-y-auto")}>
          <DialogHeader>
            <DialogTitle>{editingPreset ? 'Edit Preset' : 'Create Preset'}</DialogTitle>
            <DialogDescription>
              {editingPreset ? 'Update your appraisal rules.' : 'Create a new preset with custom rules.'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="flex gap-3">
              <div className="flex-1">
                <Input
                  id="preset-name"
                  placeholder="Preset name"
                  value={newPresetName}
                  onChange={(e) => setNewPresetName(e.target.value)}
                />
              </div>
              <div className="flex items-center gap-2">
                <Switch
                  id="preset-default"
                  checked={newPresetIsDefault}
                  onCheckedChange={setNewPresetIsDefault}
                />
                <Label htmlFor="preset-default" className="text-caption text-foreground-secondary cursor-pointer whitespace-nowrap">
                  Default
                </Label>
              </div>
            </div>

            {/* Toggle rules editor */}
            <button
              type="button"
              onClick={() => setShowRulesEditor(!showRulesEditor)}
              className="flex items-center gap-1.5 text-caption text-primary hover:text-primary/80 transition-colors"
            >
              <SlidersHorizontal className="w-3.5 h-3.5" />
              {showRulesEditor ? 'Hide rules' : 'Customize rules'}
              <ChevronDown className={cn("w-3.5 h-3.5 transition-transform", showRulesEditor && "rotate-180")} />
            </button>

            {/* Rules Editor - Compact */}
            {showRulesEditor && appraisalDefaults && (
              <div className="space-y-4 pt-2 border-t border-border">
                {/* Filters - Compact Grid */}
                <div className="space-y-2">
                  <h4 className="text-caption font-medium text-foreground-secondary">Filters</h4>
                  <div className="grid gap-1.5">
                    {editingFilters.map((filter, index) => {
                      const label = appraisalDefaults.filterLabels[filter.filterType]
                      return (
                        <div key={filter.filterType} className="flex items-center gap-2 py-1.5 px-2 rounded bg-secondary/30">
                          <Switch
                            checked={filter.enabled}
                            onCheckedChange={(checked) => updateFilter(index, 'enabled', checked)}
                            className="scale-75"
                          />
                          <span className="flex-1 text-caption truncate" title={label?.description}>
                            {label?.shortLabel || label?.label || filter.filterType}
                          </span>
                          {filter.filterType !== 'subdivision_match' && (
                            <div className="flex items-center gap-1">
                              <Input
                                type="number"
                                value={filter.value}
                                onChange={(e) => updateFilter(index, 'value', parseFloat(e.target.value) || 0)}
                                className="w-16 h-6 text-caption px-1.5"
                                disabled={!filter.enabled}
                              />
                              <span className="text-caption-sm text-foreground-tertiary w-10">{label?.unit}</span>
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>

                {/* Adjustments - Compact Grid */}
                <div className="space-y-2">
                  <h4 className="text-caption font-medium text-foreground-secondary">Adjustments</h4>
                  <div className="grid gap-1.5">
                    {editingAdjustments.map((adj, index) => {
                      const label = appraisalDefaults.adjustmentLabels[adj.adjustmentType]
                      if (label?.unavailable) return null
                      const isPercentage = label?.isPercentage
                      return (
                        <div key={adj.adjustmentType} className="flex items-center gap-2 py-1.5 px-2 rounded bg-secondary/30">
                          <Switch
                            checked={adj.enabled}
                            onCheckedChange={(checked) => updateAdjustment(index, 'enabled', checked)}
                            className="scale-75"
                          />
                          <span className="flex-1 text-caption truncate" title={label?.description}>
                            {label?.label || adj.adjustmentType}
                          </span>
                          <div className="flex items-center gap-1">
                            {isPercentage ? (
                              <>
                                <Input
                                  type="number"
                                  value={adj.percentage}
                                  onChange={(e) => updateAdjustment(index, 'percentage', parseFloat(e.target.value) || 0)}
                                  className="w-14 h-6 text-caption px-1.5"
                                  disabled={!adj.enabled}
                                />
                                <span className="text-caption-sm text-foreground-tertiary">%</span>
                              </>
                            ) : (
                              <>
                                <span className="text-caption-sm text-foreground-tertiary">$</span>
                                <Input
                                  type="number"
                                  value={adj.amount}
                                  onChange={(e) => updateAdjustment(index, 'amount', parseFloat(e.target.value) || 0)}
                                  className="w-20 h-6 text-caption px-1.5"
                                  disabled={!adj.enabled}
                                />
                              </>
                            )}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setShowCreateDialog(false)}>
              Cancel
            </Button>
            <Button size="sm" onClick={handleSavePreset} disabled={!newPresetName.trim() || presetActionLoading}>
              {presetActionLoading ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : editingPreset ? (
                'Save'
              ) : (
                'Create'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Preset Confirmation Dialog */}
      <Dialog open={!!presetToDelete} onOpenChange={() => setPresetToDelete(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete Preset</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete &ldquo;{presetToDelete?.name}&rdquo;? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPresetToDelete(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDeletePreset} disabled={presetActionLoading}>
              {presetActionLoading ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Deleting...
                </>
              ) : (
                'Delete Preset'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ─── Subject Property Card ────────────────────────────────────────────────────

function SubjectPropertyCard({ subject }: { subject: SubjectData }) {
  return (
    <Card>
      <CardHeader className="pb-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <MapPin className="w-4 h-4 text-primary flex-shrink-0" />
              <span className="text-caption text-foreground-tertiary">Subject Property</span>
            </div>
            <CardTitle className="text-heading-sm leading-tight">{subject.address || 'Unknown Address'}</CardTitle>
            <div className="flex items-center gap-2 mt-1.5 flex-wrap">
              {subject.subdivision && (
                <Badge variant="outline" className="text-caption-sm font-normal">
                  {subject.subdivision}
                </Badge>
              )}
              {subject.county && (
                <span className="text-caption text-foreground-tertiary">{subject.county} County</span>
              )}
            </div>
          </div>
          {subject.classification && (
            <ClassificationBadge classification={subject.classification} />
          )}
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        {/* Property Stats - Compact Grid */}
        <div className="grid grid-cols-3 md:grid-cols-6 gap-px bg-border/50 rounded-xl overflow-hidden">
          <StatCell label="Beds" value={subject.bedrooms ?? '-'} />
          <StatCell label="Baths" value={subject.bathrooms ?? '-'} />
          <StatCell label="Sq Ft" value={subject.squareFeet?.toLocaleString() || '-'} />
          <StatCell label="Year" value={subject.yearBuilt || '-'} />
          <StatCell label="Lot" value={subject.lotSizeAcres ? `${subject.lotSizeAcres} ac` : '-'} />
          <StatCell
            label="$/Sq Ft"
            value={subject.lastSale?.pricePerSqft ? `$${subject.lastSale.pricePerSqft.toFixed(0)}` : '-'}
          />
        </div>

        {/* Last Sale Info */}
        {subject.lastSale?.price && (
          <div className="mt-4 p-3 rounded-xl bg-secondary/50 flex items-center justify-between">
            <div className="text-caption text-foreground-tertiary">Last Sale</div>
            <div className="text-right">
              <span className="text-body font-semibold">${subject.lastSale.price.toLocaleString()}</span>
              {subject.lastSale.date && (
                <span className="text-caption text-foreground-tertiary ml-2">({subject.lastSale.date})</span>
              )}
            </div>
          </div>
        )}

        {/* Subject Photos */}
        {subject.photos && subject.photos.length > 0 && (
          <div className="mt-4">
            <div className="flex gap-2 overflow-x-auto pb-1">
              {subject.photos.slice(0, 6).map((photo, i) => (
                <img
                  key={i}
                  src={photo}
                  alt={`Subject photo ${i + 1}`}
                  className="w-24 h-16 object-cover rounded-lg border border-border/50 flex-shrink-0"
                  onError={(e) => {
                    ;(e.target as HTMLImageElement).style.display = 'none'
                  }}
                />
              ))}
              {subject.photos.length > 6 && (
                <div className="w-24 h-16 bg-secondary rounded-lg border border-border/50 flex items-center justify-center text-caption text-foreground-tertiary flex-shrink-0">
                  +{subject.photos.length - 6}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Classification Reasoning */}
        {subject.classification?.reasoning && (
          <div className="mt-4 p-3 rounded-xl bg-primary/5 border border-primary/10">
            <div className="text-caption font-medium text-primary mb-1">AI Classification</div>
            <div className="text-caption text-foreground-secondary leading-relaxed">{subject.classification.reasoning}</div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// Compact stat cell component
function StatCell({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="bg-background p-3 text-center">
      <div className="text-caption-sm text-foreground-tertiary mb-0.5">{label}</div>
      <div className="text-body-sm font-medium">{value}</div>
    </div>
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
    <Card className="border-primary/20 bg-primary/[0.02]">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <DollarSign className="w-5 h-5 text-primary" />
          Underwriter Valuation
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-8">
          <div>
            <div className="text-caption text-foreground-tertiary mb-1">ARV</div>
            <div className="text-display-sm font-bold text-primary">${valuation.arv?.toLocaleString() || '-'}</div>
            {valuation.arvPerSqft && (
              <div className="text-caption-sm text-foreground-tertiary mt-1">${valuation.arvPerSqft.toFixed(0)}/sqft</div>
            )}
            {valuation.arvSource && (
              <div className="text-caption-sm text-foreground-tertiary">Source: {valuation.arvSource}</div>
            )}
          </div>
          <div>
            <div className="text-caption text-foreground-tertiary mb-1">Max Buy Price</div>
            <div className="text-display-sm font-bold">${valuation.buyPrice?.toLocaleString() || '-'}</div>
            {valuation.buyPricePercent && (
              <div className="text-caption-sm text-foreground-tertiary mt-1">{valuation.buyPricePercent}% of ARV</div>
            )}
          </div>
          <div>
            <div className="text-caption text-foreground-tertiary mb-1">Rehab Cost</div>
            <div className="text-heading font-semibold">${valuation.rehabCost?.toLocaleString() || '-'}</div>
            {valuation.rehabLevel && (
              <Badge variant="outline" className="mt-1.5">
                {valuation.rehabLevel}
              </Badge>
            )}
            {valuation.rehabPerSqft && (
              <div className="text-caption-sm text-foreground-tertiary mt-1">${valuation.rehabPerSqft}/sqft</div>
            )}
          </div>
          <div>
            <div className="text-caption text-foreground-tertiary mb-1">Projected Profit</div>
            <div className={cn('text-heading font-semibold', (valuation.projectedProfit ?? 0) > 0 ? 'text-emerald-600' : 'text-red-600')}>
              ${valuation.projectedProfit?.toLocaleString() || '-'}
            </div>
            {valuation.projectedROI && (
              <div className="text-caption-sm text-foreground-tertiary mt-1">{valuation.projectedROI.toFixed(1)}% ROI</div>
            )}
          </div>
        </div>

        {/* Investment Summary Row */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-6 mt-6 pt-6 border-t border-border/50">
          {valuation.totalCosts && (
            <div>
              <div className="text-caption text-foreground-tertiary mb-1">Total Costs</div>
              <div className="text-body font-medium">${valuation.totalCosts.toLocaleString()}</div>
            </div>
          )}
          {valuation.totalInvestment && (
            <div>
              <div className="text-caption text-foreground-tertiary mb-1">Total Investment</div>
              <div className="text-body font-medium">${valuation.totalInvestment.toLocaleString()}</div>
            </div>
          )}
          {valuation.wholesalePrice && (
            <div>
              <div className="text-caption text-foreground-tertiary mb-1">Wholesale Price</div>
              <div className="text-body font-medium">${valuation.wholesalePrice.toLocaleString()}</div>
            </div>
          )}
        </div>

        {/* Recommendation */}
        {valuation.recommendation && (
          <div className="mt-6 pt-6 border-t border-border/50">
            <div className="flex items-center gap-3 flex-wrap">
              <Badge
                variant={recStyle === 'success' ? 'default' : recStyle === 'destructive' ? 'destructive' : 'outline'}
                className={cn(
                  'text-body-sm px-3 py-1',
                  recStyle === 'success' && 'bg-emerald-500',
                  recStyle === 'warning' && 'bg-amber-500 text-amber-950'
                )}
              >
                {valuation.recommendation}
              </Badge>
              {valuation.recommendationReason && (
                <span className="text-body-sm text-foreground-tertiary">{valuation.recommendationReason}</span>
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
      <CardHeader className="pb-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Home className="w-5 h-5 text-primary" />
            <CardTitle className="text-base">Comparables ({comps.count || compItems.length})</CardTitle>
          </div>
          <div className="flex items-center gap-3 text-caption text-foreground-tertiary">
            {comps.medianPrice && (
              <span>Median: <span className="font-medium text-foreground">${comps.medianPrice.toLocaleString()}</span></span>
            )}
            {comps.avgPricePerSqft && (
              <Badge variant="outline" className="text-caption-sm">Avg: ${comps.avgPricePerSqft.toFixed(0)}/sqft</Badge>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-2 pt-0">
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
        'border rounded-2xl transition-all duration-200',
        comp.isBestComp ? 'border-amber-500/50 bg-amber-500/5 ring-1 ring-amber-500/20' : 'border-border/60 hover:border-border'
      )}
    >
      {/* Comp Header */}
      <div className="p-4 md:p-5 cursor-pointer" onClick={onToggle}>
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3 flex-1 min-w-0">
            <div className="mt-0.5 w-7 h-7 rounded-lg bg-primary/10 flex items-center justify-center text-caption font-semibold text-primary flex-shrink-0">
              {index + 1}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap mb-1">
                <span className="text-body font-medium">{comp.address || 'Unknown Address'}</span>
                {comp.isBestComp && (
                  <Badge className="bg-amber-500/15 text-amber-600 border-amber-500/30 text-caption-sm">
                    <Star className="w-3 h-3 mr-1" />
                    Best
                  </Badge>
                )}
                {comp.classification && (
                  <ClassificationBadge classification={comp.classification} showConfidence={false} />
                )}
              </div>
              <div className="flex items-center gap-2 text-caption text-foreground-tertiary">
                {comp.distanceMiles !== undefined && comp.distanceMiles !== null && (
                  <span>{comp.distanceMiles.toFixed(2)} mi away</span>
                )}
                {comp.subdivision && (
                  <>
                    <span className="text-border">•</span>
                    <span>{comp.subdivision}</span>
                  </>
                )}
              </div>
              {/* Badges row */}
              {(comp.appraisalRules?.filters.some(f => f.type === 'subdivision_match' && f.passed) || comp.condition) && (
                <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                  {comp.appraisalRules?.filters.some(f => f.type === 'subdivision_match' && f.passed) && (
                    <Badge className="bg-emerald-500/15 text-emerald-600 border-emerald-500/30 text-caption-sm">
                      <Check className="w-3 h-3 mr-1" />
                      Subdivision Match
                    </Badge>
                  )}
                  {comp.condition && (
                    <Badge
                      variant="outline"
                      className={cn(
                        'text-caption-sm',
                        comp.condition === 'better' && 'bg-emerald-500/10 text-emerald-600 border-emerald-500/30',
                        comp.condition === 'similar' && 'bg-blue-500/10 text-blue-600 border-blue-500/30',
                        comp.condition === 'worse' && 'bg-red-500/10 text-red-600 border-red-500/30'
                      )}
                    >
                      {comp.condition}
                    </Badge>
                  )}
                </div>
              )}
            </div>
          </div>
          <div className="flex items-start gap-2 flex-shrink-0">
            <div className="text-right">
              <div className="text-heading-sm font-bold">${comp.salePrice?.toLocaleString() || '-'}</div>
              {comp.pricePerSqft && (
                <div className="text-caption text-foreground-tertiary">${comp.pricePerSqft.toFixed(0)}/sqft</div>
              )}
              {comp.adjustedPrice && comp.salePrice !== comp.adjustedPrice && (
                <div className="text-caption text-emerald-600">Adj: ${comp.adjustedPrice.toLocaleString()}</div>
              )}
            </div>
            <div className="text-foreground-tertiary mt-0.5">
              {isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
            </div>
          </div>
        </div>

        {/* Quick stats row */}
        <div className="flex items-center gap-4 md:gap-8 mt-4 pt-4 border-t border-border/40 text-body-sm text-foreground-secondary flex-wrap">
          <span>{comp.bedrooms ?? '-'} bd / {comp.bathrooms ?? '-'} ba</span>
          <span>{comp.squareFeet?.toLocaleString() || '-'} sqft</span>
          <span>Built {comp.yearBuilt || '-'}</span>
          {comp.saleDate && <span>Sold {new Date(comp.saleDate).toLocaleDateString()}</span>}
          {comp.qualityScore !== undefined && comp.qualityScore !== null && (
            <span className="text-primary font-medium">Quality: {comp.qualityScore}/100</span>
          )}
        </div>
      </div>

      {/* Expanded Details */}
      {isExpanded && (
        <div className="border-t border-border/40 px-5 py-4 bg-secondary/30 space-y-4">
          {/* Subdivision */}
          {comp.subdivision && (
            <div>
              <div className="text-caption text-foreground-tertiary mb-1">Subdivision</div>
              <div className="text-body-sm">{comp.subdivision}</div>
            </div>
          )}

          {/* Classification Details */}
          {comp.classification && (
            <div>
              <div className="text-caption text-foreground-tertiary flex items-center gap-2 mb-1">
                Classification
                <ClassificationBadge classification={comp.classification} />
              </div>
              <div className="text-body-sm text-foreground-secondary mt-1">{comp.classification.reasoning}</div>
              {comp.weightInArv !== null && comp.weightInArv !== undefined && (
                <div className="text-caption-sm text-foreground-tertiary mt-1">
                  ARV Weight: {(comp.weightInArv * 100).toFixed(1)}%
                </div>
              )}
            </div>
          )}

          {/* Selection Reason / Analysis */}
          {comp.selectionReason && (
            <div>
              <div className="text-caption text-foreground-tertiary mb-1">
                {comp.isBestComp ? 'Why Best Comp' : 'Analysis'}
              </div>
              <div className="text-body-sm text-foreground-secondary">{comp.selectionReason}</div>
            </div>
          )}

          {/* Key Features */}
          {comp.keyFeatures && comp.keyFeatures.length > 0 && (
            <div>
              <div className="text-caption text-foreground-tertiary mb-2">Key Features</div>
              <div className="flex flex-wrap gap-1.5">
                {comp.keyFeatures.map((feature, i) => (
                  <Badge key={i} variant="outline" className="text-caption-sm">
                    {feature}
                  </Badge>
                ))}
              </div>
            </div>
          )}

          {/* Appraisal Rules */}
          {comp.appraisalRules && (
            <div className="space-y-3">
              <div className="text-caption font-medium text-foreground-secondary">Appraisal Rules</div>

              {/* Filters */}
              <div className="space-y-1.5">
                <div className="text-caption-sm text-foreground-tertiary">Filters Applied</div>
                <div className="grid gap-1.5">
                  {comp.appraisalRules.filters.map((filter, i) => (
                    <div
                      key={i}
                      className={cn(
                        'text-caption-sm px-2.5 py-1.5 rounded-lg flex items-center justify-between',
                        filter.passed ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400' : 'bg-red-500/10 text-red-700 dark:text-red-400'
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
                <div className="space-y-1.5">
                  <div className="text-caption-sm text-foreground-tertiary">Price Adjustments</div>
                  <div className="grid gap-1.5">
                    {comp.appraisalRules.adjustments.map((adj, i) => (
                      <div
                        key={i}
                        className="text-caption-sm px-2.5 py-1.5 rounded-lg bg-blue-500/10 text-blue-700 dark:text-blue-400 flex items-center justify-between"
                      >
                        <span className="font-medium">{formatAdjustmentType(adj.type)}</span>
                        <span className={adj.amount >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}>
                          {adj.amount >= 0 ? '+' : ''}{formatCurrency(adj.amount)}
                        </span>
                      </div>
                    ))}
                  </div>
                  <div className="text-caption-sm text-right text-foreground-tertiary">
                    Total Adjustment:{' '}
                    <span className={comp.appraisalRules.totalAdjustment >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}>
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
              <div className="text-caption text-foreground-tertiary mb-2">Photos</div>
              <div className="flex gap-2 overflow-x-auto pb-2">
                {comp.photos.slice(0, 5).map((photo, i) => (
                  <img
                    key={i}
                    src={photo}
                    alt={`Comp photo ${i + 1}`}
                    className="w-28 h-20 object-cover rounded-lg border border-border/50 flex-shrink-0"
                    onError={(e) => {
                      ;(e.target as HTMLImageElement).style.display = 'none'
                    }}
                  />
                ))}
                {comp.photos.length > 5 && (
                  <div className="w-28 h-20 bg-secondary rounded-lg border border-border/50 flex items-center justify-center text-caption text-foreground-tertiary flex-shrink-0">
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
