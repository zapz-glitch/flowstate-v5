import { notFound } from 'next/navigation'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { getSnapshotDetail, getPredictions } from '@/lib/cdarv-api'
import { ReviewForm } from './review-form'

function money(v: unknown): string {
  return typeof v === 'number'
    ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(v)
    : '—'
}

export default async function CdarvSnapshotPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const detail = await getSnapshotDetail(id).catch(() => null)
  if (!detail) notFound()

  const { snapshot, review_packet, reviews } = detail
  const predictions = await getPredictions(snapshot.id).catch(() => [])
  const subject = review_packet.subject
  const valuation = review_packet.valuation
  const latestReview = reviews[0] ?? null

  return (
    <div className="space-y-6">
      <Card className="px-4 py-3 space-y-1">
        <div className="flex items-center justify-between">
          <h2 className="text-body font-medium text-foreground">
            {(subject.address as string) ?? snapshot.report_id}
          </h2>
          <Badge variant="secondary">{snapshot.status.replaceAll('_', ' ')}</Badge>
        </div>
        <p className="text-caption text-foreground-tertiary">
          Snapshot v{snapshot.version} · report {snapshot.report_id} ·
          rehab target: {(snapshot.provenance.rehab_level as string) ?? '—'} ·
          evaluator ARV: {money(valuation.arv)}
        </p>
        {snapshot.completeness === 'incomplete' && (
          <p className="text-caption text-amber-600">
            Incomplete evidence: {snapshot.completeness_notes}
          </p>
        )}
      </Card>

      {review_packet.applied_settings?.filters && review_packet.applied_settings.filters.length > 0 && (
        <Card className="px-4 py-3">
          <h3 className="text-body-sm font-medium text-foreground mb-2">Rules applied (this run)</h3>
          <div className="flex flex-wrap gap-1.5">
            {review_packet.applied_settings.filters.map((f) => (
              <Badge key={f.type} variant={f.enabled ? 'secondary' : 'outline'}>
                {f.type}{f.enabled ? `: ${f.value}` : ' (off)'}
              </Badge>
            ))}
          </div>
        </Card>
      )}

      {review_packet.selection_history.length > 0 && (
        <Card className="px-4 py-3 space-y-2">
          <h3 className="text-body-sm font-medium text-foreground">Operator selection trail</h3>
          <ul className="space-y-1.5 text-caption">
            {review_packet.selection_history.map((h, i) => (
              <li key={i} className="text-foreground-secondary">
                <span className="text-foreground-tertiary">{h.created_at ? new Date(h.created_at).toLocaleString() : ''}</span>
                {' '}<Badge variant="outline" className="mx-1">{h.action}</Badge>{' '}
                {h.description}
                {h.arv_before && h.arv_after && (
                  <span className="block text-foreground-tertiary pl-4 mt-0.5">
                    {h.arv_before.join(', ') || '(auto)'} → {h.arv_after.join(', ') || '(auto)'}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card className="overflow-hidden">
        <div className="px-4 py-3 border-b border-border">
          <h3 className="text-body-sm font-medium text-foreground">
            Candidate pool — original evaluator evidence ({review_packet.comps.length} comps)
          </h3>
          <p className="text-caption text-foreground-tertiary">
            Evaluator outputs shown for diagnosis; they are not model inputs.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-body-sm">
            <thead>
              <tr className="text-left text-caption text-foreground-tertiary border-b border-border">
                <th className="px-4 py-2 font-medium">Comp</th>
                <th className="px-4 py-2 font-medium">Sale</th>
                <th className="px-4 py-2 font-medium">Dist</th>
                <th className="px-4 py-2 font-medium">Sqft</th>
                <th className="px-4 py-2 font-medium">Evaluator</th>
                <th className="px-4 py-2 font-medium">Rules</th>
              </tr>
            </thead>
            <tbody>
              {review_packet.comps.map((comp) => (
                <tr key={comp.comp_id} className="border-b border-border/50">
                  <td className="px-4 py-2">
                    <span className="text-foreground">{(comp.raw.address as string) ?? comp.comp_id}</span>
                    <span className="block text-caption text-foreground-tertiary">{comp.transaction_key}</span>
                  </td>
                  <td className="px-4 py-2">
                    {money(comp.raw.salePrice)}
                    <span className="block text-caption text-foreground-tertiary">
                      {(comp.raw.saleDate as string) ?? '—'}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-foreground-secondary">
                    {typeof comp.raw.distanceMiles === 'number' ? `${comp.raw.distanceMiles} mi` : '—'}
                  </td>
                  <td className="px-4 py-2 text-foreground-secondary">
                    {(comp.raw.squareFeet as number) ?? '—'}
                  </td>
                  <td className="px-4 py-2">
                    {comp.rule_context.evaluator_selected ? (
                      <Badge variant="default">selected{comp.rule_context.evaluator_group ? ` (${comp.rule_context.evaluator_group})` : ''}</Badge>
                    ) : comp.rule_context.is_enabled ? (
                      <Badge variant="secondary">enabled</Badge>
                    ) : (
                      <Badge variant="outline">rejected</Badge>
                    )}
                  </td>
                  <td className="px-4 py-2 text-caption text-foreground-tertiary">
                    {comp.rule_context.filter_passed_count} passed / {comp.rule_context.filter_failed_count} failed
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card className="px-4 py-3 space-y-3">
        <h3 className="text-body-sm font-medium text-foreground">Reviews</h3>
        {reviews.length === 0 ? (
          <p className="text-caption text-foreground-tertiary">No reviews yet — open one to label comps.</p>
        ) : (
          <ul className="space-y-1 text-body-sm">
            {reviews.map((r) => (
              <li key={r.id} className="flex items-center gap-3">
                <Badge variant="secondary">v{r.version} {r.status.replaceAll('_', ' ')}</Badge>
                <span className="text-foreground-tertiary text-caption">
                  {r.reviewer_id} · {r.created_at ? new Date(r.created_at).toLocaleString() : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
        <ReviewForm
          snapshotId={snapshot.id}
          snapshotStatus={snapshot.status}
          comps={review_packet.comps.map((comp) => ({
            comp_id: comp.comp_id,
            transaction_key: comp.transaction_key,
            label: (comp.raw.address as string) ?? comp.comp_id,
          }))}
          latestReviewId={latestReview && (latestReview.status === 'needs_review' || latestReview.status === 'needs_more_evidence') ? latestReview.id : null}
        />
      </Card>

      {predictions.length > 0 && (
        <Card className="px-4 py-3 space-y-2">
          <h3 className="text-body-sm font-medium text-foreground">CDARV — Experimental / Shadow predictions</h3>
          {predictions.map((p) => (
            <div key={p.id} className="flex items-center gap-4 text-body-sm">
              <Badge variant={p.status === 'scored' ? 'default' : 'secondary'}>{p.status.replaceAll('_', ' ')}</Badge>
              <span className="text-foreground-secondary">shadow ARV: {money(p.shadow_arv)}</span>
              <span className="text-caption text-foreground-tertiary">
                comps: {p.selected_comp_ids.join(', ')}
              </span>
            </div>
          ))}
        </Card>
      )}
    </div>
  )
}
