import type { NormalizedComparable } from './types'

type Pool = 'defaults' | 'expanded'
type Entry = { pool: Pool; comp: NormalizedComparable }
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

function validSale(comp: NormalizedComparable, asOfDate: string): string | null {
  const raw = record(comp.raw)
  if (typeof comp.salePrice !== 'number' || !Number.isFinite(comp.salePrice) || comp.salePrice <= 0 || raw.isSale === false) return null
  const directPrice = [raw.salePrice, raw.lastSalePrice, raw.saleAmount].find(value =>
    (typeof value === 'number' || typeof value === 'string') && String(value).trim() !== '' && Number.isFinite(Number(value)) && Number(value) > 0)
  if (directPrice === undefined || Number(directPrice) !== comp.salePrice) return null
  const date = comp.saleDate
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || date > asOfDate) return null
  const parsed = new Date(`${date}T00:00:00Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date ? date : null
}

export function mergeComparablePools(defaults: NormalizedComparable[], expanded: NormalizedComparable[], asOfDate = new Date().toISOString().slice(0, 10)) {
  const groups = new Map<string, Entry[]>()
  // No artificial per-pool cap — pool size is bounded by the provider's
  // documented maximum (CoreLogic maxComps = 100); truncating here would
  // silently drop candidates the appraisal rules were entitled to see.
  for (const [pool, comps] of [['defaults', defaults], ['expanded', expanded]] as const) {
    for (const comp of comps) {
      const entries = groups.get(comp.id) ?? []
      entries.push({ pool, comp })
      groups.set(comp.id, entries)
    }
  }
  const conflictIds: string[] = []
  const comparables: NormalizedComparable[] = []
  for (const [id, entries] of groups) {
    if (entries.length === 1) { comparables.push(entries[0].comp); continue }
    const preferred = entries.findLast(entry => entry.pool === 'expanded') ?? entries.at(-1)!
    let winner = preferred
    let winnerDate = validSale(winner.comp, asOfDate)
    const pricesByDate = new Map<string, number>()
    let conflict = false
    for (const entry of entries) {
      const date = validSale(entry.comp, asOfDate)
      if (!date) continue
      if (pricesByDate.has(date) && pricesByDate.get(date) !== entry.comp.salePrice) conflict = true
      pricesByDate.set(date, entry.comp.salePrice!)
      if (winnerDate === null || date > winnerDate) { winner = entry; winnerDate = date }
    }
    if (conflict) { conflictIds.push(id); winner = preferred }
    const physicalConflicts: string[] = []
    for (const key of ['squareFeet', 'yearBuilt', 'subdivision', 'buildingStyle'] as const) {
      const values = entries.map(({ comp }) => key === 'buildingStyle' ? comp.construction?.buildingStyle : comp[key])
        .filter(value => value !== null && value !== undefined && value !== '').map(value => String(value).trim().toLowerCase())
      if (new Set(values).size > 1) physicalConflicts.push(key)
    }
    comparables.push({ ...winner.comp, raw: { ...record(winner.comp.raw),
      retrievalVariants: entries.map(({ pool, comp }) => ({ pool, raw: comp.raw ?? null, salePrice: comp.salePrice, saleDate: comp.saleDate })),
      ...(conflict ? { retrievalConflict: true } : {}),
      ...(physicalConflicts.length ? { retrievalPhysicalConflicts: physicalConflicts } : {}),
    } })
  }
  return { comparables, conflictIds }
}
