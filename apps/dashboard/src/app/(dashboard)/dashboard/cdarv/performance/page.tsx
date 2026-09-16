import Link from 'next/link'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import {
  getMonitoringSummary, getPredictions, CdarvUnavailable,
} from '@/lib/cdarv-api'

function money(v: number | null): string {
  return v == null
    ? '—'
    : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(v)
}

export default async function CdarvPerformancePage() {
  let summary, predictions
  try {
    ;[summary, predictions] = await Promise.all([getMonitoringSummary(), getPredictions()])
  } catch (e) {
    if (e instanceof CdarvUnavailable) {
      return (
        <Card className="px-6 py-12 text-center">
          <p className="text-body text-foreground-secondary">CDARV service unavailable</p>
        </Card>
      )
    }
    throw e
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Card className="px-4 py-3">
          <p className="text-caption text-foreground-tertiary">Reviewed reports</p>
          <p className="text-heading-md text-foreground">{summary.independently_reviewed_reports}</p>
        </Card>
        <Card className="px-4 py-3">
          <p className="text-caption text-foreground-tertiary">Datasets</p>
          <p className="text-heading-md text-foreground">{summary.datasets}</p>
        </Card>
        <Card className="px-4 py-3">
          <p className="text-caption text-foreground-tertiary">Models</p>
          <p className="text-heading-md text-foreground">{summary.models}</p>
        </Card>
        <Card className="px-4 py-3">
          <p className="text-caption text-foreground-tertiary">Predictions</p>
          <p className="text-heading-md text-foreground">
            {Object.values(summary.predictions_by_status).reduce((a, b) => a + b, 0)}
          </p>
        </Card>
      </div>

      <Card className="px-4 py-3">
        <h2 className="text-body-sm font-medium text-foreground mb-2">Shadow agreement</h2>
        <p className="text-caption text-foreground-tertiary mb-2">
          Diagnostic only — agreement with the rules engine or reviewer is not outcome accuracy.
        </p>
        <div className="flex flex-wrap gap-2">
          <Badge variant="secondary">
            vs evaluator:{' '}
            {summary.shadow_agreement.evaluator_jaccard_mean != null
              ? `${Math.round(summary.shadow_agreement.evaluator_jaccard_mean * 100)}%`
              : '—'}
          </Badge>
          <Badge variant="secondary">
            vs reviewer:{' '}
            {summary.shadow_agreement.reviewer_overlap_mean != null
              ? `${Math.round(summary.shadow_agreement.reviewer_overlap_mean * 100)}%`
              : '—'}
          </Badge>
          <Badge variant="secondary">gold standard: {summary.gold_standard_reports}</Badge>
          <Badge variant="secondary">outcome accuracy: {summary.shadow_agreement.outcome_accuracy}</Badge>
        </div>
      </Card>

      <div className="grid sm:grid-cols-2 gap-3">
        <Card className="px-4 py-3">
          <h2 className="text-body-sm font-medium text-foreground mb-2">Labels recorded</h2>
          <div className="flex flex-wrap gap-2">
            {Object.entries(summary.labels_by_kind).map(([label, count]) => (
              <Badge key={label} variant="secondary">{label.replaceAll('_', ' ')}: {count}</Badge>
            ))}
            {Object.keys(summary.labels_by_kind).length === 0 && (
              <p className="text-caption text-foreground-tertiary">None yet</p>
            )}
          </div>
        </Card>
        <Card className="px-4 py-3">
          <h2 className="text-body-sm font-medium text-foreground mb-2">Prediction outcomes</h2>
          <div className="flex flex-wrap gap-2">
            {Object.entries(summary.predictions_by_status).map(([s, count]) => (
              <Badge key={s} variant="secondary">{s.replaceAll('_', ' ')}: {count}</Badge>
            ))}
            {Object.keys(summary.predictions_by_status).length === 0 && (
              <p className="text-caption text-foreground-tertiary">None yet</p>
            )}
          </div>
          <p className="text-caption text-foreground-tertiary mt-2">
            Abstentions (&ldquo;insufficient evidence&rdquo;) are reported, not dropped.
          </p>
        </Card>
      </div>

      <Card className="overflow-hidden">
        <div className="px-4 py-3 border-b border-border">
          <h2 className="text-body-sm font-medium text-foreground">Shadow predictions</h2>
          <p className="text-caption text-foreground-tertiary">
            Experimental only — these never affect production reports or underwriting.
          </p>
        </div>
        {predictions.length === 0 ? (
          <p className="px-4 py-8 text-body-sm text-foreground-tertiary text-center">
            No shadow predictions yet. Activate a shadow model, then score a snapshot.
          </p>
        ) : (
          <table className="w-full text-body-sm">
            <thead>
              <tr className="text-left text-caption text-foreground-tertiary border-b border-border">
                <th className="px-4 py-2 font-medium">Snapshot</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Shadow ARV</th>
                <th className="px-4 py-2 font-medium">Selected comps</th>
                <th className="px-4 py-2 font-medium">Scored</th>
              </tr>
            </thead>
            <tbody>
              {predictions.map((p) => (
                <tr key={p.id} className="border-b border-border/50">
                  <td className="px-4 py-2">
                    <Link href={`/dashboard/cdarv/snapshots/${p.snapshot_id}`} className="text-primary hover:underline">
                      {p.snapshot_id.slice(0, 8)}…
                    </Link>
                  </td>
                  <td className="px-4 py-2">
                    <Badge variant={p.status === 'scored' ? 'default' : p.status === 'error' ? 'destructive' : 'secondary'}>
                      {p.status.replaceAll('_', ' ')}
                    </Badge>
                  </td>
                  <td className="px-4 py-2 text-foreground-secondary">{money(p.shadow_arv)}</td>
                  <td className="px-4 py-2 text-caption text-foreground-tertiary">
                    {p.selected_comp_ids.length} comps
                  </td>
                  <td className="px-4 py-2 text-caption text-foreground-tertiary">
                    {p.created_at ? new Date(p.created_at).toLocaleString() : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  )
}
