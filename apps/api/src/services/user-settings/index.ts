/**
 * User Analysis Settings Loader
 *
 * Shared module for loading all per-user analysis settings:
 * appraisal presets, rehab config, deal params, major item costs, and location overrides.
 *
 * Used by both /v1/analyze route and /webhooks/ghl webhook endpoint.
 */

import { drizzle } from 'drizzle-orm/d1'
import { eq, and, or, sql } from 'drizzle-orm'
import {
  appraisalRulePreset,
  appraisalRuleFilter,
  appraisalRuleAdjustment,
  rehabConfig,
  dealParams,
  locationSettings,
  majorItemCosts,
} from '../../db'
import type {
  FilterType,
  AdjustmentType,
  AppraisalFilter,
  AppraisalAdjustment,
} from '../appraisal'
import type { ArvTier, RehabEstimate } from '../valuation'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface UserAnalysisSettings {
  appraisalRules?: {
    filters: AppraisalFilter[]
    adjustments: AppraisalAdjustment[]
  }
  customRehabTable?: Record<ArvTier, RehabEstimate[]>
  mergedBuybox: Record<string, unknown>
  customMajorItemCosts?: Record<string, number>
}

export interface LoadSettingsOptions {
  userId: string
  address?: {
    city?: string
    state?: string
    zipCode?: string
  }
  buyboxOverrides?: Record<string, unknown>
}

// ─── Main Loader ─────────────────────────────────────────────────────────────

/**
 * Load all user analysis settings needed for a workflow.
 * Handles appraisal presets, rehab config, deal params, major item costs,
 * and location-based overrides (zip > city > state).
 */
