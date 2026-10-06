'use client'

import { useState } from 'react'
import { Building2, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { updateCrm, type CrmUpdateValues } from '@/lib/client-api'

/**
 * Push the report's current (post-edit) evaluation values to the Close CRM
 * lead stored on the report (leadId captured from POST /v1/analyze).
 * Idempotent — each click PUTs the same lead's custom fields.
 * Disabled with an explanatory tooltip when the report has no CRM lead.
 */
export function UpdateCrmButton({
  jobId,
  leadId,
  values,
}: {
  jobId: string
  leadId?: string | null
  values?: CrmUpdateValues | null
}) {
  const [pending, setPending] = useState(false)

  const disabled = pending || !values || !leadId

  const onClick = async () => {
    if (!values) return
    setPending(true)
    try {
      const r = await updateCrm(jobId, values)
      toast.success(`Close lead updated — ${r.fieldsWritten} fields written`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'CRM update failed')
    } finally {
      setPending(false)
    }
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={leadId
        ? 'Push the current (edited) evaluation values to this lead in Close CRM'
        : 'No CRM lead linked — this report was created without a Close leadId'}
      className="p-1.5 rounded-lg text-foreground-tertiary hover:text-foreground hover:bg-secondary transition-colors disabled:opacity-50 no-print"
    >
      {pending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Building2 className="w-3.5 h-3.5" />}
    </button>
  )
}
