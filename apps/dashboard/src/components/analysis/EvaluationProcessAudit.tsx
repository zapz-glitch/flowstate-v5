'use client'

import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import type {
  CompItem,
  CompsData,
  JevHybridData,
  ValuationData,
} from '@/app/(dashboard)/dashboard/analyze/actions'

function fmtUsd(n: number | null | undefined): string {
  return typeof n === 'number' && Number.isFinite(n) ? `$${Math.round(n).toLocaleString()}` : '—'
}

function fmtPct(n: number | null | undefined): string {
  return typeof n === 'number' && Number.isFinite(n) ? `${Math.round(n * 100)}%` : '—'
}

function price(comp: CompItem | undefined): number | null {
  const p = comp?.jevHybrid?.adjustedPrice ?? comp?.adjustedPrice ?? comp?.salePrice
  return typeof p === 'number' && Number.isFinite(p) && p > 0 ? p : null
}

function equation(prices: number[], result: number | null | undefined): string {
  if (!prices.length) return '—'
  return `(${prices.map(fmtUsd).join(' + ')}) ÷ ${prices.length} = ${fmtUsd(result)}`
}

const T2_NOUL_ORDER = ['subdivision', 'neighborhood', 'physicalCharacter', 'material'] as const

type QuestionSet = NonNullable<JevHybridData['questionSet']>

/** Comp row — expandable to both tests: the eight raw-field nouls, the
 *  enriched nouls (subdivision/neighborhood gate + advisory character/
 *  material), and the distance score's level distribution. */
