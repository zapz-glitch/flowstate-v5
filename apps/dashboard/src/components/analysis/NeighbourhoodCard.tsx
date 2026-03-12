import {
  MapPin,
  GraduationCap,
  ShieldAlert,
  Users,
  Store,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import type { NeighbourhoodData, SubjectData, CompsData } from './shared-types'
import { NeighbourhoodMap } from './NeighbourhoodMap'

interface NeighbourhoodCardProps {
  data?: NeighbourhoodData | null
  subject?: SubjectData | null
  comps?: CompsData | null
}

function fmt(val: number | null | undefined): string {
  if (val == null) return 'N/A'
  return val.toLocaleString()
}

function fmtCurrency(val: number | null | undefined): string {
  if (val == null) return 'N/A'
  return `$${val.toLocaleString()}`
}

function crimeRiskColor(risk: string | null | undefined): string {
  if (!risk) return 'text-foreground-secondary'
  const r = risk.toLowerCase()
  if (r.includes('low') || r.includes('minimal')) return 'text-emerald-600'
  if (r.includes('moderate') || r.includes('medium')) return 'text-amber-600'
  if (r.includes('high') || r.includes('severe') || r.includes('critical')) return 'text-red-600'
  return 'text-foreground-secondary'
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function Section({
  icon: Icon,
  title,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>
  title: string
  children: React.ReactNode
}) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <Icon className="w-3.5 h-3.5 text-foreground-tertiary" />
        <span className="text-body-sm font-medium">{title}</span>
      </div>
      {children}
    </div>
  )
}

/** Visual bar showing a crime index relative to 100 (national avg). Max display at 300. */
function CrimeBar({ label, value }: { label: string; value?: number | null }) {
  if (value == null) return null
  const pct = Math.min((value / 300) * 100, 100)
  const avgPct = (100 / 300) * 100 // national avg marker position
  const color = value <= 50 ? 'bg-emerald-500' : value <= 100 ? 'bg-amber-500' : value <= 200 ? 'bg-orange-500' : 'bg-red-500'
  const textColor = value <= 50 ? 'text-emerald-600' : value <= 100 ? 'text-amber-600' : value <= 200 ? 'text-orange-600' : 'text-red-600'

  return (
    <div className="space-y-0.5">
      <div className="flex items-center justify-between">
        <span className="text-caption text-foreground-tertiary">{label}</span>
        <span className={cn('text-caption font-semibold tabular-nums', textColor)}>{value}</span>
      </div>
      <div className="relative h-1.5 rounded-full bg-secondary/50">
        <div className={cn('absolute inset-y-0 left-0 rounded-full', color)} style={{ width: `${pct}%` }} />
        <div className="absolute inset-y-0 w-px bg-foreground-tertiary/40" style={{ left: `${avgPct}%` }} title="National average (100)" />
      </div>
    </div>
  )
}

function Stat({ label, value, inline }: { label: string; value: string; inline?: boolean }) {
  if (inline) {
    return (
      <span className="text-body-sm">
        <span className="text-foreground-tertiary">{label}:</span>{' '}
        <span className="font-medium">{value}</span>
      </span>
    )
  }
  return (
    <div>
      <div className="text-caption text-foreground-tertiary">{label}</div>
      <div className="text-body-sm font-medium">{value}</div>
    </div>
  )
}

// ─── Component ───────────────────────────────────────────────────────────────

