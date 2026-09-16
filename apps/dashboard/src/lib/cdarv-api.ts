/**
 * CDARV API helpers (server-side).
 *
 * All calls go through the apps/api session-auth proxy at /cdarv/proxy/*
 * which forwards to the CDARV service with the internal token. The
 * service's bearer credential never reaches the browser.
 */

import { cookies } from 'next/headers'

const API_URL = process.env.NEXT_PUBLIC_API_URL!

export interface CdarvSnapshot {
  id: string
  report_id: string
  job_id: string | null
  user_id: string
  version: number
  address: string | null
  status: string
  completeness: 'complete' | 'incomplete'
  completeness_notes: string | null
  provenance: Record<string, unknown>
  submitted_by: string
  created_at: string | null
}

export interface CdarvComp {
  comp_id: string
  transaction_key: string
  raw: Record<string, unknown>
  rule_context: {
    is_enabled: boolean
    evaluator_selected: boolean
    evaluator_group: string | null
    filter_passed_count: number
    filter_failed_count: number
    total_adjustment: number | null
    rank_in_report: number
    is_best_match: boolean
  }
}

export interface CdarvReview {
  id: string
  snapshot_id: string
  version: number
  status: string
  reviewer_id: string
  summary_note: string | null
  labels: Array<{
    comp_id: string
    transaction_key: string | null
    label: string
    reasons: string[]
    note: string | null
  }>
  preferences: Array<{
    preferred_comp_id: string
    over_comp_id: string
    reasons: string[]
    note: string | null
  }>
  external_comps: Array<{
    id: string
    source: string
    transaction: Record<string, unknown>
    availability_date: string
    note: string | null
  }>
  approval: {
    comp_ranking: boolean
    valuation_benchmark: boolean
    gold_standard: boolean
    gold_standard_by: string | null
    gold_standard_evidence: string | null
    approved_by: string | null
  } | null
}

export interface CdarvDataset {
  id: string
  name: string
  version: number
  manifest: { scope: string; members: unknown[] }
  feature_spec_version: string
  code_version: string | null
  split_summary: Record<string, number>
  created_by: string
  created_at: string | null
}

export interface CdarvModel {
  id: string
  name: string
  version: number
  dataset_id: string
  target: string
  metrics: {
    label_counts?: { examples?: number; reviewed_reports?: number }
    splits?: Record<string, { examples?: number; ranking?: { mean_precision_at_k?: number | null; exact_match_rate?: number | null } }>
  }
  status: 'candidate' | 'shadow' | 'retired'
  created_at: string | null
}

export interface CdarvJob {
  id: string
  type: string
  status: string
  error_code: string | null
  error_detail: string | null
  attempts: number
  created_at: string | null
}

export interface CdarvShadowState {
  active_model_id: string | null
  active_model: { id: string; name: string; version: number } | null
  activated_by: string | null
  activated_at: string | null
}

export interface CdarvPrediction {
  id: string
  snapshot_id: string
  model_id: string
  status: 'scored' | 'insufficient_evidence' | 'error'
  selected_comp_ids: string[]
  shadow_arv: number | null
  created_at: string | null
}

export interface CdarvSummary {
  snapshots_by_status: Record<string, number>
  labels_by_kind: Record<string, number>
  predictions_by_status: Record<string, number>
  independently_reviewed_reports: number
  gold_standard_reports: number
  datasets: number
  models: number
  coverage_by_market: Record<string, number>
  shadow_agreement: {
    scored_predictions: number
    predictions_with_review: number
    evaluator_jaccard_mean: number | null
    reviewer_overlap_mean: number | null
    outcome_accuracy: string
  }
}

export class CdarvUnavailable extends Error {}

export async function cdarvFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const cookieStore = await cookies()
  const cookieHeader = cookieStore
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join('; ')

  const response = await fetch(`${API_URL}/cdarv/proxy${path}`, {
    ...init,
    cache: 'no-store',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookieHeader,
      ...init.headers,
    },
  })

  if (response.status === 503) {
    throw new CdarvUnavailable('CDARV service is not configured or unreachable')
  }
  if (!response.ok) {
    const err = (await response.json().catch(() => null)) as { message?: string; code?: string } | null
    throw new Error(err?.message ?? `CDARV request failed (${response.status})`)
  }
  return (await response.json()) as T
}

export async function getQueue(status?: string): Promise<CdarvSnapshot[]> {
  const q = status ? `?status=${encodeURIComponent(status)}` : ''
  const data = await cdarvFetch<{ snapshots: CdarvSnapshot[] }>(`/queue${q}`)
  return data.snapshots
}

export async function getSnapshotDetail(snapshotId: string): Promise<{
  snapshot: CdarvSnapshot
  review_packet: {
    subject: Record<string, unknown>
    valuation: Record<string, unknown>
    /** appliedSettings from the report — the rules that ran this evaluation */
    applied_settings: {
      filters?: Array<{ type: string; enabled: boolean; value: number }>
      adjustments?: Array<{ type: string; enabled: boolean; amount: number; percent?: number }>
      rehabLevelIndex?: number
      arvThresholdPercent?: number
      asIsThresholdPercent?: number
    } | null
    /** Operator-edit trail — engine-vs-user comp selection variance */
    selection_history: Array<{
      action: string
      description?: string
      created_at?: string
      arv_before?: string[]
      arv_after?: string[]
    }>
    comps: CdarvComp[]
  }
  reviews: Array<{ id: string; version: number; status: string; reviewer_id: string; created_at: string | null }>
}> {
  return cdarvFetch(`/snapshots/${snapshotId}`)
}

export async function getReview(reviewId: string): Promise<CdarvReview> {
  const data = await cdarvFetch<{ review: CdarvReview }>(`/reviews/${reviewId}`)
  return data.review
}

export async function getDatasets(): Promise<CdarvDataset[]> {
  const data = await cdarvFetch<{ datasets: CdarvDataset[] }>('/datasets')
  return data.datasets
}

export async function getModels(): Promise<CdarvModel[]> {
  const data = await cdarvFetch<{ models: CdarvModel[] }>('/models')
  return data.models
}

export async function getJobs(status?: string): Promise<CdarvJob[]> {
  const q = status ? `?status=${encodeURIComponent(status)}` : ''
  const data = await cdarvFetch<{ jobs: CdarvJob[] }>(`/jobs${q}`)
  return data.jobs
}

export async function getShadowState(): Promise<CdarvShadowState> {
  const data = await cdarvFetch<{ shadow: CdarvShadowState }>('/shadow/state')
  return data.shadow
}

export async function getPredictions(snapshotId?: string): Promise<CdarvPrediction[]> {
  const q = snapshotId ? `?snapshot_id=${encodeURIComponent(snapshotId)}` : ''
  const data = await cdarvFetch<{ predictions: CdarvPrediction[] }>(`/predictions${q}`)
  return data.predictions
}

export async function getMonitoringSummary(): Promise<CdarvSummary> {
  const data = await cdarvFetch<{ summary: CdarvSummary }>('/monitoring/summary')
  return data.summary
}
