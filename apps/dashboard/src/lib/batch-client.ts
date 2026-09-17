/** Browser reads bypass the serialized Server Action queue. Never cache batch progress. */
import { getImpersonatedUserId } from '@/components/auth/ImpersonationProvider'
import type { BatchJob } from '@/app/(dashboard)/dashboard/batch/actions'

export type BatchJobSummary = Omit<BatchJob, 'results' | 'updatedAt' | 'isStuck'>

async function readBatch<T>(path: string): Promise<T> {
  const impersonateId = getImpersonatedUserId()
  const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL}${path}`, {
    credentials: 'include',
    cache: 'no-store',
    headers: impersonateId ? { 'X-Impersonate-User-Id': impersonateId } : {},
  })
  if (!response.ok) throw new Error(`Could not load batch (${response.status})`)
  return response.json() as Promise<T>
}

export function getBatchStatus(batchId: string): Promise<BatchJob> {
  return readBatch(`/batch/${encodeURIComponent(batchId)}`)
}

export async function getBatchJobs(): Promise<BatchJobSummary[]> {
  const data = await readBatch<{ jobs: BatchJobSummary[] }>('/batch')
  return data.jobs ?? []
}
