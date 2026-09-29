/**
 * buildDealContext — package the live deal the offers UI is showing into the
 * `deal` object every disposition dispatch carries to the engine. Pulls from
 * the same displayValuation/comps the report page renders, so the engine sees
 * exactly the numbers the user decided on.
 *
 * - wholesalePrice: the contract purchase price (displayed wholesale, else buy)
 * - arv: the displayed after-repair value (manual override honored)
 * - renovationTier: tier name only — never scope/line items
 * - comps: the comps actually SELECTED for the valuation (manual override set
 *   when active, otherwise every enabled comp)
 */

import type { CompItem } from '../app/(dashboard)/dashboard/analyze/actions'
import { getCompKey } from '../components/analysis/format-helpers'

export type DealDisposition = 'prep_offer' | 'no_margin' | 'no_offer'

export interface DealCompRef {
  address: string
  arv: number | null
}

export interface DealContext {
  disposition: DealDisposition
  wholesalePrice: number | null
  arv: number | null
  renovationTier: string | null
  comps: DealCompRef[]
}

export function buildDealContext(
  disposition: DealDisposition,
  valuation: { arv?: number | null; wholesalePrice?: number | null; buyPrice?: number | null; rehabLevel?: string | null } | null | undefined,
  compItems: CompItem[] | null | undefined,
  selectedCompKeys?: Set<string> | null,
): DealContext | null {
  if (!valuation && !(compItems?.length)) return null
  const selected = (compItems ?? [])
    .map((item, i) => ({ item, key: getCompKey(item, i) }))
    .filter(({ item, key }) => selectedCompKeys ? selectedCompKeys.has(key) : item.isEnabled !== false)
  return {
    disposition,
    wholesalePrice: valuation?.wholesalePrice ?? valuation?.buyPrice ?? null,
    arv: valuation?.arv ?? null,
    renovationTier: valuation?.rehabLevel ?? null,
    comps: selected
      .filter(({ item }) => !!item.address)
      .map(({ item }) => ({
        address: item.address!,
        arv: item.adjustedPrice ?? item.salePrice ?? null,
      })),
  }
}
