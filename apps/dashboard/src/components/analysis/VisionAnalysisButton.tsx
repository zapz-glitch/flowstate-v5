'use client'

import { useState } from 'react'
import { Eye, Loader2, CheckCircle2, AlertCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { runVisionAnalysis, type VisionAnalysisResult } from '@/lib/client-api'

interface VisionAnalysisButtonProps {
  photoUrls: string[]
  propertyContext?: {
    address?: string
    squareFeet?: number
    yearBuilt?: number
  }
  /** If vision analysis was already done (e.g. from stored report), pass it here */
  existingAnalysis?: VisionAnalysisResult | null
}

const CONDITION_COLORS: Record<string, string> = {
  excellent: 'text-green-400',
  good: 'text-emerald-400',
  fair: 'text-yellow-400',
  poor: 'text-red-400',
  unknown: 'text-muted-foreground',
}

const REHAB_LABELS: Record<string, string> = {
  none: 'No rehab needed',
  cosmetic: 'Cosmetic updates',
  moderate: 'Moderate rehab',
  significant: 'Significant rehab',
  full_renovation: 'Full renovation',
}

function VisionResultDisplay({ result }: { result: VisionAnalysisResult }) {
  const conditionColor = CONDITION_COLORS[result.overallCondition] ?? 'text-muted-foreground'

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-caption font-medium text-foreground-secondary">Condition:</span>
          <span className={`text-caption font-semibold capitalize ${conditionColor}`}>
            {result.overallCondition}
          </span>
          <span className="text-caption text-muted-foreground">({result.confidence}%)</span>
        </div>
        <div className="text-caption text-foreground-secondary">
          {REHAB_LABELS[result.estimatedRehabNeeds] ?? result.estimatedRehabNeeds}
        </div>
      </div>

      <p className="text-caption text-foreground-secondary leading-relaxed">
        {result.summary}
      </p>

      {result.exterior && result.exterior.notes.length > 0 && (
        <div>
          <span className="text-caption font-medium text-foreground-secondary">
            Exterior ({result.exterior.condition}):
          </span>
          <ul className="mt-1 space-y-0.5">
            {result.exterior.notes.map((note, i) => (
              <li key={i} className="text-caption text-muted-foreground pl-3 relative before:content-[''] before:absolute before:left-0 before:top-[0.55em] before:w-1.5 before:h-1.5 before:rounded-full before:bg-muted-foreground/30">
                {note}
              </li>
            ))}
          </ul>
        </div>
      )}

      {result.interior && result.interior.notes.length > 0 && (
        <div>
          <span className="text-caption font-medium text-foreground-secondary">
            Interior ({result.interior.condition}):
          </span>
          <ul className="mt-1 space-y-0.5">
            {result.interior.notes.map((note, i) => (
              <li key={i} className="text-caption text-muted-foreground pl-3 relative before:content-[''] before:absolute before:left-0 before:top-[0.55em] before:w-1.5 before:h-1.5 before:rounded-full before:bg-muted-foreground/30">
                {note}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

export function VisionAnalysisButton({ photoUrls, propertyContext, existingAnalysis }: VisionAnalysisButtonProps) {
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<VisionAnalysisResult | null>(existingAnalysis ?? null)
  const [error, setError] = useState<string | null>(null)

  if (!photoUrls || photoUrls.length === 0) return null

  async function handleAnalyze() {
    setLoading(true)
    setError(null)
    try {
      const response = await runVisionAnalysis({ photoUrls, propertyContext })
      setResult(response.data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Vision analysis failed')
    } finally {
      setLoading(false)
    }
  }

  if (result) {
    return (
      <div className="p-3.5 rounded-xl bg-primary/5">
        <div className="flex items-center gap-2 mb-2">
          <CheckCircle2 className="w-3.5 h-3.5 text-primary" />
          <span className="text-caption font-medium text-primary">AI Vision Analysis</span>
        </div>
        <VisionResultDisplay result={result} />
        <Button
          variant="ghost"
          size="sm"
          className="mt-2 text-xs"
          onClick={handleAnalyze}
          disabled={loading}
        >
          {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Eye className="w-3 h-3" />}
          Re-analyze
        </Button>
      </div>
    )
  }

  return (
    <div className="flex items-center gap-3">
      <Button
        variant="outline"
        size="sm"
        onClick={handleAnalyze}
        disabled={loading}
      >
        {loading ? (
          <>
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            Analyzing photos...
          </>
        ) : (
          <>
            <Eye className="w-3.5 h-3.5" />
            AI Vision Analysis
          </>
        )}
      </Button>
      {error && (
        <span className="text-caption text-destructive flex items-center gap-1">
          <AlertCircle className="w-3 h-3" />
          {error}
        </span>
      )}
    </div>
  )
}
