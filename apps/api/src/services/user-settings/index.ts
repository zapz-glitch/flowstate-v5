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
  arvThreshold as arvThresholdTable,
  proximityConfig as proximityConfigTable,
} from '../../db'
import {
  defaultFilterPriority,
  DEFAULT_FILTERS,
  DEFAULT_ADJUSTMENTS,
  type FilterType,
  type AdjustmentType,
  type AppraisalFilter,
  type AppraisalAdjustment,
} from '../appraisal'
import type { ArvTier, RehabEstimate } from '../valuation'
import type { TierRangeDefinition } from '@flowstate-api/shared/valuation'
import { CACHE_TTL, userSettingsKey } from '../cache'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ArvThresholdConfig {
  percent: number
  asIsThresholdPercent?: number
}

export interface UserAnalysisSettings {
  appraisalRules?: {
    filters: AppraisalFilter[]
    adjustments: AppraisalAdjustment[]
  }
  customRehabTable?: Record<ArvTier, RehabEstimate[]>
  customTierRanges?: TierRangeDefinition[]
  mergedBuybox: Record<string, unknown>
  customMajorItemCosts?: Record<string, number>
  arvThreshold: ArvThresholdConfig
  asIsThresholdPercent?: number
  /** Proximity deductions — siding/backing/fronting amounts + ARV threshold */
  proximityConfig?: import('../../routes/proximity-config').ProximityConfig
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
  opts: LoadSettingsOptions,
  kvCache?: KVNamespace
): Promise<UserAnalysisSettings> {
  const { userId, address, buyboxOverrides } = opts

  // Check KV cache first (key includes address hash for location-specific settings)
  if (kvCache) {
    const addressHash = address
      ? [address.city, address.state, address.zipCode].filter(Boolean).join('-').toLowerCase()
      : ''
    const cacheKey = userSettingsKey(userId, addressHash)
    try {
      const cached = await kvCache.get<UserAnalysisSettings>(cacheKey, 'json')
      if (cached) {
        console.log(`[UserSettings] Cache HIT for user ${userId}`)
        // Sanitize cached mergedBuybox — strip any non-numeric or unknown keys
        // (prevents stale cached values like desiredProfit from leaking through)
        if (cached.mergedBuybox) {
          const validKeys = new Set(['closingCostsPercent', 'carryingCostsPercent', 'wholesaleFee', 'rehabLevelIndex', 'majorItems', 'additionPlay'])
          for (const key of Object.keys(cached.mergedBuybox)) {
            if (!validKeys.has(key)) {
              delete cached.mergedBuybox[key]
            }
          }
        }
        // Re-apply buybox overrides on top of cached settings (per-request, not cached)
        if (buyboxOverrides) {
          cached.mergedBuybox = { ...cached.mergedBuybox, ...buyboxOverrides }
        }
        return cached
      }
    } catch (e) {
      console.warn(`[UserSettings] Cache read error:`, e)
    }
  }

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
        const filters: AppraisalFilter[] = presetFilters.map((f) => ({
          type: f.filterType as FilterType,
          enabled: f.enabled,
          value: f.value,
          priority: f.priority === 'hard' || f.priority === 'soft' ? f.priority : defaultFilterPriority(f.filterType as FilterType),
        }))
        const adjustments: AppraisalAdjustment[] = presetAdjustments.map((a) => ({
          type: a.adjustmentType as AdjustmentType,
          enabled: a.enabled,
          amount: a.amount,
          percent: a.percentage,
          // old_comp_discount stores its age threshold (days) in `amount`
          ...(a.adjustmentType === 'old_comp_discount' && a.amount > 0
            ? { thresholdDays: a.amount }
            : {}),
        }))
        // Backfill rule types added after the preset was created — presets
        // only materialize rows for the types that existed at save time, so
        // a missing type means "never configured" and should inherit the
        // system default rather than silently never applying.
        for (const df of DEFAULT_FILTERS) {
          if (!filters.some((f) => f.type === df.type)) filters.push({ ...df })
        }
        for (const da of DEFAULT_ADJUSTMENTS) {
          if (!adjustments.some((a) => a.type === da.type)) adjustments.push({ ...da })
        }
        appraisalRules = { filters, adjustments }
        console.log(`[UserSettings] Loaded appraisal preset: "${preset.name}" (${filters.length} filters, ${adjustments.length} adjustments)`)
      }
    }
  }

  // Load rehab config + deal params + major item costs + arv threshold in parallel
  const [rehabRow, dealParamsRow, majorItemCostsRow, arvThresholdRow, proximityRow] = await Promise.all([
    db.select().from(rehabConfig).where(eq(rehabConfig.userId, userId)).limit(1).then((r) => r[0]),
    db.select().from(dealParams).where(eq(dealParams.userId, userId)).limit(1).then((r) => r[0]),
    db.select().from(majorItemCosts).where(eq(majorItemCosts.userId, userId)).limit(1).then((r) => r[0]),
    db.select().from(arvThresholdTable).where(eq(arvThresholdTable.userId, userId)).limit(1).then((r) => r[0]),
    db.select().from(proximityConfigTable).where(eq(proximityConfigTable.userId, userId)).limit(1).then((r) => r[0]),
  ])

  let customRehabTable: Record<ArvTier, RehabEstimate[]> | undefined
  let customTierRanges: TierRangeDefinition[] | undefined
  let proximityCfg: import('../../routes/proximity-config').ProximityConfig | undefined
  if (proximityRow) {
    try {
      proximityCfg = JSON.parse(proximityRow.configJson)
    } catch {}
  }
  if (rehabRow) {
    try {
      customRehabTable = JSON.parse(rehabRow.configJson)
      console.log(`[UserSettings] Loaded custom rehab config for user ${userId}`)
    } catch {
      console.warn(`[UserSettings] Failed to parse rehab config for user ${userId}, using defaults`)
    }
    if (rehabRow.tierRangesJson) {
      try {
        customTierRanges = JSON.parse(rehabRow.tierRangesJson)
        console.log(`[UserSettings] Loaded custom tier ranges for user ${userId}`)
      } catch {
        console.warn(`[UserSettings] Failed to parse tier ranges for user ${userId}, using defaults`)
      }
    }
  }

  // Merge deal params into buybox (request buybox overrides user defaults)
  // Always provide system defaults so workflow fallbacks are never needed.
  // Only include known numeric deal param fields — prevent stale cached keys from leaking through.
  const baseDeal = dealParamsRow
    ? {
        closingCostsPercent: dealParamsRow.closingCostsPercent,
        carryingCostsPercent: dealParamsRow.carryingCostsPercent,
        wholesaleFee: dealParamsRow.wholesaleFee,
      }
    : { closingCostsPercent: 8, carryingCostsPercent: 2, wholesaleFee: 10000 }
  let mergedBuybox: Record<string, unknown> = {
    ...baseDeal,
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

  // ARV threshold
  let arvThresholdConfig: ArvThresholdConfig = arvThresholdRow
    ? { percent: arvThresholdRow.percent }
    : { percent: 15 }

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
          eq(locationSettings.isEnabled, true),
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
    const arvMatch = bestMatch('arv_threshold')
    const proximityMatch = bestMatch('proximity')

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
        const locFilters: AppraisalFilter[] = pFilters.map((f) => ({
          type: f.filterType as FilterType,
          enabled: f.enabled,
          value: f.value,
          priority: f.priority === 'hard' || f.priority === 'soft' ? f.priority : defaultFilterPriority(f.filterType as FilterType),
        }))
        const locAdjs: AppraisalAdjustment[] = pAdjs.map((a) => ({ type: a.adjustmentType as AdjustmentType, enabled: a.enabled, amount: a.amount, percent: a.percentage }))
        // Same backfill as the default preset — location presets created
        // before a rule type existed inherit the system default for it.
        for (const df of DEFAULT_FILTERS) {
          if (!locFilters.some((f) => f.type === df.type)) locFilters.push({ ...df })
        }
        for (const da of DEFAULT_ADJUSTMENTS) {
          if (!locAdjs.some((a) => a.type === da.type)) locAdjs.push({ ...da })
        }
        appraisalRules = { filters: locFilters, adjustments: locAdjs }
      }
    }
    // Override rehab config
    if (rehabMatch?.rehabConfigJson) {
      try {
        customRehabTable = JSON.parse(rehabMatch.rehabConfigJson)
      } catch {}
    }
    // Override tier ranges
    if (rehabMatch?.tierRangesJson) {
      try {
        customTierRanges = JSON.parse(rehabMatch.tierRangesJson)
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
    // Override ARV threshold
    if (arvMatch?.arvThresholdJson) {
      try {
        const locArv = JSON.parse(arvMatch.arvThresholdJson) as Partial<ArvThresholdConfig>
        arvThresholdConfig = { ...arvThresholdConfig, ...locArv }
      } catch {}
    }
    // Override proximity config (siding/backing/fronting deductions)
    if (proximityMatch?.proximityConfigJson) {
      try {
        proximityCfg = JSON.parse(proximityMatch.proximityConfigJson)
      } catch {}
    }

    const appliedTypes = [
      appraisalMatch && 'appraisal',
      rehabMatch && 'rehab',
      dealMatch && 'deal',
      majorMatch && 'major',
      arvMatch && 'arv_threshold',
    ].filter(Boolean)
    if (appliedTypes.length > 0) {
      console.log(`[UserSettings] Location overrides applied (${appliedTypes.join(', ')}): ${zipNorm ?? cityNorm ?? stateNorm}`)
    }
  }

  const result: UserAnalysisSettings = {
    appraisalRules,
    customRehabTable,
    customTierRanges,
    mergedBuybox,
    customMajorItemCosts,
    arvThreshold: arvThresholdConfig,
    asIsThresholdPercent: arvThresholdConfig.asIsThresholdPercent ?? dealParamsRow?.asIsThresholdPercent ?? undefined,
    proximityConfig: proximityCfg,
  }

  // Cache the result (without per-request buyboxOverrides — those are applied on read)
  if (kvCache) {
    const addressHash = address
      ? [address.city, address.state, address.zipCode].filter(Boolean).join('-').toLowerCase()
      : ''
    const cacheKey = userSettingsKey(userId, addressHash)
    try {
      // Store base settings without request-specific buybox overrides
      const toCache = buyboxOverrides
        ? { ...result, mergedBuybox: (() => { const base = { ...result.mergedBuybox }; for (const key of Object.keys(buyboxOverrides)) delete base[key]; return base })() }
        : result
      await kvCache.put(cacheKey, JSON.stringify(toCache), { expirationTtl: CACHE_TTL.USER_SETTINGS })
      console.log(`[UserSettings] Cache MISS - cached for user ${userId}`)
    } catch (e) {
      console.warn(`[UserSettings] Cache write error:`, e)
    }
  }

  return result
}

/**
 * Invalidate all cached settings for a user.
 * Call this after any settings mutation (appraisal, rehab, deal, major, location).
 */
export async function invalidateUserSettingsCache(
  kvCache: KVNamespace,
  userId: string
): Promise<void> {
  try {
    const prefix = `user-settings:${userId}`
    const listed = await kvCache.list({ prefix })
    if (listed.keys.length > 0) {
      await Promise.all(listed.keys.map((k) => kvCache.delete(k.name)))
      console.log(`[UserSettings] Invalidated ${listed.keys.length} cache entries for user ${userId}`)
    }
  } catch (e) {
    console.warn(`[UserSettings] Cache invalidation error:`, e)
  }
}
