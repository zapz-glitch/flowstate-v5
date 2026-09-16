import Link from 'next/link'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { getQueue, getMonitoringSummary, CdarvUnavailable } from '@/lib/cdarv-api'

function StatusBadge({ status }: { status: string }) {
  const variant =
    status === 'approved' ? 'default'
    : status === 'excluded' ? 'destructive'
    : 'secondary'
  return <Badge variant={variant}>{status.replaceAll('_', ' ')}</Badge>
}

export default async function CdarvQueuePage() {
  let snapshots, summary
  try {
    ;[snapshots, summary] = await Promise.all([getQueue(), getMonitoringSummary()])
  } catch (e) {
    if (e instanceof CdarvUnavailable) {
      return (
        <Card className="px-6 py-12 text-center">
          <p className="text-body text-foreground-secondary">CDARV service unavailable</p>
          <p className="text-body-sm text-foreground-tertiary mt-1">
            The CDARV service is not configured on this environment (CDARV_API_URL).
          </p>
        </Card>
      )
    }
    throw e
  }

  const statusCounts = summary.snapshots_by_status

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        {['submitted', 'needs_review', 'needs_more_evidence', 'approved', 'excluded'].map((s) => (
          <Card key={s} className="px-4 py-3">
            <p className="text-caption text-foreground-tertiary">{s.replaceAll('_', ' ')}</p>
            <p className="text-heading-md text-foreground">{statusCounts[s] ?? 0}</p>
          </Card>
        ))}
      </div>

      <Card className="overflow-hidden">
        <div className="px-4 py-3 border-b border-border flex items-center justify-between">
          <h2 className="text-body-sm font-medium text-foreground">Submitted reports</h2>
          <p className="text-caption text-foreground-tertiary">
            {summary.independently_reviewed_reports} independently reviewed
          </p>
        </div>
        {snapshots.length === 0 ? (
          <p className="px-4 py-8 text-body-sm text-foreground-tertiary text-center">
            No reports submitted yet. Use &ldquo;Send to CDARV&rdquo; on a property report.
          </p>
        ) : (
          <table className="w-full text-body-sm">
            <thead>
              <tr className="text-left text-caption text-foreground-tertiary border-b border-border">
                <th className="px-4 py-2 font-medium">Report</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Evidence</th>
                <th className="px-4 py-2 font-medium">v</th>
                <th className="px-4 py-2 font-medium">Submitted</th>
              </tr>
            </thead>
            <tbody>
              {snapshots.map((s) => (
                <tr key={s.id} className="border-b border-border/50 hover:bg-secondary/30">
                  <td className="px-4 py-2">
                    <Link href={`/dashboard/cdarv/snapshots/${s.id}`} className="text-primary hover:underline">
                      {s.address ?? s.report_id}
                    </Link>
                  </td>
                  <td className="px-4 py-2"><StatusBadge status={s.status} /></td>
                  <td className="px-4 py-2">
                    {s.completeness === 'incomplete' ? (
                      <span className="text-amber-600" title={s.completeness_notes ?? ''}>
                        incomplete
                      </span>
                    ) : (
                      <span className="text-foreground-tertiary">complete</span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-foreground-tertiary">{s.version}</td>
                  <td className="px-4 py-2 text-foreground-tertiary">
                    {s.created_at ? new Date(s.created_at).toLocaleDateString() : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card className="px-4 py-3">
        <h2 className="text-body-sm font-medium text-foreground mb-2">Coverage by market</h2>
        {Object.keys(summary.coverage_by_market).length === 0 ? (
          <p className="text-caption text-foreground-tertiary">No coverage yet</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {Object.entries(summary.coverage_by_market).map(([market, count]) => (
              <Badge key={market} variant="secondary">
                {market}: {count}
              </Badge>
            ))}
          </div>
        )}
      </Card>
    </div>
  )
}
