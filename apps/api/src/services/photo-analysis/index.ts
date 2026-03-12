/**
 * Photo Analysis Service
 *
 * Uses LLM vision to analyze uploaded property photos and detect
 * condition issues that map to major repair items.
 */

import { createLLMProviderFromEnv, arrayBufferToBase64, detectMimeType } from '../llm'
import type { ImageInput } from '../llm'
import { MAJOR_ITEMS } from '@flowstate-api/shared/valuation'

// ─── Types ──────────────────────────────────────────────────────────────────

export interface PhotoFinding {
  id: string
  majorItemId: string | null
  title: string
  description: string
  severity: 'low' | 'medium' | 'high' | 'critical'
  confidence: number
  estimatedCost?: number
}

export interface PhotoAnalysisResult {
  findings: PhotoFinding[]
  model: string
  photoCount: number
}

interface AnalysisEnv {
  OPENROUTER_API_KEY?: string
  OPENROUTER_MODEL?: string
}

// ─── Prompt ─────────────────────────────────────────────────────────────────

const MAJOR_ITEMS_LIST = MAJOR_ITEMS.map(
  (item) => `- ${item.id}: ${item.name} (default cost: $${item.defaultCost.toLocaleString()})`
).join('\n')

const SYSTEM_PROMPT = `You are a property inspector AI analyzing photos for a real estate underwriting report. Your job is to identify visible property condition issues, damage, wear, or components that may need repair or replacement.

Focus on:
- Structural issues (foundation cracks, settling, water damage)
- Roof condition (missing shingles, sagging, age indicators)
- HVAC systems (old units, rust, damage)
- Plumbing indicators (water stains, pipe condition)
- Electrical (old panels, exposed wiring)
- Mold or moisture indicators
- Pool condition if visible
- Termite damage indicators
- General property condition and renovation needs

Known major repair items you can map findings to:
${MAJOR_ITEMS_LIST}

Respond with a JSON object containing a "findings" array. Each finding should have:
- "majorItemId": the ID from the list above if applicable, or null for general observations
- "title": short title of the issue (2-5 words)
- "description": detailed description of what you observe and why it's a concern
- "severity": "low", "medium", "high", or "critical"
- "confidence": 0.0 to 1.0 indicating how confident you are about this finding

Only report issues you can actually see evidence of in the photos. Do not speculate about things not visible. If the photos show a well-maintained property with no visible issues, return an empty findings array.`

// ─── Service ────────────────────────────────────────────────────────────────

export async function analyzePropertyPhotos(
  env: AnalysisEnv,
  photos: Array<{ data: ArrayBuffer; mimeType: string }>,
): Promise<PhotoAnalysisResult> {
  const provider = createLLMProviderFromEnv(env)
  if (!provider) {
    throw new Error('LLM provider not configured (OPENROUTER_API_KEY missing)')
  }

  const images: ImageInput[] = photos.map((photo) => ({
    base64: arrayBufferToBase64(photo.data),
    mimeType: photo.mimeType,
  }))

  const result = await provider.execute({
    systemPrompt: SYSTEM_PROMPT,
    prompt: `Analyze these ${photos.length} property photo(s) and identify any visible condition issues, damage, or components that may need repair or replacement. Return your findings as JSON.`,
    images,
    responseFormat: 'json',
    maxTokens: 4096,
    temperature: 0.1,
  })

  if (!result.success || !result.data) {
    throw new Error(result.error?.message || 'LLM analysis failed')
  }

  const content = result.data.content

  let findings: PhotoFinding[] = []
  try {
    const parsed = JSON.parse(content)
    const rawFindings = parsed.findings || parsed
    if (Array.isArray(rawFindings)) {
      findings = rawFindings.map((f: Record<string, unknown>, i: number) => ({
        id: `finding-${i}`,
        majorItemId: typeof f.majorItemId === 'string' ? f.majorItemId : null,
        title: String(f.title || 'Unknown Issue'),
        description: String(f.description || ''),
        severity: validateSeverity(f.severity),
        confidence: typeof f.confidence === 'number' ? Math.min(1, Math.max(0, f.confidence)) : 0.5,
        ...(typeof f.estimatedCost === 'number' ? { estimatedCost: f.estimatedCost } : {}),
      }))
    }
  } catch {
    // If JSON parse fails, return empty findings
    console.error('Failed to parse LLM response:', content.substring(0, 200))
  }

  return {
    findings,
    model: env.OPENROUTER_MODEL || 'google/gemini-2.0-flash-001',
    photoCount: photos.length,
  }
}

function validateSeverity(val: unknown): PhotoFinding['severity'] {
  const s = String(val).toLowerCase()
  if (s === 'low' || s === 'medium' || s === 'high' || s === 'critical') return s
  return 'medium'
}
