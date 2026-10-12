/** True when the filter rules left no usable comp — none is enabled with a
 *  sale price and a living area. */
export function noCompPassesRules(comps: Array<{ isEnabled?: boolean; salePrice?: number | null; squareFeet?: number | null }>): boolean {
  return !comps.some((c) => c.isEnabled !== false && c.salePrice != null && c.salePrice > 0 && c.squareFeet != null && c.squareFeet > 0)
}
