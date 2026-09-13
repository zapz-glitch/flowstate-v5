'use server'

import { getSession } from '@/lib/api'

export interface BatchResult {
  address: string
  index: number
  status: 'pending' | 'processing' | 'completed' | 'failed'
  stepLabel?: string
  jobId?: string
  error?: string
  arv?: number
  buyPrice?: number
  rehabCost?: number
  recommendation?: string
  confidence?: string
  /** Review stamp: 'validated' | 'improve' — joined from saved_reports */
  feedbackStatus?: string | null
}

export interface BatchJob {
  id: string
  status: string
  totalAddresses: number
  completedCount: number
  failedCount: number
  results: BatchResult[]
  createdAt: string
  updatedAt?: string
  isStuck?: boolean
}

export interface SubmitBatchResult {
  success: boolean
  batchId?: string
  totalAddresses?: number
  /** True when another list is still processing — this one runs next */
  queued?: boolean
  streamUrl?: string
  token?: string
  error?: string
}

export async function submitBatchAnalysis(addresses: string[]): Promise<SubmitBatchResult> {
  try {
    const apiUrl = process.env.NEXT_PUBLIC_API_URL!
    const session = await getSession()
    if (!session?.user) {
      return { success: false, error: 'Not authenticated' }
    }

    // Use cookie-based auth (forwarded from the session)
    const { cookies } = await import('next/headers')
    const cookieStore = await cookies()
    const cookieHeader = cookieStore.getAll().map((c) => `${c.name}=${c.value}`).join('; ')

    const response = await fetch(`${apiUrl}/batch/analyze`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': cookieHeader,
      },
      body: JSON.stringify({ addresses }),
    })

    const result = await response.json() as {
      success?: boolean
      batchId?: string
      totalAddresses?: number
      queued?: boolean
      streamUrl?: string
      token?: string
      error?: string
    }

    if (!response.ok || !result.success) {
      return { success: false, error: result.error || 'Failed to start batch' }
    }

    return {
      success: true,
      batchId: result.batchId,
      totalAddresses: result.totalAddresses,
      queued: result.queued,
      streamUrl: result.streamUrl,
      token: result.token,
    }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Unknown error' }
  }
}

export async function getBatchStatus(batchId: string): Promise<BatchJob | null> {
  try {
    const apiUrl = process.env.NEXT_PUBLIC_API_URL!
    const { cookies } = await import('next/headers')
    const cookieStore = await cookies()
    const cookieHeader = cookieStore.getAll().map((c) => `${c.name}=${c.value}`).join('; ')

    const response = await fetch(`${apiUrl}/batch/${batchId}`, {
      headers: { 'Cookie': cookieHeader },
    })

    if (!response.ok) return null
    return await response.json() as BatchJob
  } catch {
    return null
  }
}

export async function getBatchStreamToken(batchId: string): Promise<{ streamUrl: string; token: string } | null> {
  try {
    const apiUrl = process.env.NEXT_PUBLIC_API_URL!
    const { cookies } = await import('next/headers')
    const cookieStore = await cookies()
    const cookieHeader = cookieStore.getAll().map((c) => `${c.name}=${c.value}`).join('; ')

    const response = await fetch(`${apiUrl}/batch/${batchId}/stream-token`, {
      method: 'POST',
      headers: { 'Cookie': cookieHeader },
    })

    if (!response.ok) return null
    return await response.json() as { streamUrl: string; token: string }
  } catch {
    return null
  }
}

export async function recoverStuckBatch(batchId: string): Promise<{ success: boolean; recoveredCount?: number; error?: string }> {
  try {
    const apiUrl = process.env.NEXT_PUBLIC_API_URL!
    const { cookies } = await import('next/headers')
    const cookieStore = await cookies()
    const cookieHeader = cookieStore.getAll().map((c) => `${c.name}=${c.value}`).join('; ')

    const response = await fetch(`${apiUrl}/batch/${batchId}/recover`, {
      method: 'POST',
      headers: { 'Cookie': cookieHeader },
    })

    if (!response.ok) {
      const data = await response.json() as { error?: string }
      return { success: false, error: data.error || 'Recovery failed' }
    }
    return await response.json() as { success: boolean; recoveredCount?: number }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Recovery failed' }
  }
}

export async function retryFailedAddresses(batchId: string): Promise<{ success: boolean; streamUrl?: string; token?: string; error?: string }> {
  try {
    const apiUrl = process.env.NEXT_PUBLIC_API_URL!
    const { cookies } = await import('next/headers')
    const cookieStore = await cookies()
    const cookieHeader = cookieStore.getAll().map((c) => `${c.name}=${c.value}`).join('; ')

    const response = await fetch(`${apiUrl}/batch/${batchId}/retry-failed`, {
      method: 'POST',
      headers: { 'Cookie': cookieHeader },
    })

    if (!response.ok) {
      const data = await response.json() as { error?: string }
      return { success: false, error: data.error || 'Retry failed' }
    }
    return await response.json() as { success: boolean; streamUrl?: string; token?: string }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Retry failed' }
  }
}

/** Stamp a report as validated or flagged-for-improvement (batch review loop) */
export async function submitReportFeedback(
  jobId: string,
  type: 'validate' | 'improve',
  notes: string,
  report: string,
): Promise<{ success: boolean; feedbackStatus?: string; error?: string }> {
  try {
    const apiUrl = process.env.NEXT_PUBLIC_API_URL!
    const { cookies } = await import('next/headers')
    const cookieStore = await cookies()
    const cookieHeader = cookieStore.getAll().map((c) => `${c.name}=${c.value}`).join('; ')

    const response = await fetch(`${apiUrl}/user/reports/${encodeURIComponent(jobId)}/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cookie': cookieHeader },
      body: JSON.stringify({ type, notes, report }),
    })

    if (!response.ok) {
      const data = await response.json().catch(() => ({})) as { error?: string }
      return { success: false, error: data.error || `Feedback failed (${response.status})` }
    }
    return await response.json() as { success: boolean; feedbackStatus?: string }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Feedback failed' }
  }
}

export async function getBatchJobs(): Promise<Array<{ id: string; status: string; totalAddresses: number; completedCount: number; failedCount: number; createdAt: string }>> {
  try {
    const apiUrl = process.env.NEXT_PUBLIC_API_URL!
    const { cookies } = await import('next/headers')
    const cookieStore = await cookies()
    const cookieHeader = cookieStore.getAll().map((c) => `${c.name}=${c.value}`).join('; ')

    const response = await fetch(`${apiUrl}/batch`, {
      headers: { 'Cookie': cookieHeader },
    })

    if (!response.ok) return []
    const data = await response.json() as { jobs: Array<{ id: string; status: string; totalAddresses: number; completedCount: number; failedCount: number; createdAt: string }> }
    return data.jobs ?? []
  } catch {
    return []
  }
}
