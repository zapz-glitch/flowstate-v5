/**
 * Investor Purchase Detection
 *
 * Detects whether a comparable property was purchased by an investor
 * (LLC, corporation, trust) using:
 * 1. buyerIsCorporate flag (from CoreLogic / ATTOM)
 * 2. Name-pattern heuristic on buyer names
 */

const CORPORATE_ENTITY_PATTERNS = [
  /\bllc\b/i,
  /\binc\.?\b/i,
  /\bcorp\.?\b/i,
  /\bcorporation\b/i,
  /\btrust\b/i,
  /\bproperties\b/i,
  /\bholdings?\b/i,
  /\binvestments?\b/i,
  /\brealty\b/i,
  /\bventures?\b/i,
  /\bcapital\b/i,
  /\bassociates?\b/i,
  /\benterprise[s]?\b/i,
  /\bpartners?(ship)?\b/i,
  /\bfund\b/i,
  /\bacquisitions?\b/i,
  /\bequity\b/i,
  /\bdevelopment\b/i,
]

export function isInvestorPurchase(comp: {
  transaction?: {
    buyerIsCorporate?: boolean
    buyerNames?: string[]
  }
}): { isInvestor: boolean; reason: string } {
  // 1. Explicit corporate flag from data provider
  if (comp.transaction?.buyerIsCorporate === true) {
    return { isInvestor: true, reason: 'Buyer flagged as corporate entity' }
  }

  // 2. Name-pattern heuristic
  const names = comp.transaction?.buyerNames ?? []
  for (const name of names) {
    for (const pattern of CORPORATE_ENTITY_PATTERNS) {
      if (pattern.test(name)) {
        return { isInvestor: true, reason: `Buyer name matches entity pattern: "${name}"` }
      }
    }
  }

  return { isInvestor: false, reason: '' }
}