export async function loadUserAnalysisSettings(
  d1: D1Database,
  opts: LoadSettingsOptions
): Promise<UserAnalysisSettings> {
  const { userId, address, buyboxOverrides } = opts
  const db = drizzle(d1)

  // Load appraisal rules from user's default preset
  let appraisalRules: UserAnalysisSettings['appraisalRules']
  {
    const [defaultPreset] = await db
      .select({ id: appraisalRulePreset.id })
      .from(appraisalRulePreset)
      .where(and(eq(appraisalRulePreset.userId, userId), eq(appraisalRulePreset.isDefault, true)))
      .limit(1)

    if (defaultPreset) {
      const [preset] = await db
        .select()
        .from(appraisalRulePreset)
        .where(and(eq(appraisalRulePreset.id, defaultPreset.id), eq(appraisalRulePreset.userId, userId)))
        .limit(1)

      if (preset) {
        const [presetFilters, presetAdjustments] = await Promise.all([
          db.select().from(appraisalRuleFilter).where(eq(appraisalRuleFilter.presetId, preset.id)),
          db.select().from(appraisalRuleAdjustment).where(eq(appraisalRuleAdjustment.presetId, preset.id)),
        ])
        appraisalRules = {
          filters: presetFilters.map((f) => ({ type: f.filterType as FilterType, enabled: f.enabled, value: f.value })),
          adjustments: presetAdjustments.map((a) => ({ type: a.adjustmentType as AdjustmentType, enabled: a.enabled, amount: a.amount, percent: a.percentage })),
        }
        console.log(`[UserSettings] Loaded appraisal preset: "${preset.name}" (${presetFilters.length} filters, ${presetAdjustments.length} adjustments)`)
      }
    }
  }

  // Load rehab config + deal params + major item costs in parallel
  const [rehabRow, dealParamsRow, majorItemCostsRow] = await Promise.all([
    db.select().from(rehabConfig).where(eq(rehabConfig.userId, userId)).limit(1).then((r) => r[0]),
    db.select().from(dealParams).where(eq(dealParams.userId, userId)).limit(1).then((r) => r[0]),
    db.select().from(majorItemCosts).where(eq(majorItemCosts.userId, userId)).limit(1).then((r) => r[0]),
  ])

  let customRehabTable: Record<ArvTier, RehabEstimate[]> | undefined
  if (rehabRow) {
    try {
      customRehabTable = JSON.parse(rehabRow.configJson)
      console.log(`[UserSettings] Loaded custom rehab config for user ${userId}`)
    } catch {
      console.warn(`[UserSettings] Failed to parse rehab config for user ${userId}, using defaults`)
    }
  }

  // Merge deal params into buybox (request buybox overrides user defaults)
  let mergedBuybox: Record<string, unknown> = {
    ...(dealParamsRow
      ? {
          closingCostsPercent: dealParamsRow.closingCostsPercent,
          carryingCostsPercent: dealParamsRow.carryingCostsPercent,
          wholesaleFee: dealParamsRow.wholesaleFee,
          desiredProfit: dealParamsRow.desiredProfit,
        }
      : {}),
    ...buyboxOverrides,
  }
  if (dealParamsRow) console.log(`[UserSettings] Loaded deal params for user ${userId}`)

  // Load custom major item costs
  let customMajorItemCosts: Record<string, number> | undefined
  if (majorItemCostsRow) {
    try {
      customMajorItemCosts = JSON.parse(majorItemCostsRow.costsJson)
      console.log(`[UserSettings] Loaded custom major item costs for user ${userId}`)
    } catch {
      console.warn(`[UserSettings] Failed to parse major item costs for user ${userId}`)
    }
  }

  // Location-based overrides (zip > city > state)
  const cityNorm = address?.city?.toLowerCase()
  const stateNorm = address?.state?.toUpperCase()
  const zipNorm = address?.zipCode

  if (cityNorm || stateNorm || zipNorm) {
    const locRows = await db
      .select()
      .from(locationSettings)
      .where(
        and(
          eq(locationSettings.userId, userId),
          or(
            zipNorm ? eq(locationSettings.zipCode, zipNorm) : sql`0`,
            cityNorm ? eq(locationSettings.city, cityNorm) : sql`0`,
            stateNorm ? eq(locationSettings.state, stateNorm) : sql`0`
          )
        )
      )

    const bestMatch = (type: string) => {
      const typed = locRows.filter((r) => r.settingType === type && r.isEnabled)
      return (
        typed.find((r) => r.zipCode !== null && r.zipCode === zipNorm) ??
        typed.find((r) => r.city !== null && r.city === cityNorm && r.state === stateNorm) ??
        typed.find((r) => r.state !== null && r.state === stateNorm && r.city === null)
      )
    }

    const appraisalMatch = bestMatch('appraisal')
    const rehabMatch = bestMatch('rehab')
    const dealMatch = bestMatch('deal')
    const majorMatch = bestMatch('major')

    // Override appraisal preset
    if (appraisalMatch?.appraisalPresetId) {
      const [locPreset] = await db
        .select()
        .from(appraisalRulePreset)
        .where(and(eq(appraisalRulePreset.id, appraisalMatch.appraisalPresetId), eq(appraisalRulePreset.userId, userId)))
        .limit(1)
      if (locPreset) {
        const [pFilters, pAdjs] = await Promise.all([
          db.select().from(appraisalRuleFilter).where(eq(appraisalRuleFilter.presetId, locPreset.id)),
          db.select().from(appraisalRuleAdjustment).where(eq(appraisalRuleAdjustment.presetId, locPreset.id)),
        ])
        appraisalRules = {
          filters: pFilters.map((f) => ({ type: f.filterType as FilterType, enabled: f.enabled, value: f.value })),
          adjustments: pAdjs.map((a) => ({ type: a.adjustmentType as AdjustmentType, enabled: a.enabled, amount: a.amount, percent: a.percentage })),
        }
      }
    }
    // Override rehab config
    if (rehabMatch?.rehabConfigJson) {
      try {
        customRehabTable = JSON.parse(rehabMatch.rehabConfigJson)
      } catch {}
    }
    // Override deal params (location wins over user default; explicit buybox still wins)
    if (dealMatch?.dealParamsJson) {
      try {
        const locDeal = JSON.parse(dealMatch.dealParamsJson)
        mergedBuybox = { ...mergedBuybox, ...locDeal, ...buyboxOverrides }
      } catch {}
    }
    // Override major item costs
    if (majorMatch?.majorItemCostsJson) {
      try {
        const locCosts = JSON.parse(majorMatch.majorItemCostsJson)
        customMajorItemCosts = { ...customMajorItemCosts, ...locCosts }
      } catch {}
    }

    const appliedTypes = [
      appraisalMatch && 'appraisal',
      rehabMatch && 'rehab',
      dealMatch && 'deal',
      majorMatch && 'major',
    ].filter(Boolean)
    if (appliedTypes.length > 0) {
      console.log(`[UserSettings] Location overrides applied (${appliedTypes.join(', ')}): ${zipNorm ?? cityNorm ?? stateNorm}`)
    }
  }

  return {
    appraisalRules,
    customRehabTable,
    mergedBuybox,
    customMajorItemCosts,
  }
}
