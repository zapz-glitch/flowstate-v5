import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import {
  getDatasets, getJobs, getModels, getShadowState, CdarvUnavailable,
} from '@/lib/cdarv-api'
import { ModelActions } from './model-actions'

function pct(v: number | null | undefined): string {
  return v == null ? '—' : `${(v * 100).toFixed(1)}%`
}

export default async function CdarvModelsPage() {
  let datasets, models, jobs, shadow
  try {
    ;[datasets, models, jobs, shadow] = await Promise.all([
      getDatasets(), getModels(), getJobs(), getShadowState(),
    ])
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
      <Card className="px-4 py-3 flex items-center justify-between">
        <div>
          <h2 className="text-body-sm font-medium text-foreground">Active shadow model</h2>
          <p className="text-caption text-foreground-tertiary">
            {shadow.active_model
              ? `${shadow.active_model.name} v${shadow.active_model.version} — activated by ${shadow.activated_by}`
              : 'None — shadow scoring is off'}
          </p>
        </div>
        <ModelActions kind="deactivate" enabled={!!shadow.active_model_id} />
      </Card>

      <Card className="overflow-hidden">
        <div className="px-4 py-3 border-b border-border flex items-center justify-between">
          <h2 className="text-body-sm font-medium text-foreground">Datasets</h2>
          <ModelActions kind="build-dataset" enabled />
        </div>
        {datasets.length === 0 ? (
          <p className="px-4 py-8 text-body-sm text-foreground-tertiary text-center">
            No datasets yet — approve reviews, then build a dataset.
          </p>
        ) : (
          <table className="w-full text-body-sm">
            <thead>
              <tr className="text-left text-caption text-foreground-tertiary border-b border-border">
                <th className="px-4 py-2 font-medium">Name</th>
                <th className="px-4 py-2 font-medium">Version</th>
                <th className="px-4 py-2 font-medium">Splits</th>
                <th className="px-4 py-2 font-medium">Feature spec</th>
                <th className="px-4 py-2 font-medium">Code</th>
                <th className="px-4 py-2 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {datasets.map((d) => (
                <tr key={d.id} className="border-b border-border/50">
                  <td className="px-4 py-2 text-foreground">{d.name}</td>
                  <td className="px-4 py-2 text-foreground-secondary">v{d.version}</td>
                  <td className="px-4 py-2 text-caption text-foreground-tertiary">
                    train {d.split_summary.train ?? 0} / val {d.split_summary.val ?? 0} / test {d.split_summary.test ?? 0}
                  </td>
                  <td className="px-4 py-2 text-caption text-foreground-tertiary">{d.feature_spec_version}</td>
                  <td className="px-4 py-2 text-caption text-foreground-tertiary">{d.code_version ?? '—'}</td>
                  <td className="px-4 py-2"><ModelActions kind="train" datasetId={d.id} enabled /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card className="overflow-hidden">
        <div className="px-4 py-3 border-b border-border">
          <h2 className="text-body-sm font-medium text-foreground">Model versions</h2>
        </div>
        {models.length === 0 ? (
          <p className="px-4 py-8 text-body-sm text-foreground-tertiary text-center">
            No trained models yet.
          </p>
        ) : (
          <table className="w-full text-body-sm">
            <thead>
              <tr className="text-left text-caption text-foreground-tertiary border-b border-border">
                <th className="px-4 py-2 font-medium">Model</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Reports</th>
                <th className="px-4 py-2 font-medium">Val precision@k</th>
                <th className="px-4 py-2 font-medium">Val exact-match</th>
                <th className="px-4 py-2 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {models.map((m) => (
                <tr key={m.id} className="border-b border-border/50">
                  <td className="px-4 py-2 text-foreground">{m.name} v{m.version}</td>
                  <td className="px-4 py-2">
                    <Badge variant={m.status === 'shadow' ? 'default' : 'secondary'}>{m.status}</Badge>
                  </td>
                  <td className="px-4 py-2 text-foreground-secondary">
                    {m.metrics?.label_counts?.reviewed_reports ?? '—'}
                  </td>
                  <td className="px-4 py-2 text-foreground-secondary">
                    {pct(m.metrics?.splits?.val?.ranking?.mean_precision_at_k)}
                  </td>
                  <td className="px-4 py-2 text-foreground-secondary">
                    {pct(m.metrics?.splits?.val?.ranking?.exact_match_rate)}
                  </td>
                  <td className="px-4 py-2">
                    <ModelActions
                      kind="activate" modelId={m.id}
                      enabled={m.status !== 'shadow' && m.status !== 'retired'}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card className="overflow-hidden">
        <div className="px-4 py-3 border-b border-border">
          <h2 className="text-body-sm font-medium text-foreground">Jobs</h2>
        </div>
        {jobs.length === 0 ? (
          <p className="px-4 py-6 text-caption text-foreground-tertiary text-center">No jobs yet</p>
        ) : (
          <table className="w-full text-body-sm">
            <tbody>
              {jobs.slice(0, 25).map((j) => (
                <tr key={j.id} className="border-b border-border/50">
                  <td className="px-4 py-2 text-caption text-foreground-tertiary">{j.type}</td>
                  <td className="px-4 py-2">
                    <Badge variant={j.status === 'dead' || j.status === 'failed' ? 'destructive' : 'secondary'}>
                      {j.status}
                    </Badge>
                  </td>
                  <td className="px-4 py-2 text-caption text-foreground-tertiary">
                    attempts {j.attempts}{j.error_detail ? ` · ${j.error_detail.slice(0, 120)}` : ''}
                  </td>
                  <td className="px-4 py-2 text-caption text-foreground-tertiary">
                    {j.created_at ? new Date(j.created_at).toLocaleString() : '—'}
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
