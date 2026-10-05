/**
 * Result grade — the run-level trust label. NOT comp classification:
 * Clef/Luna label what each comp IS; this grades what the RUN produced.
 *
 * verified — comp-anchored answer, first-try verified, ≥3 drivers
 * weak     — answered, but on soft evidence: rescue rungs, median-only
 *            evidence, or a thin driver set
 * floor    — no comp evidence: pocket-implied / AVM / assessed / nearest
 * withheld — the harness refused
 *
 * processGrade — did the run earn it: clean (verified attempt 1),
 * retried (verified after widen/deepen), unverified (trail ends suspect).
 */

export type ResultGrade = 'verified' | 'weak' | 'floor' | 'withheld'
export type ProcessGrade = 'clean' | 'retried' | 'unverified'

const FLOOR_SOURCES = ['T2 pocket-implied', 'T3 AVM floor', 'T4 assessed']
const WEAK_SOURCES = ['median+50% AVM uplift', 'median ceiling']
const RESCUE_RUNGS = new Set([
  'year_built_expansion', 'sqft_expansion', 'pocket_expansion',
  'subdivision_expansion', 'neighborhood_expansion', 'geographic_expansion',
  'sale_age_expansion', 'pocket_catch', 'nearest_comps',
])

export function gradeResult(
  b: { source: string; conf: 'high' | 'medium' | 'low' | 'none'; drivers: unknown[]; flags: string[]; arv?: number | null },
  fallbackUsed: string | null | undefined,
  attemptTrail: string[],
): { resultGrade: ResultGrade; processGrade: ProcessGrade } {
  const unverified = attemptTrail.some((t) => t.startsWith('final — unverified'))
  const processGrade: ProcessGrade =
    unverified ? 'unverified'
    : attemptTrail.length > 1 || attemptTrail.some((t) => !t.startsWith('attempt 1')) ? 'retried'
    : 'clean'

  if (b.arv == null || (b.conf === 'none' && b.drivers.length === 0)) {
    return { resultGrade: 'withheld', processGrade }
  }
  if (FLOOR_SOURCES.includes(b.source) || fallbackUsed === 'nearest_comps' || fallbackUsed === 'insufficient') {
    return { resultGrade: 'floor', processGrade }
  }
  if (
    WEAK_SOURCES.includes(b.source) ||
    b.drivers.length < 3 ||
    (fallbackUsed != null && RESCUE_RUNGS.has(fallbackUsed)) ||
    unverified
  ) {
    return { resultGrade: 'weak', processGrade }
  }
  return { resultGrade: 'verified', processGrade }
}