export function NeighbourhoodCard({ data, subject, comps }: NeighbourhoodCardProps) {
  if (!data) return null

  const hasCrime = !!data.crime
  const hasDemographics = !!data.demographics
  const hasSchools = data.schools?.nearby && data.schools.nearby.length > 0
  const hasPoi = data.poi?.summary && Object.keys(data.poi.summary).length > 0
  const hasMap = !!(subject?.latitude && subject?.longitude)

  if (!hasCrime && !hasDemographics && !hasSchools && !hasPoi && !hasMap) return null

  return (
    <div className="rounded-xl overflow-hidden border border-border px-6 py-4 space-y-5">
      <div className="flex items-center gap-2.5">
        <MapPin className="w-4 h-4 text-primary" />
        <span className="text-body-sm font-semibold">Neighbourhood Analysis</span>
      </div>

      {/* Map */}
      {hasMap && (
        <NeighbourhoodMap subject={subject} comps={comps} neighbourhood={data} />
      )}

      {/* Demographics */}
      {hasDemographics && (
        <Section icon={Users} title="Demographics">
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-2">
            <Stat label="Population" value={fmt(data.demographics?.population)} />
            <Stat label="Median Income" value={fmtCurrency(data.demographics?.medianIncome)} />
            <Stat label="Median Age" value={fmt(data.demographics?.medianAge)} />
            <Stat label="Households" value={fmt(data.demographics?.householdCount)} />
            <Stat label="Median Home Value" value={fmtCurrency(data.demographics?.medianHomeValue)} />
            {data.demographics?.populationDensity != null && (
              <Stat label="Pop. Density" value={`${fmt(data.demographics.populationDensity)}/sq mi`} />
            )}
          </div>
        </Section>
      )}

      {/* Crime */}
      {hasCrime && (
        <>
          {hasDemographics && <div className="border-t border-border" />}
          <Section icon={ShieldAlert} title="Crime">
            <div className="space-y-3">
              {/* Overall risk + index */}
              <div className="flex items-center gap-3">
                {data.crime?.crimeRisk && (
                  <Badge variant="outline" className={cn('border-current', crimeRiskColor(data.crime.crimeRisk))}>
                    {data.crime.crimeRisk}
                  </Badge>
                )}
                {data.crime?.crimeIndex != null && (
                  <span className="text-body-sm text-foreground-tertiary">
                    Overall Index: <span className="font-semibold text-foreground">{data.crime.crimeIndex}</span>
                    <span className="text-caption ml-1">(100 = national avg)</span>
                  </span>
                )}
              </div>

              {/* Violent Crime Breakdown */}
              {data.crime?.violentCrimeIndex != null && (
                <div>
                  <div className="text-caption font-medium text-foreground-secondary mb-1.5">Violent Crime</div>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                    <CrimeBar label="Murder" value={data.crime.murderIndex} />
                    <CrimeBar label="Assault" value={data.crime.assaultIndex} />
                    <CrimeBar label="Robbery" value={data.crime.robberyIndex} />
                  </div>
                </div>
              )}

              {/* Property Crime Breakdown */}
              {data.crime?.propertyCrimeIndex != null && (
                <div>
                  <div className="text-caption font-medium text-foreground-secondary mb-1.5">Property Crime</div>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                    <CrimeBar label="Burglary" value={data.crime.burglaryIndex} />
                    <CrimeBar label="Larceny" value={data.crime.larcenyIndex} />
                    <CrimeBar label="Vehicle Theft" value={data.crime.motorVehicleTheftIndex} />
                  </div>
                </div>
              )}

              {/* Underwriting note */}
              {data.crime?.crimeIndex != null && data.crime.crimeIndex > 150 && (
                <p className="text-caption text-red-600 bg-red-50 dark:bg-red-950/30 rounded-lg px-3 py-1.5">
                  High crime area — may affect insurance costs, rental demand, and resale value.
                </p>
              )}
            </div>
          </Section>
        </>
      )}

      {/* Schools */}
      {hasSchools && (
        <>
          {(hasDemographics || hasCrime) && <div className="border-t border-border" />}
          <Section icon={GraduationCap} title={`Schools (${data.schools!.count ?? data.schools!.nearby!.length})`}>
            <div className="space-y-1.5">
              {data.schools!.nearby!.slice(0, 8).map((school, i) => (
                <div key={i} className="flex items-center justify-between text-body-sm gap-4">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="truncate">{school.name}</span>
                    {school.type && (
                      <Badge variant="secondary" className="text-[10px] px-1.5 py-0 flex-shrink-0">
                        {school.type}
                      </Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-3 flex-shrink-0 text-foreground-tertiary">
                    {school.gradeRange && <span className="text-caption">{school.gradeRange}</span>}
                    {school.rating != null && (
                      <span className={cn('text-caption font-medium', school.rating >= 7 ? 'text-emerald-600' : school.rating >= 4 ? 'text-amber-600' : 'text-red-600')}>
                        {school.rating}/10
                      </span>
                    )}
                    {school.distance != null && (
                      <span className="text-caption tabular-nums">{school.distance.toFixed(1)} mi</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </Section>
        </>
      )}

      {/* Points of Interest */}
      {hasPoi && (
        <>
          {(hasDemographics || hasCrime || hasSchools) && <div className="border-t border-border" />}
          <Section icon={Store} title="Points of Interest">
            <div className="flex flex-wrap gap-2">
              {Object.entries(data.poi!.summary!)
                .sort(([, a], [, b]) => b - a)
                .slice(0, 10)
                .map(([category, count]) => (
                  <Badge key={category} variant="outline" className="text-foreground-secondary">
                    {category} ({count})
                  </Badge>
                ))}
            </div>
          </Section>
        </>
      )}
    </div>
  )
}