function TestedCompRow({ comp, role, questionSet }: { comp: CompItem | undefined; role: string; questionSet?: QuestionSet }) {
  const [showDetail, setShowDetail] = useState(false)
  const sale = comp?.salePrice
  const adj = comp?.jevHybrid?.adjustedPrice ?? comp?.adjustedPrice
  const showAdj = typeof adj === 'number' && Number.isFinite(adj) && adj !== sale
  const h = comp?.jevHybrid
  const t1 = h?.test1
  const t2 = h?.test2
  // Tolerate pre-two-test saved reports (exam/screen/gate fields).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const legacy = h as any
  const hasLegacyExam = !t1 && !t2 && legacy?.exam != null

  const t1Labels = new Map((questionSet?.test1 ?? []).map((q) => [q.key, q.label]))
  const t2Labels = new Map((questionSet?.test2 ?? []).map((q) => [q.key, q.label]))

  const why = (() => {
    if (!h) return 'no evaluation record'
    if (h.stage === 'ineligible') return `ineligible — ${h.rejectReasons.join('; ') || 'no usable sale data'}`
    if (t2) {
      const gate = t2.passed
        ? `passed test 2${t2.nouls.subdivision >= 0.5 ? ' (subdivision)' : ' (neighborhood)'}`
        : `failed test 2 — subdivision ${fmtPct(t2.nouls.subdivision)} · neighborhood ${fmtPct(t2.nouls.neighborhood)}`
      const parts = [
        `proximity score ${t2.score}/100`,
        t2.confidence != null ? `confidence ${fmtPct(t2.confidence)}` : null,
        gate,
        h.poolRank != null ? `rank #${h.poolRank}` : null,
      ].filter((p): p is string => p != null)
      return parts.join(' · ')
    }
    if (t1) {
      if (t1.passed) return 'passed test 1 — outside the enrichment cap, never test-2\'d'
      const failed = t1.failedFields.map((k) => t1Labels.get(k) ?? k).join(', ')
      const missing = t1.unverifiableFields.map((k) => t1Labels.get(k) ?? k).join(', ')
      return `failed test 1${failed ? ` — ${failed}` : ''}${missing ? `${failed ? ' ·' : ' —'} unverifiable: ${missing}` : ''}`
    }
    if (hasLegacyExam) return 'evaluated under a previous Jev pipeline — detail not shown'
    return 'not tested'
  })()

  const showToggle = t1 || t2

  return (
    <div className="border border-border/40 rounded-sm px-2.5 py-2 space-y-0.5 min-w-0">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-medium truncate">{comp?.address ?? '—'}</span>
        <span className="flex items-center gap-1 shrink-0">
          {h?.score != null && (
            <span className="px-1.5 py-0.5 rounded-sm text-[9px] font-bold tabular-nums bg-border/40 text-foreground-secondary">
              {h.score}
            </span>
          )}
          <span className="px-1.5 py-0.5 rounded-sm text-[9px] uppercase tracking-wide bg-border/40 text-foreground-secondary">
            {role}
          </span>
        </span>
      </div>
      <p className="text-[10px] text-foreground-tertiary tabular-nums">
        sale {fmtUsd(sale)}{showAdj ? ` · adj ${fmtUsd(adj)}` : ''}
      </p>
      <p className="text-[10px] text-foreground-tertiary">{why}</p>
      {showToggle && (
        <>
          <button
            type="button"
            onClick={() => setShowDetail((v) => !v)}
            className="text-[10px] text-primary hover:underline"
          >
            {showDetail ? 'Hide the test answers' : 'Show the test answers'}
          </button>
          {showDetail && (
            <div className="pt-1 space-y-1.5">
              {t1 && (
                <div className="space-y-0.5">
                  <p className="text-[9px] uppercase tracking-wide text-foreground-tertiary">Test 1 — raw fields</p>
                  {(questionSet?.test1 ?? Object.keys(t1.nouls).map((key) => ({ key, label: key }))).map((spec) => {
                    const v = t1.nouls[spec.key]
                    if (typeof v !== 'number') return null
                    const isUnverifiable = t1.unverifiableFields.includes(spec.key)
                    const ok = !isUnverifiable && !t1.failedFields.includes(spec.key)
                    return (
                      <div key={spec.key} className="flex items-baseline justify-between gap-2 text-[10px] tabular-nums">
                        <span className="text-foreground-tertiary truncate">
                          {spec.label}
                          {isUnverifiable ? <span className="text-foreground-tertiary/60"> · unverifiable</span> : null}
                        </span>
                        <span className={isUnverifiable ? 'text-foreground-tertiary' : ok ? 'text-foreground-secondary' : 'text-red-400'}>
                          {Math.round(v * 100)}%{isUnverifiable ? ' n/a' : ok ? ' ✓' : ' failed'}
                        </span>
                      </div>
                    )
                  })}
                  <p className="text-[9px] text-foreground-tertiary/70">
                    every verifiable field ≥50% → passed test 1 → enriched
                  </p>
                </div>
              )}
              {t2 && (
                <div className="space-y-0.5 border-t border-border/30 pt-1">
                  <p className="text-[9px] uppercase tracking-wide text-foreground-tertiary">Test 2 — enriched data</p>
                  {T2_NOUL_ORDER.map((key) => {
                    const v = t2.nouls[key]
                    const advisory = key === 'physicalCharacter' || key === 'material'
                    const ok = v >= 0.5
                    return (
                      <div key={key} className="flex items-baseline justify-between gap-2 text-[10px] tabular-nums">
                        <span className="text-foreground-tertiary truncate">
                          {t2Labels.get(key) ?? key}
                          <span className="text-foreground-tertiary/60">{advisory ? ' · preferred' : ' · gate'}</span>
                        </span>
                        <span className={advisory ? 'text-foreground-secondary' : ok ? 'text-foreground-secondary' : 'text-red-400'}>
                          {Math.round(v * 100)}%{ok ? ' ✓' : advisory ? '' : ' failed'}
                        </span>
                      </div>
                    )
                  })}
                  <p className="text-[9px] text-foreground-tertiary/70">
                    subdivision yes, else neighborhood yes → passed test 2
                  </p>
                  <div className="flex items-baseline justify-between gap-2 text-[10px] tabular-nums pt-0.5">
                    <span className="text-foreground-tertiary">Distance score</span>
                    <span className="text-foreground-secondary">
                      {t2.score}/100{t2.confidence != null ? ` · confidence ${fmtPct(t2.confidence)}` : ''}
                    </span>
                  </div>
                  {Object.entries(t2.levelProbabilities)
                    .filter(([, p]) => typeof p === 'number' && p > 0)
                    .sort(([a], [b]) => Number(b) - Number(a))
                    .map(([level, p]) => (
                      <div key={level} className="flex items-baseline justify-between gap-2 text-[10px] tabular-nums">
                        <span className="text-foreground-tertiary/80 truncate pl-2">
                          level {level}{questionSet?.scoreLevels?.[Number(level)] ? ` — ${questionSet.scoreLevels[Number(level)].split('—')[0].trim()}` : ''}
                        </span>
                        <span className="text-foreground-tertiary">{Math.round(p * 100)}%</span>
                      </div>
                    ))}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <p className="text-[10px] text-foreground-tertiary uppercase tracking-wide">{label}</p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">{children}</div>
    </div>
  )
}

export function EvaluationProcessAudit({
  valuation,
  comps,
  run,
}: {
  valuation: ValuationData | undefined
  comps: CompsData | undefined
  run: JevHybridData | null | undefined
}) {
  const [open, setOpen] = useState(false)
  if (!valuation || !comps) return null
  const items = comps.items ?? []

  // 'arv' tolerated for pre-two-test saved reports.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const coreComps = items.filter((c) => c.jevHybrid?.selected === 'core' || (c.jevHybrid as any)?.selected === 'arv')
  const fillComps = items.filter((c) => c.jevHybrid?.selected === 'fill')
  const t2Fails = items.filter((c) => c.jevHybrid?.stage === 'test2_fail' && c.jevHybrid?.selected == null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fillUsed = run?.selection?.fillUsed === true || (run as any)?.selection?.closestOnly === true
  const arvPrices = [...coreComps, ...fillComps].map(price).filter((n): n is number => n != null)
  const coreTarget = run?.selection?.coreTarget ?? 3

  return (
    <section className="border border-border rounded-sm px-4 py-2.5 text-foreground">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 text-left"
        aria-expanded={open}
      >
        <span className="text-body-sm font-semibold">How Jev evaluated the comps</span>
        <ChevronDown className={cn('w-3.5 h-3.5 text-foreground-tertiary transition-transform', open && 'rotate-180')} />
      </button>

      {open && <div className="space-y-2 mt-2">
      <ol className="list-decimal pl-4 space-y-0.5 text-[10px] text-foreground-tertiary">
        <li>Every comp with a usable sale price and date is eligible — nothing else is pre-filtered.</li>
        <li>{`Test 1 — Jev asks one question per raw field (bathrooms, square feet, lot size, year built, sale price, sale date): does the comp match the subject per the appraisal rules? Passing every verifiable field puts the comp in the "passed test 1" bucket.`}</li>
        <li>Passed-test-1 comps get enriched with full property detail (subdivision, neighborhood, construction, features, transaction).</li>
        <li>Test 2 — on the enriched data: a subdivision match passes; if subdivision fails, a neighborhood match still passes. Both no → test 2 fail → ineligible for the core set. Physical character and material matches are asked as preferred, not required.</li>
        <li>Every comp gets a card score: the test outcome sets the band — passed both tests on top, test-1-pass/test-2-fail in the middle, test-1 fails at the bottom — and the nearest comp to the subject scores highest inside each band. Failing test 2 is never a penalty; passing it is the boost.</li>
        <li>{fillUsed
          ? `Fewer than ${coreTarget} comps passed test 2 — the remaining set filled to ${coreTarget} by score: highest score, closest distance, across every eligible comp.`
          : `Test-2 passers are the primary core comp set — ideally ${coreTarget}.`}</li>
        <li>ARV averages the selected comps’ adjusted prices.</li>
      </ol>

      {!run || run.status !== 'completed' ? (
        <p className="text-[10px] text-foreground-tertiary">No Jev evaluation data on this analysis{run?.reason ? ` — ${run.reason}` : ''}.</p>
      ) : (
        <>
          {run.counts && (
            <p className="text-[10px] text-foreground-tertiary tabular-nums">
              {run.counts.pool} tested · {run.counts.test1Passed} passed test 1 · {run.counts.enriched} enriched · {run.counts.test2Passed} passed test 2 · {run.counts.selected} selected
              {run.counts.filled > 0 ? ` (${run.counts.filled} filled)` : ''}
              {run.counts.ineligible > 0 ? ` · ${run.counts.ineligible} ineligible` : ''}
              {run.model ? ` · ${run.model}` : ''}
            </p>
          )}
          {coreComps.length > 0 ? (
            <Group label={`Core comp set (${coreComps.length})`}>
              {coreComps.map((c) => <TestedCompRow key={c.id} comp={c} role="Core" questionSet={run.questionSet} />)}
            </Group>
          ) : (
            <p className="text-[10px] text-foreground-tertiary">No comps passed both tests.</p>
          )}
          {fillComps.length > 0 && (
            <Group label={`Fill picks — best remaining by score (${fillComps.length})`}>
              {fillComps.map((c) => <TestedCompRow key={c.id} comp={c} role="Fill" questionSet={run.questionSet} />)}
            </Group>
          )}
          {t2Fails.length > 0 && (
            <Group label={`Passed test 1, failed test 2 — ineligible (${t2Fails.length})`}>
              {t2Fails.map((c) => <TestedCompRow key={c.id} comp={c} role="T2 fail" questionSet={run.questionSet} />)}
            </Group>
          )}
          <p className="text-[10px] text-foreground-secondary tabular-nums">
            ARV = {equation(arvPrices, valuation.arv ?? null)}
          </p>
        </>
      )}
      </div>}
    </section>
  )
}
