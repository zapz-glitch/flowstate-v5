/**
 * Saved-report → Set-B input mapping. One mapper feeds both the
 * serving-layer recalculate path and the offline replay script — the two
 * can never drift apart (a replay result is what the report would show).
 */

import type { BComp, BSubject } from '@flowstate-api/shared/appraisal'

interface SavedCompItem {
  id: string
  salePrice: number | null
  adjustedPrice: number | null
  squareFeet: number | null
  isEnabled?: boolean
  appraisalRules?: { passedFilters?: boolean; totalAdjustment?: number | null } | null
  [key: string]: unknown
}

export function savedToBComps(
  items: SavedCompItem[],
  enabledIds: Set<string> | null,
): BComp[] {
  return items.map((c) => ({
    address: (c.address as string) ?? null,
    isEnabled: enabledIds ? enabledIds.has(c.id) : c.isEnabled !== false,
    salePrice: c.salePrice ?? null,
    saleDate: (c.saleDate as string) ?? null,
    squareFeet: c.squareFeet ?? null,
    pricePerSqft: (c.pricePerSqft as number) ?? null,
    adjustedPrice: c.adjustedPrice ?? null,
    distanceMiles: (c.distanceMiles as number) ?? null,
    sameBlockGroup: (c.sameBlockGroup as boolean) ?? null,
    censusTract: (c.censusTract as string) ?? null,
    subdivision: (c.subdivision as string) ?? null,
    neighborhoodName: (c.neighborhoodName as string) ?? null,
    yearBuilt: (c.yearBuilt as number) ?? null,
    lotSizeAcres: (c.lotSizeAcres as number) ?? null,
    lotSizeSquareFeet: (c.lotSizeSquareFeet as number) ?? null,
    landAssessedValue: (c.landAssessedValue as number) ?? null,
    propertyType: (c.propertyType as string) ?? null,
    crossesMajorRoad: (c.crossesMajorRoad as boolean) ?? null,
    disableReasons: (c.disableReasons as string[]) ?? null,
    classification: (c.classification as BComp['classification']) ?? null,
    curbAppeal: (c.curbAppeal as BComp['curbAppeal']) ?? null,
    evidenceVerification: (c.evidenceVerification as BComp['evidenceVerification']) ?? null,
    appraisalRules: c.appraisalRules
      ? { totalAdjustment: c.appraisalRules.totalAdjustment ?? null }
      : null,
  }))
}

export function savedToBSubject(saved: {
  subject?: Record<string, unknown>
  valuation?: Record<string, unknown>
}): BSubject {
  const subject = (saved.subject ?? {}) as Record<string, unknown>
  const savedVal = (saved.valuation ?? {}) as Record<string, unknown>
  const subjectAvm =
    (subject.avm as { value?: number } | undefined)?.value ??
    (subject.avmValue as number) ??
    null
  return {
    squareFeet: (subject.squareFeet as number) ?? null,
    yearBuilt: (subject.yearBuilt as number) ?? null,
    censusTract: (subject.censusTract as string) ?? null,
    subdivision: (subject.subdivision as string) ?? null,
    neighborhoodName: (subject.neighborhoodName as string) ?? null,
    landAssessedValue: (subject.landAssessedValue as number) ?? null,
    taxAssessment: (subject.assessedValue as number) ?? null,
    assessedValue: (subject.assessedValue as number) ?? null,
    avmValue: subjectAvm,
    lotSizeAcres: (subject.lotSizeAcres as number) ?? null,
    lotSizeSquareFeet: (subject.lotSizeSquareFeet as number) ?? null,
    condition: (savedVal.rehabLevel as string) ?? null,
  }
}
