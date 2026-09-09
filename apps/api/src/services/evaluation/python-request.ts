import type { EvaluationParams } from './index'
import { DEFAULT_FILTERS, DEFAULT_ADJUSTMENTS } from '../appraisal'
import { DEFAULT_REHAB_TABLE, DEFAULT_TIER_RANGES, MAJOR_ITEMS } from '@flowstate-api/shared/valuation'

type RecordValue = Record<string, unknown>
const object = (value: unknown): RecordValue => value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {}
const decimal = (value: unknown): string | null => typeof value === 'number' && Number.isFinite(value) ? String(value) : typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)) ? value : null
const positive = (value: unknown): string | null => decimal(value) !== null && Number(value) > 0 ? decimal(value) : null
const required = (value: unknown, name: string): string => {
  const result = decimal(value)
  if (result === null || Number(result) < 0) throw new Error(`Python V4 requires a non-negative ${name}`)
  return result
}
const text = (value: unknown): string => typeof value === 'string' ? value : ''
const date = (value: unknown): string | null => {
  if (typeof value !== 'string') return null
  const candidate = /^\d{8}$/.test(value) ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6)}` : value.slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(candidate)) return null
  const parsed = new Date(candidate)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === candidate ? candidate : null
}
const levels = ['lipstick', 'light_cosmetic', 'full_cosmetic', 'heavy_rehab', 'full_gut']
const tierKeys = ['under500k', '500k_to_under1m', '1m_to_3m', 'over3m']
const systemGroup = (id: string): string => {
  if (id === 'electric_panel' || id === 'rewire') return 'electrical'
  if (id === 'replumb') return 'base_overlap:plumbing'
  return ['roof', 'hvac', 'water_heater'].includes(id) ? `base_overlap:${id}` : `auto:${id}`
}
const bounds = [
  { lower_inclusive: '0', upper_exclusive: '500000' },
  { lower_inclusive: '500000', upper_exclusive: '1000000' },
  { lower_inclusive: '1000000', upper_inclusive: '3000000' },
  { lower_exclusive: '3000000' },
]

export function buildPythonRequest(params: EvaluationParams) {
  const { property, comparables, metadata } = params.bundle
  const buybox = params.buybox ?? {}
  const manualItems = new Map<string, { id: string; cost: number }>()
  for (const item of buybox.majorItems ?? []) {
    if (!item.enabled) continue
    const previous = manualItems.get(item.id)
    if (previous && previous.cost !== item.cost) throw new Error(`Python V4 received conflicting manual costs for ${item.id}`)
    manualItems.set(item.id, item)
  }
  if (params.arvThreshold && params.arvThreshold.percent !== 15) throw new Error('Python V4 uses subject-priority ranking; custom legacy ARV percentile is unsupported')
  if (params.asIsThresholdPercent !== undefined && params.asIsThresholdPercent !== 70) throw new Error('Python V4 uses its investor cohort; custom legacy as-is percentage is unsupported')
  const provenance = { source: 'local_v4_adapter', precedence: 'request_override', version: 'evaluation-v4' }
  const suppliedFilters = params.appraisalRules?.filters ?? DEFAULT_FILTERS
  if (suppliedFilters.some(rule => rule.type === 'building_style_match' && !rule.enabled)) throw new Error('Python V4 requires building-style matching against the subject')
  const defaultFilters = suppliedFilters.length === DEFAULT_FILTERS.length && suppliedFilters.every(rule => DEFAULT_FILTERS.some(item => item.type === rule.type && item.enabled === rule.enabled && item.value === rule.value))
  const kinds: Record<string, string> = { building_style_match: 'building_style_match', subdivision_match: 'subdivision_match', sale_age: 'max_sale_age_days', sqft_diff: 'max_sqft_diff', year_built_diff: 'max_year_built_diff', distance: 'max_distance_miles' }
  const filters = suppliedFilters.flatMap(rule => {
    if (!kinds[rule.type]) {
      if (rule.enabled && !defaultFilters) throw new Error(`Python V4 does not support custom ${rule.type}`)
      return []
    }
    return [{ rule_id: rule.type, kind: kinds[rule.type], enabled: rule.enabled,
      value: rule.type === 'sqft_diff' ? property.squareFeet == null ? null : required(property.squareFeet * rule.value / 100, 'sqft difference') : required(rule.value, rule.type),
      unit: rule.type === 'sqft_diff' ? 'sqft' : '', ...provenance }]
  })
  if (!filters.some(rule => rule.kind === 'building_style_match')) filters.push({ rule_id: 'building_style_match', kind: 'building_style_match', enabled: true, value: null, unit: '', ...provenance })
  const adjustments = (params.appraisalRules?.adjustments ?? DEFAULT_ADJUSTMENTS).map(rule => {
    if (rule.enabled && !['bedroom', 'bathroom', 'old_comp_discount'].includes(rule.type)) throw new Error(`Python V4 does not support custom ${rule.type} adjustment evidence`)
    if (rule.type === 'old_comp_discount' && rule.enabled && (rule.percent !== 15 || rule.amount !== 0)) throw new Error('Python V4 has no custom old-comp percentage policy')
    return { rule_id: rule.type, kind: rule.type === 'old_comp_discount' ? 'sale_age' : ['bedroom', 'bathroom'].includes(rule.type) ? rule.type : 'feature', enabled: rule.enabled,
      signed_amount: required(rule.amount, 'adjustment amount'), per_unit_amount: required(rule.amount, 'adjustment amount'),
      unit: rule.type === 'old_comp_discount' ? 'legacy_percent_15_unmapped' : 'USD', applies_to: 'comp', ...provenance }
  })
  const ranges = params.customTierRanges ?? DEFAULT_TIER_RANGES
  const untouchedLegacy = ranges.length === 4 && ranges.every((range, index) => range.key === DEFAULT_TIER_RANGES[index].key && range.minValue === DEFAULT_TIER_RANGES[index].minValue && range.maxValue === DEFAULT_TIER_RANGES[index].maxValue)
  const canonical = ranges.length === 4 && ranges.every((range, index) => range.key === tierKeys[index] && range.minValue === [null, 500000, 1000000, 3000000][index] && range.maxValue === [500000, 1000000, 3000000, null][index])
  if (!untouchedLegacy && !canonical) throw new Error('Python V4 requires canonical 500000 tier boundaries; custom legacy ranges need explicit migration')
  const table = params.customRehabTable ?? DEFAULT_REHAB_TABLE
  const tiers = ranges.map((range, index) => {
    const cells = table[range.key]
    if (!cells || cells.length !== 5) throw new Error(`Python V4 requires five rehab cells for ${range.key}`)
    return { tier_key: tierKeys[index], ...bounds[index], ...provenance,
      cells: cells.map((cell, level) => ({ renovation_level: levels[level], rehab_rate_per_sqft: required(cell.perSqft, 'rehab rate'), flip_profit: required(buybox.desiredProfit ?? cell.minProfit, 'flip profit'), ...provenance })) }
  })
  const level = buybox.rehabLevelIndex ?? 2
  if (!Number.isInteger(level) || !levels[level]) throw new Error('Python V4 renovation level is invalid')
  const evaluationDate = date(metadata.fetchedAt) ?? new Date().toISOString().slice(0, 10)
  const comps = comparables.map(comp => {
    if (comp.provider !== 'corelogic') throw new Error('Python V4 evidence adapter currently requires CoreLogic')
    const raw = object(comp.raw)
    const listingSale = object(raw.listingResolvedSale ?? raw.zillowResolvedSale)
    const condition = object(raw.conditionEvidence)
    const enriched = object(raw.enrichment)
    const sales = object(enriched.lastMarketSale).items
    const transaction = object(object(Array.isArray(sales) ? sales[0] : undefined).transactionDetails)
    const legacySale = object(object(enriched.property).lastSale)
    const directPrice = positive(raw.salePrice) ?? positive(raw.lastSalePrice) ?? positive(raw.saleAmount)
    const directDate = date(raw.saleDate) ?? date(raw.lastSaleDate) ?? date(raw.recordingDate) ?? date(comp.saleDate)
    const detailPrice = positive(transaction.saleAmount) ?? positive(transaction.salePrice) ?? positive(legacySale.salePrice)
    const detailDate = date(transaction.saleDateDerived) ?? date(transaction.saleRecordingDateDerived) ?? date(legacySale.saleDate)
    const useDetail = !directPrice && detailPrice !== null && detailDate !== null && (directDate === null || directDate === detailDate)
    const verifiedPrice = raw.retrievalConflict === true ? null : directPrice ?? (useDetail ? detailPrice : null)
    const saleDate = useDetail ? detailDate : directDate
    const transactionType = text(raw.transactionType) || (useDetail ? text(transaction.saleDocumentType) : '')
    const transactionCode = text(raw.transactionCode) || (useDetail ? text(transaction.saleDocumentTypeCode) : '')
    return { comp_id: comp.id, provider_property_id: comp.id, address: comp.address,
      verified_sale_price: verifiedPrice, sale_date: saleDate,
      is_sale: typeof raw.isSale === 'boolean' ? raw.isSale : verifiedPrice !== null && saleDate !== null ? true : null,
      sqft: decimal(comp.squareFeet), beds: decimal(comp.bedrooms), baths: decimal(comp.bathrooms), year_built: comp.yearBuilt,
      lot_sqft: positive(raw.lotSquareFeet) ?? (comp.lotSizeAcres == null ? null : decimal(comp.lotSizeAcres * 43560)),
      property_type: comp.propertyType ?? '', building_style: comp.construction?.buildingStyle ?? '', distance_miles: decimal(comp.distanceMiles), subdivision: comp.subdivision ?? '',
      transaction_type: transactionType, transaction_code: transactionCode,
      ...(Object.keys(condition).length ? { condition_evidence: condition } : {}),
      ...(Number.isInteger(raw.garageSpaces) && Number(raw.garageSpaces) >= 0 ? { garage_spaces: Number(raw.garageSpaces) } : {}),
      evidence_ref: listingSale.sourceUrl ? `${text(listingSale.source) || 'zillow'}:${comp.id}:sale:${text(listingSale.retrievedAt)}` : `corelogic:${comp.id}:${useDetail ? 'property_sale_detail' : directPrice ? 'comparable_sale' : 'unverified_price'}` }
  })
  return {
    methodology_version: 'evaluation-v4', evaluation_date: evaluationDate,
    subject: { subject_id: property.id, address: property.address, city: property.city, state: property.state, zip: property.zipCode,
      property_type: property.propertyType ?? '', building_style: property.construction?.buildingStyle ?? '', beds: decimal(property.bedrooms), baths: decimal(property.bathrooms), sqft: decimal(property.squareFeet),
      lot_sqft: decimal(property.lotSizeSquareFeet) ?? (property.lotSizeAcres == null ? null : decimal(property.lotSizeAcres * 43560)), year_built: property.yearBuilt, subdivision: property.subdivision ?? '',
      ...(Number.isInteger(object(property.raw).garageSpaces) && Number(object(property.raw).garageSpaces) >= 0 ? { garage_spaces: Number(object(property.raw).garageSpaces) } : {}) },
    comps, renovation_level: levels[level],
    settings: { snapshot_id: `local-v4:${params.jobId}`, schema_version: 'evaluation-v4', arv_selection_policy: 'provider_authoritative_upper_half_v2',
      source_timestamps: { fetched_at: metadata.fetchedAt, tier_policy: untouchedLegacy ? 'v4_canonical_boundaries_from_untouched_legacy_defaults_no_storage_mutation' : 'v4_canonical',
        filter_policy: defaultFilters ? 'v4_defaults_with_required_subject_style_match' : 'request_override_with_required_subject_style_match', old_comp_policy: 'python_sale_age_SKIPPED_NO_POLICY',
        arv_selection_policy: 'user_2026_09_08_provider_authoritative_staged_upper_half', investor_policy: 'python_separated_cohort_not_legacy_arv_percentage',
        minimum_comp_policy: 'user_2026_09_08_minimum_one_verified_preliminary_below_three' },
      filters, adjustments, tiers, transaction_rule: { ...provenance, require_sale_flag: true },
      deal: { ...provenance, closing_cost_percent: required(buybox.closingCostsPercent ?? 8, 'closing cost percent'), carrying_cost_percent: required(buybox.carryingCostsPercent ?? 2, 'carrying cost percent'), wholesale_fee: required(buybox.wholesaleFee ?? 10000, 'wholesale fee'), rounding_increment: '1000' },
      major_items: MAJOR_ITEMS.filter(item => item.ageThreshold !== null).map(item => ({ system_id: item.id, age_threshold_years: String(item.ageThreshold), replacement_cost: required(params.customMajorItemCosts?.[item.id] ?? item.defaultCost, 'major item cost'), inclusion_category: ['roof', 'hvac', 'water_heater', 'electric_panel', 'replumb', 'rewire'].includes(item.id) ? 'initial_auto' : 'operator_additional', ...provenance })) },
    major_item_evidence: [],
    additional_items: [
      ...Array.from(manualItems.values()).map(item => ({ item_id: item.id, cost: required(item.cost, 'manual major item cost'), provenance: 'operator', source: 'request_override', dedup_group: systemGroup(item.id) })),
      ...(buybox.additionPlay ? [{ item_id: 'addition_play', cost: required(buybox.additionPlay, 'addition play'), provenance: 'operator', source: 'request_override', dedup_group: 'manual:addition_play' }] : []),
    ],
  }
}
