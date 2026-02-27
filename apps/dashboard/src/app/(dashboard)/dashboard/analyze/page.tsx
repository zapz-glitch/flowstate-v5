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
  ChevronLeft,
  Code,
  RefreshCw,
  StopCircle,
  SlidersHorizontal,
  Check,
  Plus,
  Trash2,
  Loader2,
  Pencil,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
// Card components not used - using glass UI divs instead
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
  type RehabLevelEstimate,
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

// ─── Photo Gallery Lightbox Component ──────────────────────────────────────────

function PhotoGallery({ photos, className }: { photos: string[]; className?: string }) {
  const [lightboxOpen, setLightboxOpen] = useState(false)
  const [currentIndex, setCurrentIndex] = useState(0)

  const openLightbox = (index: number) => {
    setCurrentIndex(index)
    setLightboxOpen(true)
  }

  const goToPrevious = () => {
    setCurrentIndex((prev) => (prev === 0 ? photos.length - 1 : prev - 1))
  }

  const goToNext = () => {
    setCurrentIndex((prev) => (prev === photos.length - 1 ? 0 : prev + 1))
  }

  // Handle keyboard navigation
  useEffect(() => {
    if (!lightboxOpen) return

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') goToPrevious()
      else if (e.key === 'ArrowRight') goToNext()
      else if (e.key === 'Escape') setLightboxOpen(false)
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [lightboxOpen, photos.length])

  if (!photos || photos.length === 0) return null

  return (
    <>
      <div className={cn('flex gap-1.5 overflow-x-auto pb-1', className)}>
        {photos.slice(0, 6).map((photo, i) => (
          <button
            key={i}
            onClick={() => openLightbox(i)}
            className="relative group flex-shrink-0 rounded-lg overflow-hidden focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2"
          >
            <img
              src={photo}
              alt={`Photo ${i + 1}`}
              className="w-20 h-14 object-cover transition-transform group-hover:scale-105"
              onError={(e) => {
                ;(e.target as HTMLImageElement).style.display = 'none'
              }}
            />
            <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors" />
          </button>
        ))}
        {photos.length > 6 && (
          <button
            onClick={() => openLightbox(6)}
            className="w-20 h-14 glass-stat rounded-lg flex items-center justify-center text-caption text-foreground-tertiary flex-shrink-0 hover:bg-secondary/80 transition-colors"
          >
            +{photos.length - 6}
          </button>
        )}
      </div>

      {/* Lightbox Dialog */}
      <Dialog open={lightboxOpen} onOpenChange={setLightboxOpen}>
        <DialogContent className="max-w-4xl w-full p-0 bg-black/95 border-white/10 gap-0 overflow-hidden">
          <div className="relative flex items-center justify-center min-h-[60vh]">
            {/* Close button */}
            <button
              onClick={() => setLightboxOpen(false)}
              className="absolute top-4 right-4 z-10 p-2 rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors"
            >
              <X className="w-5 h-5" />
            </button>

            {/* Navigation buttons */}
            {photos.length > 1 && (
              <>
                <button
                  onClick={goToPrevious}
                  className="absolute left-4 z-10 p-2 rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors"
                >
                  <ChevronLeft className="w-6 h-6" />
                </button>
                <button
                  onClick={goToNext}
                  className="absolute right-4 z-10 p-2 rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors"
                >
                  <ChevronRight className="w-6 h-6" />
                </button>
              </>
            )}

            {/* Main image */}
            <img
              src={photos[currentIndex]}
              alt={`Photo ${currentIndex + 1}`}
              className="max-h-[70vh] max-w-full object-contain"
            />
          </div>

          {/* Thumbnail strip */}
          <div className="p-4 bg-black/80 border-t border-white/10">
            <div className="flex gap-2 justify-center overflow-x-auto">
              {photos.map((photo, i) => (
                <button
                  key={i}
                  onClick={() => setCurrentIndex(i)}
                  className={cn(
                    'w-16 h-12 rounded-lg overflow-hidden flex-shrink-0 transition-all',
                    i === currentIndex ? 'ring-2 ring-primary ring-offset-2 ring-offset-black' : 'opacity-50 hover:opacity-100'
                  )}
                >
                  <img
                    src={photo}
                    alt={`Thumbnail ${i + 1}`}
                    className="w-full h-full object-cover"
                  />
                </button>
              ))}
            </div>
            <div className="text-center text-white/60 text-caption mt-2">
              {currentIndex + 1} / {photos.length}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
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
    <div className="space-y-6 playground-bg min-h-screen -m-6 p-6">
      {/* Header */}
      <div className="space-y-2">
        <h1 className="text-heading-lg text-foreground tracking-tight">API Playground</h1>
        <p className="text-body text-foreground-tertiary">Test the Flowstate API with real property data</p>
      </div>

      {/* Input Form */}
      <div className="glass-input rounded-2xl overflow-hidden">
        <div className="px-6 py-5 border-b border-border/30">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-primary/10 flex items-center justify-center">
              <Search className="w-4.5 h-4.5 text-primary" />
            </div>
            <div>
              <h2 className="text-body font-semibold">/v1/analyze</h2>
              <p className="text-caption text-foreground-tertiary">Property details, comparables, and valuation</p>
            </div>
          </div>
        </div>
        <div className="px-6 py-5 space-y-4">
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
        </div>
      </div>

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
              {result.data.comps && <ComparablesSection comps={result.data.comps} subjectSubdivision={result.data.subject?.subdivision} />}

              {/* Raw JSON Toggle */}
              <div className="glass-result rounded-2xl overflow-hidden">
                <div
                  className="px-6 py-4 cursor-pointer flex items-center gap-3 hover:bg-white/5 dark:hover:bg-white/[0.02] transition-colors"
                  onClick={() => setShowRawJson(!showRawJson)}
                >
                  <div className="w-8 h-8 rounded-lg bg-secondary/60 flex items-center justify-center">
                    <Code className="w-4 h-4 text-foreground-secondary" />
                  </div>
                  <span className="text-body font-medium flex-1">Raw JSON Response</span>
                  {showRawJson ? <ChevronDown className="w-4 h-4 text-foreground-tertiary" /> : <ChevronRight className="w-4 h-4 text-foreground-tertiary" />}
                </div>
                {showRawJson && (
                  <div className="px-4 pb-4">
                    <pre className="bg-zinc-950 text-zinc-100 rounded-xl p-4 overflow-auto max-h-[600px] text-xs font-mono">
                      {JSON.stringify(result.data, null, 2)}
                    </pre>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="glass-result rounded-2xl overflow-hidden border-red-500/20">
              <div className="px-6 py-5">
                <div className="text-red-500 font-medium">Error</div>
                <div className="text-muted-foreground mt-1">{result.error}</div>
              </div>
            </div>
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
    <div className="glass-result rounded-2xl overflow-hidden">
      <div className="px-6 py-5 border-b border-border/20">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1.5">
              <div className="w-7 h-7 rounded-lg bg-primary/10 flex items-center justify-center">
                <MapPin className="w-3.5 h-3.5 text-primary" />
              </div>
              <span className="text-caption text-foreground-tertiary font-medium">Subject Property</span>
            </div>
            <h3 className="text-heading-sm font-semibold leading-tight">{subject.address || 'Unknown Address'}</h3>
            <div className="flex items-center gap-2 mt-2 flex-wrap">
              {subject.subdivision && (
                <Badge variant="outline" className="text-caption-sm font-normal bg-background/50">
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
      </div>
      <div className="px-6 py-5">
        {/* Property Stats - Compact Grid */}
        <div className="grid grid-cols-3 md:grid-cols-4 lg:grid-cols-7 gap-px bg-border/30 rounded-xl overflow-hidden">
          <StatCell label="Beds" value={subject.bedrooms ?? '-'} />
          <StatCell label="Baths" value={subject.bathrooms ?? '-'} />
          <StatCell label="Sq Ft" value={subject.squareFeet?.toLocaleString() || '-'} />
          <StatCell label="Year" value={subject.yearBuilt || '-'} />
          <StatCell label="Lot" value={subject.lotSizeAcres ? `${subject.lotSizeAcres} ac` : '-'} />
          <StatCell label="Foundation" value={subject.foundationType || '-'} />
          <StatCell
            label="$/Sq Ft"
            value={subject.lastSale?.pricePerSqft ? `$${subject.lastSale.pricePerSqft.toFixed(0)}` : '-'}
          />
        </div>

        {/* Last Sale Info */}
        {subject.lastSale?.price && (
          <div className="mt-4 p-3.5 rounded-xl glass-stat flex items-center justify-between">
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
            <PhotoGallery photos={subject.photos} />
          </div>
        )}

        {/* Classification Reasoning */}
        {subject.classification?.reasoning && (
          <div className="mt-4 p-3.5 rounded-xl glass-accent">
            <div className="text-caption font-medium text-primary mb-1">AI Classification</div>
            <div className="text-caption text-foreground-secondary leading-relaxed">{subject.classification.reasoning}</div>
          </div>
        )}
      </div>
    </div>
  )
}

// Compact stat cell component
function StatCell({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="glass-stat p-3 text-center">
      <div className="text-caption-sm text-foreground-tertiary mb-0.5">{label}</div>
      <div className="text-body-sm font-medium">{value}</div>
    </div>
  )
}

// ─── Risk Flags Card ──────────────────────────────────────────────────────────

function RiskFlagsCard({ riskFlags }: { riskFlags: string[] }) {
  return (
    <div className="glass-result rounded-2xl overflow-hidden border-amber-500/20">
      <div className="px-6 py-4 flex items-center gap-3">
        <div className="w-9 h-9 rounded-xl bg-amber-500/10 flex items-center justify-center">
          <AlertTriangle className="w-4.5 h-4.5 text-amber-600" />
        </div>
        <h3 className="text-body font-semibold text-amber-600">Risk Flags</h3>
      </div>
      <div className="px-6 pb-5">
        <div className="flex flex-wrap gap-2">
          {riskFlags.map((flag, i) => (
            <Badge key={i} variant="outline" className="bg-amber-500/10 text-amber-700 border-amber-500/30">
              {flag}
            </Badge>
          ))}
        </div>
      </div>
    </div>
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
    <div className="glass-result rounded-2xl overflow-hidden">
      <div className="px-6 py-5 border-b border-border/20">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-primary/10 flex items-center justify-center">
            <DollarSign className="w-4.5 h-4.5 text-primary" />
          </div>
          <h3 className="text-body font-semibold">Underwriter Valuation</h3>
        </div>
      </div>
      <div className="px-6 py-5">
        {/* Primary Stats Grid */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-px bg-border/30 rounded-xl overflow-hidden">
          <div className="glass-stat p-4">
            <div className="text-caption text-foreground-tertiary mb-1">ARV</div>
            <div className="text-heading-sm font-bold text-primary">${valuation.arv?.toLocaleString() || '-'}</div>
            {valuation.arvPerSqft && (
              <div className="text-caption-sm text-foreground-tertiary mt-1">${valuation.arvPerSqft.toFixed(0)}/sqft</div>
            )}
          </div>
          <div className="glass-stat p-4">
            <div className="text-caption text-foreground-tertiary mb-1">Max Buy Price</div>
            <div className="text-heading-sm font-bold">${valuation.buyPrice?.toLocaleString() || '-'}</div>
            {valuation.buyPricePercent && (
              <div className="text-caption-sm text-foreground-tertiary mt-1">{valuation.buyPricePercent}% of ARV</div>
            )}
          </div>
          <div className="glass-stat p-4">
            <div className="text-caption text-foreground-tertiary mb-1">Rehab Cost</div>
            <div className="text-heading-sm font-semibold">${valuation.rehabCost?.toLocaleString() || '-'}</div>
            {valuation.rehabLevel && (
              <Badge variant="outline" className="mt-1.5 bg-background/50">
                {valuation.rehabLevel}
              </Badge>
            )}
          </div>
          <div className="glass-stat p-4">
            <div className="text-caption text-foreground-tertiary mb-1">Projected Profit</div>
            <div className={cn('text-heading-sm font-semibold', (valuation.projectedProfit ?? 0) > 0 ? 'text-emerald-600' : 'text-red-600')}>
              ${valuation.projectedProfit?.toLocaleString() || '-'}
            </div>
            {valuation.projectedROI && (
              <div className="text-caption-sm text-foreground-tertiary mt-1">{valuation.projectedROI.toFixed(1)}% ROI</div>
            )}
          </div>
        </div>

        {/* Secondary Stats */}
        {(valuation.totalCosts || valuation.totalInvestment || valuation.wholesalePrice) && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-px bg-border/30 rounded-xl overflow-hidden mt-4">
            {valuation.totalCosts && (
              <div className="glass-stat p-3">
                <div className="text-caption-sm text-foreground-tertiary mb-0.5">Total Costs</div>
                <div className="text-body font-medium">${valuation.totalCosts.toLocaleString()}</div>
              </div>
            )}
            {valuation.totalInvestment && (
              <div className="glass-stat p-3">
                <div className="text-caption-sm text-foreground-tertiary mb-0.5">Total Investment</div>
                <div className="text-body font-medium">${valuation.totalInvestment.toLocaleString()}</div>
              </div>
            )}
            {valuation.wholesalePrice && (
              <div className="glass-stat p-3">
                <div className="text-caption-sm text-foreground-tertiary mb-0.5">Wholesale Price</div>
                <div className="text-body font-medium">${valuation.wholesalePrice.toLocaleString()}</div>
              </div>
            )}
          </div>
        )}

        {/* Rehab Level Options */}
        {valuation.rehabLevelEstimates && valuation.rehabLevelEstimates.length > 0 && (
          <div className="mt-6 pt-6 border-t border-border/30">
            <div className="text-caption font-medium text-foreground-secondary mb-3">Rehab Level Options</div>
            <div className="overflow-x-auto">
              <table className="w-full text-caption">
                <thead>
                  <tr className="border-b border-border/30">
                    <th className="text-left py-2 pr-4 font-medium text-foreground-tertiary">Level</th>
                    <th className="text-right py-2 px-3 font-medium text-foreground-tertiary">$/Sqft</th>
                    <th className="text-right py-2 px-3 font-medium text-foreground-tertiary">Rehab Cost</th>
                    <th className="text-right py-2 px-3 font-medium text-foreground-tertiary">Buy Price</th>
                    <th className="text-right py-2 px-3 font-medium text-foreground-tertiary">Wholesale</th>
                    <th className="text-right py-2 px-3 font-medium text-foreground-tertiary">Profit</th>
                    <th className="text-right py-2 pl-3 font-medium text-foreground-tertiary">ROI</th>
                  </tr>
                </thead>
                <tbody>
                  {valuation.rehabLevelEstimates.map((level) => (
                    <tr
                      key={level.index}
                      className={cn(
                        'border-b border-border/20 transition-colors',
                        level.isSelected && 'bg-primary/5'
                      )}
                    >
                      <td className="py-2.5 pr-4">
                        <div className="flex items-center gap-2">
                          {level.isSelected && (
                            <div className="w-1.5 h-1.5 rounded-full bg-primary" />
                          )}
                          <span className={cn('font-medium', level.isSelected && 'text-primary')}>
                            {level.name}
                          </span>
                        </div>
                      </td>
                      <td className="text-right py-2.5 px-3 text-foreground-secondary">
                        ${level.perSqft}
                      </td>
                      <td className="text-right py-2.5 px-3 font-medium">
                        ${level.estimatedCost.toLocaleString()}
                      </td>
                      <td className="text-right py-2.5 px-3 font-medium">
                        ${level.buyPrice.toLocaleString()}
                      </td>
                      <td className="text-right py-2.5 px-3 text-foreground-secondary">
                        ${level.wholesalePrice.toLocaleString()}
                      </td>
                      <td className={cn(
                        'text-right py-2.5 px-3 font-medium',
                        level.projectedProfit > 0 ? 'text-emerald-600' : 'text-red-600'
                      )}>
                        ${level.projectedProfit.toLocaleString()}
                      </td>
                      <td className={cn(
                        'text-right py-2.5 pl-3 font-medium',
                        level.projectedROI > 15 ? 'text-emerald-600' : level.projectedROI > 0 ? 'text-foreground' : 'text-red-600'
                      )}>
                        {level.projectedROI.toFixed(1)}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Recommendation */}
        {valuation.recommendation && (
          <div className="mt-6 pt-6 border-t border-border/30">
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
      </div>
    </div>
  )
}

// ─── Comparables Section ──────────────────────────────────────────────────────

function ComparablesSection({ comps, subjectSubdivision }: { comps: CompsData; subjectSubdivision?: string | null }) {
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
    <div className="glass-result rounded-2xl overflow-hidden">
      <div className="px-6 py-5 border-b border-border/20">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-primary/10 flex items-center justify-center">
              <Home className="w-4.5 h-4.5 text-primary" />
            </div>
            <h3 className="text-body font-semibold">Comparables ({comps.count || compItems.length})</h3>
          </div>
          <div className="flex items-center gap-3 text-caption text-foreground-tertiary">
            {comps.medianPrice && (
              <span>Median: <span className="font-medium text-foreground">${comps.medianPrice.toLocaleString()}</span></span>
            )}
            {comps.avgPricePerSqft && (
              <Badge variant="outline" className="text-caption-sm bg-background/50">Avg: ${comps.avgPricePerSqft.toFixed(0)}/sqft</Badge>
            )}
          </div>
        </div>
      </div>
      <div className="p-4 space-y-3">
        {compItems.map((comp, index) => {
          const isExpanded = expandedComps.has(index)

          return (
            <CompCard key={index} comp={comp} index={index} isExpanded={isExpanded} onToggle={() => toggleComp(index)} subjectSubdivision={subjectSubdivision} />
          )
        })}
      </div>
    </div>
  )
}

// ─── Individual Comp Card ─────────────────────────────────────────────────────

// Helper to normalize subdivision names for comparison
function normalizeSubdivision(sub: string | null | undefined): string {
  if (!sub) return ''
  return sub.toLowerCase().trim().replace(/\s+/g, ' ')
}

function CompCard({
  comp,
  index,
  isExpanded,
  onToggle,
  subjectSubdivision,
}: {
  comp: CompItem
  index: number
  isExpanded: boolean
  onToggle: () => void
  subjectSubdivision?: string | null
}) {
  // Check subdivision match by comparing directly
  const hasSubdivisionMatch = !!(
    subjectSubdivision &&
    comp.subdivision &&
    normalizeSubdivision(subjectSubdivision) === normalizeSubdivision(comp.subdivision)
  )
  return (
    <div
      className={cn(
        'glass-comp rounded-2xl transition-all duration-200',
        comp.isBestComp && 'border-amber-500/40 ring-1 ring-amber-500/20'
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
                {hasSubdivisionMatch && (
                  <Badge className="bg-emerald-500/15 text-emerald-600 border-emerald-500/30 text-caption-sm">
                    <Check className="w-3 h-3 mr-1" />
                    Subdivision
                  </Badge>
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
              {/* Condition badge */}
              {comp.condition && (
                <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
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
          {comp.foundationType && <span>Foundation: {comp.foundationType}</span>}
          {comp.saleDate && <span>Sold {new Date(comp.saleDate).toLocaleDateString()}</span>}
          {comp.qualityScore !== undefined && comp.qualityScore !== null && (
            <span className="text-primary font-medium">Quality: {comp.qualityScore}/100</span>
          )}
        </div>
      </div>

      {/* Expanded Details */}
      {isExpanded && (
        <div className="border-t border-border/20 px-5 py-4 glass-stat space-y-4">
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
              <PhotoGallery photos={comp.photos} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}
