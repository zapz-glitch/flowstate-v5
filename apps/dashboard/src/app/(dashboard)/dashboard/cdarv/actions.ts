'use server'

/**
 * CDARV server actions — all mutations go through the apps/api session
 * proxy (/cdarv/*) using the caller's cookies; reviewer identity comes
 * from the dashboard session, never from client input.
 */

import { cookies } from 'next/headers'
import { revalidatePath } from 'next/cache'
import { getUser } from '@/lib/api'
import { cdarvFetch } from '@/lib/cdarv-api'

const API_URL = process.env.NEXT_PUBLIC_API_URL!

async function requireUserId(): Promise<string> {
  const user = await getUser()
  if (!user) throw new Error('Not authenticated')
  return user.id
}

export interface ActionResult {
  ok: boolean
  message?: string
  id?: string
}

function result(e: unknown): ActionResult {
  return { ok: false, message: e instanceof Error ? e.message : 'Request failed' }
}

/** Send saved reports to the CDARV review queue (idempotent). */
export async function submitReportsToCdarv(jobIds: string[]): Promise<ActionResult> {
  try {
    await requireUserId()
    const cookieStore = await cookies()
    const cookieHeader = cookieStore.getAll().map((c) => `${c.name}=${c.value}`).join('; ')
    const resp = await fetch(`${API_URL}/cdarv/submissions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
      body: JSON.stringify({ jobIds }),
    })
    const data = (await resp.json().catch(() => null)) as {
      results?: Array<{ outcome: string; error?: string }>
      error?: string
    } | null
    if (!resp.ok) return { ok: false, message: data?.error ?? `Failed (${resp.status})` }
    const created = data?.results?.filter((r) => r.outcome !== 'error').length ?? 0
    const failed = (data?.results?.length ?? 0) - created
    revalidatePath('/dashboard/cdarv')
    return {
      ok: true,
      message: failed
        ? `${created} queued, ${failed} failed`
        : `${created} report(s) sent to CDARV review queue`,
    }
  } catch (e) {
    return result(e)
  }
}

export async function openReview(snapshotId: string): Promise<ActionResult> {
  try {
    const reviewer = await requireUserId()
    const data = await cdarvFetch<{ review_id: string }>('/reviews', {
      method: 'POST',
      body: JSON.stringify({ snapshot_id: snapshotId, reviewer_id: reviewer }),
    })
    revalidatePath(`/dashboard/cdarv/snapshots/${snapshotId}`)
    return { ok: true, id: data.review_id }
  } catch (e) {
    return result(e)
  }
}

export async function saveCompLabels(
  reviewId: string,
  labels: Array<{ comp_id: string; label: string; reasons?: string[]; note?: string }>
): Promise<ActionResult> {
  try {
    await requireUserId()
    await cdarvFetch(`/reviews/${reviewId}/labels`, {
      method: 'POST',
      body: JSON.stringify({ labels }),
    })
    return { ok: true, message: `${labels.length} label(s) saved` }
  } catch (e) {
    return result(e)
  }
}

export async function decideReview(
  reviewId: string,
  action: 'approve' | 'needs_more_evidence' | 'exclude',
  opts: {
    comp_ranking?: boolean
    valuation_benchmark?: boolean
    gold_standard?: boolean
    gold_standard_evidence?: string
    note?: string
  } = {}
): Promise<ActionResult> {
  try {
    const reviewer = await requireUserId()
    await cdarvFetch(`/reviews/${reviewId}/decide`, {
      method: 'POST',
      body: JSON.stringify({ action, reviewer_id: reviewer, ...opts }),
    })
    revalidatePath('/dashboard/cdarv')
    return { ok: true, message: `Review ${action}d` }
  } catch (e) {
    return result(e)
  }
}

export async function buildDataset(name: string): Promise<ActionResult> {
  try {
    const createdBy = await requireUserId()
    const data = await cdarvFetch<{ dataset: { id: string; version: number } }>('/datasets', {
      method: 'POST',
      body: JSON.stringify({ name, created_by: createdBy, scope: 'comp_ranking' }),
    })
    revalidatePath('/dashboard/cdarv/models')
    return { ok: true, id: data.dataset.id, message: `Dataset ${name} v${data.dataset.version} built` }
  } catch (e) {
    return result(e)
  }
}

export async function trainModel(datasetId: string, name = 'baseline'): Promise<ActionResult> {
  try {
    await requireUserId()
    const data = await cdarvFetch<{ job: { id: string } }>('/models/train', {
      method: 'POST',
      body: JSON.stringify({ dataset_id: datasetId, name }),
    })
    revalidatePath('/dashboard/cdarv/models')
    return { ok: true, id: data.job.id, message: 'Training job queued' }
  } catch (e) {
    return result(e)
  }
}

export async function activateShadow(modelId: string): Promise<ActionResult> {
  try {
    const user = await requireUserId()
    await cdarvFetch('/shadow/activate', {
      method: 'POST',
      body: JSON.stringify({ model_id: modelId, activated_by: user }),
    })
    revalidatePath('/dashboard/cdarv/models')
    return { ok: true, message: 'Shadow model activated' }
  } catch (e) {
    return result(e)
  }
}

export async function deactivateShadow(): Promise<ActionResult> {
  try {
    await requireUserId()
    await cdarvFetch('/shadow/deactivate', { method: 'POST' })
    revalidatePath('/dashboard/cdarv/models')
    return { ok: true, message: 'Shadow predictions disabled' }
  } catch (e) {
    return result(e)
  }
}

export async function scoreSnapshot(snapshotId: string): Promise<ActionResult> {
  try {
    await requireUserId()
    await cdarvFetch('/shadow/score', {
      method: 'POST',
      body: JSON.stringify({ snapshot_id: snapshotId }),
    })
    revalidatePath('/dashboard/cdarv/performance')
    return { ok: true, message: 'Shadow scoring job queued' }
  } catch (e) {
    return result(e)
  }
}
