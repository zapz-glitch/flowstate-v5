/**
 * Verified flips — buy → renovate → resell pairs pulled from provider
 * sales-history. Every evaluation records the ones its comps carry, so
 * A/B and accuracy tests can run on known resale prices instead of
 * guessing (`verified_flips` table; scripts/flip-backtest.mjs).
 *
 *   verified  both legs priced, held 30–365 days, resale ≥10% over the
 *             buy, resale not a distressed sale
 *   high      the buy looks like a real sale (≥$30k, gain ≤200%)
 *   medium    the buy may be a transfer, not a market purchase
 */

import { bTrueMedian } from '@flowstate-api/shared/appraisal'
import { correctToLatestSale } from '../property-api/latest-sale'
import { savedToBComps, savedToBSubject } from '../evaluation/saved-pool'

const MIN_DAYS = 30
const MAX_DAYS = 365
const MIN_GAIN = 0.10
const NOMINAL_BUY = 30_000
const MAX_TRUSTED_GAIN = 2.0

export interface FlipSource {
  salePrice?: number | null
  saleDate?: string | null
  squareFeet?: number | null
  pricePerSqft?: number | null
  latestSale?: { price: number; date: string } | null
  flip?: { priorSalePrice: number; priorSaleDate: string } | null
  distressedSale?: boolean | null
}

export interface FlipVerdict {
  verified: boolean
  confidence: 'high' | 'medium' | null
  buy: { price: number; date: string } | null
  sell: { price: number; date: string } | null
  daysHeld: number | null
  gainPct: number | null
  reasons: string[]
}

const days = (a: string, b: string) => Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86_400_000)

/** Is this comp's sale the resale leg of a real flip? Code decides from
 *  the sales record alone — no model call. */
export function verifyFlip(src: FlipSource): FlipVerdict {
  const c = correctToLatestSale(src)
  const buy = c.flip ? { price: c.flip.priorSalePrice, date: String(c.flip.priorSaleDate).slice(0, 10) } : null
  const sell = c.salePrice && c.saleDate ? { price: c.salePrice, date: String(c.saleDate).slice(0, 10) } : null
  const out: FlipVerdict = { verified: false, confidence: null, buy, sell, daysHeld: null, gainPct: null, reasons: [] }
  if (!buy) { out.reasons.push('no prior sale in the record'); return out }
  if (!sell || sell.date <= buy.date) { out.reasons.push('resale leg missing — the pool sale is the buy'); return out }
  out.daysHeld = days(buy.date, sell.date)
  out.gainPct = Math.round(((sell.price - buy.price) / buy.price) * 1000) / 10
  if (out.daysHeld < MIN_DAYS || out.daysHeld > MAX_DAYS) out.reasons.push(`held ${out.daysHeld} days (needs ${MIN_DAYS}–${MAX_DAYS})`)
  if (sell.price < buy.price * (1 + MIN_GAIN)) out.reasons.push(`gain ${out.gainPct}% (needs ≥${MIN_GAIN * 100}%)`)
  if (c.distressedSale === true) out.reasons.push('resale is a distressed sale')
  if (out.reasons.length) return out
  out.verified = true
  const nominal = buy.price < NOMINAL_BUY || sell.price > buy.price * (1 + MAX_TRUSTED_GAIN)
  out.confidence = nominal ? 'medium' : 'high'
  if (nominal) out.reasons.push('buy price looks like a transfer, not a market sale')
  return out
}

// ── Flip class (owner, 2026-10-28) ───────────────────────────────────────
// A flip is not always an after-repair sale. Bought distressed, lightly
// fixed and resold below market, it is a budget flip — as-is evidence.

const WHOLESALE_DAYS = 90
const WHOLESALE_GAIN_PCT = 25

/** 'arv' when the resale $/sf is at or above the true neighborhood median
 *  (Set-B trick 13's median); 'budget' below it; 'wholesale' for a quick,
 *  thin turn (no renovation). null without a median. */
export function flipClass(f: { resalePpsf: number | null; medianPpsf: number | null; daysHeld: number | null; gainPct: number | null }): 'arv' | 'budget' | 'wholesale' | null {
  if (f.daysHeld != null && f.gainPct != null && f.daysHeld < WHOLESALE_DAYS && f.gainPct < WHOLESALE_GAIN_PCT) return 'wholesale'
  if (!f.resalePpsf || !f.medianPpsf) return null
  return f.resalePpsf >= f.medianPpsf ? 'arv' : 'budget'
}

