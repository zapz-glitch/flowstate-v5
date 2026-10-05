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

interface GradeDriver {
  comp?: {
    salePrice?: number | null
    squareFeet?: number | null
    evidenceVerification?: {
      staleness?: string | null
      priceCheck?: string | null
    } | null
  } | null
}

function driverEvidenceVerified(driver: unknown): boolean {
  const comp = (driver as GradeDriver)?.comp ?? driver as GradeDriver['comp']
  const verification = comp?.evidenceVerification
  return comp != null &&
    (comp.salePrice ?? 0) > 0 &&
    (comp.squareFeet ?? 0) > 0 &&
    verification != null &&
    verification.staleness !== 'stale' &&
    verification.staleness !== 'above_pocket' &&
    verification.priceCheck !== 'divergent'
}

function lastFailure(attemptTrail: string[]): string | null {
  const final = attemptTrail.findLast((t) => t.startsWith('final — unverified'))
  const match = final?.match(/^final — unverified \((.*)\)$/)
  return match?.[1] ?? null
}

function gradeWord(grade: ResultGrade): string {
  return grade === 'withheld' ? 'Withheld' : grade === 'floor' ? 'Floor' : grade === 'weak' ? 'Weak' : 'Verified'
}

function floorBasis(source: string, arvSource: string | null | undefined): string {
  if (arvSource === 'avm' || source === 'T3 AVM floor') return 'subject AVM'
  if (arvSource === 'assessed' || source === 'T4 assessed') return 'county assessed value'
  if (source === 'T2 pocket-implied') return 'pocket-implied value'
  if (arvSource === 'nearest') return 'nearest-comp estimate'
  return 'conservative floor value'
}

export function resultStatusReason(
  b: { source: string; conf: 'high' | 'medium' | 'low' | 'none'; drivers: unknown[]; flags: string[]; arv?: number | null; bracket?: string },
  fallbackUsed: string | null | undefined,
  attemptTrail: string[],
  grades: { resultGrade: ResultGrade; processGrade: ProcessGrade },
  context?: { arvSource?: string | null },
): string {
  const failure = lastFailure(attemptTrail)
  const conf = b.conf === 'none' ? 'no' : b.conf
  const count = b.drivers.length

  if (grades.resultGrade === 'withheld') {
    return `Withheld — ${failure ?? 'evidence produced no defensible answer'}.`
  }
  if (grades.resultGrade === 'floor') {
    return `Floor — no checked comp set; using ${floorBasis(b.source, context?.arvSource)}.`
  }

  let why: string
  if (failure) why = `final check failed: ${failure}`
  else if (b.bracket === 'all-smaller') why = 'all driver comps are smaller than the subject'
  else if (b.bracket === 'all-bigger') why = 'all driver comps are bigger than the subject'
  else if (b.flags.some((f) => f.includes('exceeds size-adjusted ceiling'))) why = 'the answer hit the evidence ceiling'
  else if (b.source === 'median+50% AVM uplift') why = 'only median-tier comps were found'
  else if (b.source === 'median ceiling') why = 'evidence stopped at the median ceiling'
  else if (count < 3) why = `only ${count || 'no'} checked comp${count === 1 ? '' : 's'} support${count === 1 ? 's' : ''} it`
  else if (fallbackUsed && RESCUE_RUNGS.has(fallbackUsed)) why = 'the answer needed widened evidence'
  else if (b.flags.length) why = 'supporting evidence has caveats'
  else why = `${count} checked comps support it`

  const retried = grades.processGrade === 'retried' ? ' after retry' : ''
  return `${gradeWord(grades.resultGrade)} · ${conf} confidence — ${why}${retried}.`
}

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

  if (b.arv != null && FLOOR_SOURCES.includes(b.source)) {
    return { resultGrade: 'floor', processGrade }
  }
  if (b.arv == null || (b.conf === 'none' && b.drivers.length === 0)) {
    return { resultGrade: 'withheld', processGrade }
  }
  if (fallbackUsed === 'nearest_comps' || fallbackUsed === 'insufficient') {
    return { resultGrade: 'floor', processGrade }
  }
  const driversVerified = b.drivers.length >= 3 && b.drivers.every(driverEvidenceVerified)
  if (
    WEAK_SOURCES.includes(b.source) ||
    b.drivers.length < 3 ||
    !driversVerified ||
    (fallbackUsed != null && RESCUE_RUNGS.has(fallbackUsed)) ||
    unverified
  ) {
    return { resultGrade: 'weak', processGrade }
  }
  return { resultGrade: 'verified', processGrade }
}
