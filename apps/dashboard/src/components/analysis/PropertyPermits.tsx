import type { SubjectData } from './shared-types'
import { formatShortDate } from './format-helpers'

export function PropertyPermits({ permits, loading = false }: { permits: SubjectData['permits']; loading?: boolean }) {
  const items = permits?.items ?? []
  return (
    <section aria-label="Property permits" className="mt-3 border-t border-border pt-2 text-xs break-words">
      {loading && !permits ? <p>Permits - Loading...</p> : items.length ? (
        <>
          <h4 className="font-semibold">Permits ({items.length})</h4>
          <ul className="mt-1 space-y-2 max-h-60 overflow-y-auto">
            {items.map((permit, index) => (
              <li key={`${permit.permitId}-${index}`}>
                <p className="font-medium">{permit.projectType || 'Permit'}{permit.permitNumber ? ` · #${permit.permitNumber}` : ''}</p>
                {permit.description && <p>{permit.description}</p>}
                <p className="text-foreground-secondary">
                  {permit.status || 'Status unavailable'}
                  {permit.effectiveDate ? ` · ${formatShortDate(permit.effectiveDate)}` : ''}
                  {permit.jobValue != null ? ` · $${permit.jobValue.toLocaleString('en-US', { maximumFractionDigits: 0 })}` : ''}
                </p>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <>
          <p className="font-medium">Permits - NA</p>
          <p className="text-foreground-secondary">{permits?.status === 'empty' ? 'No permit records returned by the provider.' : permits?.status === 'unavailable' ? 'Permit lookup unavailable. This does not confirm that no permits exist.' : 'Permit details were not saved in this report. Run a new evaluation to retrieve them.'}</p>
        </>
      )}
    </section>
  )
}