/** The true neighborhood median $/sf of a finished evaluation (its saved
 *  response) — the same median Set-B priced the run with. */
export function medianPpsfOf(response: Record<string, unknown> | null | undefined): number | null {
  if (!response) return null
  const items = (response.comps as { items?: unknown[] } | null)?.items ?? []
  return bTrueMedian(savedToBSubject(response as never), savedToBComps(items as never, null))?.ppsf ?? null
}

// ── Recording ────────────────────────────────────────────────────────────

interface FlipComp extends FlipSource {
  id?: string | number | null
  address?: string | null
  state?: string | null
  latitude?: number | null
  longitude?: number | null
  yearBuilt?: number | null
  bedrooms?: number | null
  bathrooms?: number | null
}

const addressKey = (a: string) => a.toUpperCase().replace(/\b\d{5}(?:-\d{4})?\b/g, '').replace(/[^A-Z0-9]/g, '')
const stateOf = (c: FlipComp) => (c.state && /^[A-Z]{2}$/i.test(c.state) ? c.state.toUpperCase()
  : (c.address ?? '').match(/,\s*([A-Z]{2})(?:\s+\d{5}(?:-\d{4})?)?\s*$/i)?.[1]?.toUpperCase() ?? null)

const UPSERT = `INSERT INTO verified_flips (id, address_key, address, state, provider_id, latitude, longitude,
  square_feet, year_built, bedrooms, bathrooms, buy_price, buy_date, sell_price, sell_date, days_held, gain_pct,
  confidence, reasons_json, first_job_id, last_job_id, created_at, updated_at, flip_class, resale_vs_median)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (address_key, sell_date) DO UPDATE SET
  seen_count = seen_count + 1, last_job_id = excluded.last_job_id, updated_at = excluded.updated_at,
  confidence = excluded.confidence, reasons_json = excluded.reasons_json,
  flip_class = COALESCE(excluded.flip_class, verified_flips.flip_class),
  resale_vs_median = COALESCE(excluded.resale_vs_median, verified_flips.resale_vs_median),
  provider_id = COALESCE(verified_flips.provider_id, excluded.provider_id),
  latitude = COALESCE(verified_flips.latitude, excluded.latitude),
  longitude = COALESCE(verified_flips.longitude, excluded.longitude),
  square_feet = COALESCE(verified_flips.square_feet, excluded.square_feet),
  year_built = COALESCE(verified_flips.year_built, excluded.year_built)`

/** Record every verified flip among an evaluation's comps. Returns how
 *  many were written; a bad comp is skipped, never thrown. `medianPpsf` is
 *  the evaluation's true neighborhood median — it classes each flip. */
export async function recordVerifiedFlips(db: D1Database, comps: FlipComp[] | null | undefined, jobId: string | null, medianPpsf?: number | null): Promise<number> {
  const now = new Date().toISOString()
  const stmts: D1PreparedStatement[] = []
  for (const c of comps ?? []) {
    if (!c?.address) continue
    const v = verifyFlip(c)
    if (!v.verified || !v.buy || !v.sell) continue
    const resalePpsf = c.squareFeet ? v.sell.price / c.squareFeet : null
    const cls = flipClass({ resalePpsf, medianPpsf: medianPpsf ?? null, daysHeld: v.daysHeld, gainPct: v.gainPct })
    const vsMedian = resalePpsf && medianPpsf ? Math.round((resalePpsf / medianPpsf) * 100) / 100 : null
    stmts.push(db.prepare(UPSERT).bind(
      crypto.randomUUID(), addressKey(c.address), c.address, stateOf(c), c.id != null ? String(c.id) : null,
      c.latitude ?? null, c.longitude ?? null, c.squareFeet ?? null, c.yearBuilt ?? null, c.bedrooms ?? null, c.bathrooms ?? null,
      v.buy.price, v.buy.date, v.sell.price, v.sell.date, v.daysHeld, v.gainPct, v.confidence,
      v.reasons.length ? JSON.stringify(v.reasons) : null, jobId, jobId, now, now, cls, vsMedian,
    ))
  }
  if (stmts.length) await db.batch(stmts)
  return stmts.length
}
