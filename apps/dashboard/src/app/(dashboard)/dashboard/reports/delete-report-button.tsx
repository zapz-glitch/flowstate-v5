'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Trash2 } from 'lucide-react'
import { deleteReport } from '@/lib/client-api'

export function DeleteReportButton({ jobId, address }: { jobId: string; address: string }) {
  const router = useRouter()
  const [confirming, setConfirming] = useState(false)
  const [deleting, setDeleting] = useState(false)

  async function handleDelete() {
    setDeleting(true)
    try {
      await deleteReport(jobId)
      router.refresh()
    } catch (err) {
      console.error('Failed to delete report:', err)
    } finally {
      setDeleting(false)
      setConfirming(false)
    }
  }

  if (confirming) {
    return (
      <div className="flex items-center gap-1.5">
        <button
          onClick={handleDelete}
          disabled={deleting}
          className="text-caption font-medium text-red-400 hover:text-red-300 transition-colors disabled:opacity-50"
        >
          {deleting ? 'Deleting...' : 'Confirm'}
        </button>
        <button
          onClick={() => setConfirming(false)}
          disabled={deleting}
          className="text-caption font-medium text-foreground-tertiary hover:text-foreground-secondary transition-colors disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
    )
  }

  return (
    <button
      onClick={() => setConfirming(true)}
      className="text-foreground-tertiary hover:text-red-400 transition-colors"
      title={`Delete report for ${address}`}
    >
      <Trash2 className="w-4 h-4" />
    </button>
  )
}
