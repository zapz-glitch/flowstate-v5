/**
 * Flip-leg correction — comp pools (find_comparable_sales, market-context)
 * can carry a flip's ACQUISITION leg as the comp's sale. When the comp's
 * sales-history shows a newer priced sale, price the comp on that resale.
 * Every path that builds or merges an enriched comp goes through here.
 */

interface SaleFields {
  salePrice?: number | null
  saleDate?: string | null
  squareFeet?: number | null
  pricePerSqft?: number | null
  latestSale?: { price: number; date: string } | null
}

/** The comp re-priced on its newest recorded sale; the same object when
 *  the pool sale is already the newest. */
export function correctToLatestSale<T extends SaleFields>(comp: T): T {
  const ls = comp.latestSale
  if (!ls || (comp.saleDate && ls.date <= comp.saleDate)) return comp
  return {
    ...comp,
    salePrice: ls.price,
    saleDate: ls.date,
    pricePerSqft: comp.squareFeet ? Math.round(ls.price / comp.squareFeet) : comp.pricePerSqft,
  }
}
