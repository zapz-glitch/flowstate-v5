'use client'

import { useState, useTransition } from 'react'
import { Button } from '@/components/ui/button'
import {
  openReview, saveCompLabels, decideReview, scoreSnapshot,
} from '../../actions'

const LABEL_OPTIONS = [
  { value: 'strong_arv', label: 'Strong ARV comp' },
  { value: 'usable_with_adjustment', label: 'Usable with adjustment' },
  { value: 'unsuitable', label: 'Unsuitable' },
  { value: 'not_reviewed', label: 'Not reviewed' },
]

interface CompRow {
  comp_id: string
  transaction_key: string
  label: string
}

export function ReviewForm({
  snapshotId,
  snapshotStatus,
  comps,
  latestReviewId,
}: {
  snapshotId: string
  snapshotStatus: string
  comps: CompRow[]
  latestReviewId: string | null
}) {
  const [reviewId, setReviewId] = useState<string | null>(latestReviewId)
  const [labels, setLabels] = useState<Record<string, string>>({})
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [scopes, setScopes] = useState({ comp_ranking: true, valuation_benchmark: false })
  const [message, setMessage] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const run = (fn: () => Promise<{ ok: boolean; message?: string; id?: string }>) =>
    startTransition(async () => {
      const r = await fn()
      setMessage(r.message ?? (r.ok ? 'Done' : 'Failed'))
      if (r.id) setReviewId(r.id)
    })

  const reviewable = snapshotStatus !== 'excluded'

  return (
    <div className="space-y-4 pt-2 border-t border-border">
      {!reviewId ? (
        <Button
          size="sm"
          disabled={pending || !reviewable}
          onClick={() => run(() => openReview(snapshotId))}
        >
          Open review
        </Button>
      ) : (
        <>
          <div className="space-y-2">
            <p className="text-caption text-foreground-tertiary">
              Review {reviewId.slice(0, 8)}… — label each candidate. Unlabeled comps stay
              &ldquo;not reviewed&rdquo; and are never treated as negatives.
            </p>
            <div className="space-y-1">
              {comps.map((comp) => (
                <div key={comp.comp_id} className="flex items-center gap-2">
                  <span className="text-caption text-foreground-secondary flex-1 min-w-0 truncate" title={comp.transaction_key}>
                    {comp.label}
                  </span>
                  <select
                    className="text-caption bg-secondary border border-border rounded px-2 py-1"
                    value={labels[comp.comp_id] ?? 'not_reviewed'}
                    onChange={(e) => setLabels({ ...labels, [comp.comp_id]: e.target.value })}
                  >
                    {LABEL_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                  <input
                    className="text-caption bg-secondary border border-border rounded px-2 py-1 w-48"
                    placeholder="note (optional)"
                    value={notes[comp.comp_id] ?? ''}
                    onChange={(e) => setNotes({ ...notes, [comp.comp_id]: e.target.value })}
                  />
                </div>
              ))}
            </div>
            <Button
              size="sm" variant="outline" disabled={pending}
              onClick={() =>
                run(() =>
                  saveCompLabels(
                    reviewId,
                    Object.entries(labels).map(([comp_id, label]) => ({
                      comp_id,
                      label,
                      note: notes[comp_id] || undefined,
                    }))
                  )
                )
              }
            >
              Save labels
            </Button>
          </div>

          <div className="flex flex-wrap items-center gap-3 pt-2 border-t border-border">
            <label className="flex items-center gap-1.5 text-caption text-foreground-secondary">
              <input
                type="checkbox"
                checked={scopes.comp_ranking}
                onChange={(e) => setScopes({ ...scopes, comp_ranking: e.target.checked })}
              />
              approve comp ranking
            </label>
            <label className="flex items-center gap-1.5 text-caption text-foreground-secondary">
              <input
                type="checkbox"
                checked={scopes.valuation_benchmark}
                onChange={(e) => setScopes({ ...scopes, valuation_benchmark: e.target.checked })}
              />
              approve valuation benchmark
            </label>
            <Button
              size="sm" disabled={pending}
              onClick={() => run(() => decideReview(reviewId, 'approve', scopes))}
            >
              Approve for training
            </Button>
            <Button
              size="sm" variant="outline" disabled={pending}
              onClick={() => run(() => decideReview(reviewId, 'needs_more_evidence'))}
            >
              Needs more evidence
            </Button>
            <Button
              size="sm" variant="destructive" disabled={pending}
              onClick={() => run(() => decideReview(reviewId, 'exclude'))}
            >
              Exclude
            </Button>
            <Button
              size="sm" variant="secondary" disabled={pending}
              onClick={() => run(() => scoreSnapshot(snapshotId))}
              title="Queue a shadow prediction with the active model (no-op if none active)"
            >
              Score (shadow)
            </Button>
          </div>
        </>
      )}
      {message && <p className="text-caption text-foreground-tertiary">{message}</p>}
    </div>
  )
}
