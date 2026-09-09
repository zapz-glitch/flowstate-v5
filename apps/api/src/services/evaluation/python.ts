import type { Env } from '../../types'
import type { AnalysisResponse } from '../analysis'
import type { NormalizedComparable, NormalizedProperty } from '../property-api/types'
import { performAnalysis, type EvaluationParams } from './index'
import { buildPythonRequest } from './python-request'
import { signConfiguredPythonSnapshot, verifyConfiguredPythonSnapshot } from './python-snapshot'
import { refreshZillowEvidence } from './zillow-evidence'
import { observeConditions, type ConditionImage } from './condition-evidence'
import { assetKey, persistReportAssets } from '../report-assets'
import { evaluateHostedPython, type PythonExecutionContext } from './python-hosted'

export type PythonRequest = ReturnType<typeof buildPythonRequest> & { selected_comp_ids?: string[] | null }

interface PythonDecision {
  comp_id: string
  arv_status: string
  rejection_reasons: string[]
  limitations: string[]
  match_percent?: string | null
  matched_rule_count?: number
  total_rule_count?: number
  mismatch_reasons?: string[]
  selection_reason?: string
  priority_rank?: number | null
  ranking_details?: string[]
  arv_cohort?: string
  arv_weight?: string | null
  condition_classification?: 'A' | 'B' | 'excluded' | null
  rule_outcomes: Array<{ rule_id: string; kind: string; passed: boolean; reason: string }>
}
export interface PythonResult {
  methodology_version: string
  status: string
  settings_snapshot_id: string
  settings_content_hash: string
  decisions: PythonDecision[]
  ledger: Array<{ stage: string; target_id: string; rule_id: string; signed_amount: string; evidence: string }>
  errors: Array<{ code: string; message: string }>
  incomplete_sections: string[]
  arv: null | { final_arv: string | null; displayed_arv?: string | null; average_adjusted_ppsf: string | null; accepted_comp_ids: string[]; limitations: string[]; selection_policy?: string; qualified_comp_count?: number; upper_half_cutoff_price?: string | null; comp_weights?: Record<string, string> }
  renovation: null | { total_rehab: string | null; base_rehab: string | null; renovation_level: string; limitations: string[] }
  deal: null | { investor_purchase_ceiling_exact: string | null; displayed_buy_price?: string | null; seller_contract_ceiling_exact: string | null; closing_costs: string | null; carrying_costs: string | null; flip_profit: string | null; displayed_mao: string | null }
  investor: null | { status: string; method_label: string; selected_count: number; eligible_count: number; selected_comp_ids: string[]; subject_investor_value: string | null; limitations: string[] }
}

function decimal(value: unknown, field: string): number {
  if (typeof value !== 'string' || !/^-?\d+(\.\d+)?$/.test(value) || !Number.isFinite(Number(value))) {
    throw new Error(`Python V4 returned no valid ${field}; no legacy fallback was used`)
  }
  return Number(value)
}

function presentation(property: NormalizedProperty | NormalizedComparable) {
  return {
    id: property.id, latitude: property.latitude, longitude: property.longitude,
    bedrooms: property.bedrooms, bathrooms: property.bathrooms,
    bedsBaths: `${property.bedrooms ?? '-'}/${property.bathrooms ?? '-'}`,
    squareFeet: property.squareFeet, lotSizeAcres: property.lotSizeAcres,
    yearBuilt: property.yearBuilt, subdivision: property.subdivision ?? null,
    foundationType: property.construction?.foundationType ?? null,
    buildingStyle: property.construction?.buildingStyle ?? null,
    storiesType: property.construction?.storiesType ?? null,
    pool: property.features?.poolType ?? null, garage: property.features?.garageType ?? null,
    garageSquareFeet: property.features?.garageSquareFeet ?? null,
    carport: property.features?.carportType ?? null, photos: [], zillowUrl: null,
    classification: null,
  }
}

export function mapPythonResponse(params: EvaluationParams, result: PythonResult, frozenRequest?: PythonRequest) {
  const insufficient = result.status === 'INSUFFICIENT_COMPS'
  if ((!result.arv?.final_arv || !result.renovation || !result.deal) && !insufficient) {
    const reasons = result.decisions.flatMap(d => d.rejection_reasons).filter(Boolean)
    throw Object.assign(new Error(`Python V4: ${result.status}. ${result.arv?.limitations?.join('; ') || result.errors.map(e => e.message).join('; ')} ${[...new Set(reasons)].slice(0, 5).join('; ')}. No legacy fallback was used.`), { code: result.status, pythonEvaluation: result })
  }
  const p = params.bundle.property
  const arv = insufficient ? 0 : decimal(result.arv!.final_arv, 'ARV')
  const rehab = insufficient ? 0 : decimal(result.renovation!.total_rehab, 'rehab')
  const buy = insufficient ? 0 : decimal(result.deal!.investor_purchase_ceiling_exact, 'investor ceiling')
  const wholesale = insufficient ? 0 : decimal(result.deal!.seller_contract_ceiling_exact, 'seller ceiling')
  const closing = insufficient ? 0 : decimal(result.deal!.closing_costs, 'closing costs')
  const carrying = insufficient ? 0 : decimal(result.deal!.carrying_costs, 'carrying costs')
  const profit = insufficient ? 0 : decimal(result.deal!.flip_profit, 'profit')
  const investment = buy + rehab
  const accepted = new Set(result.arv?.accepted_comp_ids ?? [])
  const investor = result.investor
  const investorIds = new Set(investor?.status === 'COHORT_FOUND' ? investor.selected_comp_ids : [])
  const investorValue = investor?.status === 'COHORT_FOUND' && investor.subject_investor_value != null ? decimal(investor.subject_investor_value, 'investor value') : null
  const decisions = new Map(result.decisions.map(d => [d.comp_id, d]))
  const request: PythonRequest = frozenRequest ?? buildPythonRequest(params)
  const evidence = new Map(request.comps.map(c => [c.comp_id, c]))
  const items = params.bundle.comparables.map<AnalysisResponse['comps']['items'][number]>(c => {
    const decision = decisions.get(c.id)
    const source = evidence.get(c.id)
    const price = source?.verified_sale_price == null ? null : decimal(source.verified_sale_price, 'sale price')
    const entries = result.ledger.filter(e => e.stage === 'comp' && e.target_id === c.id)
    const adjustment = entries.reduce((sum, e) => sum + decimal(e.signed_amount, 'adjustment'), 0)
    return {
      ...presentation(c), address: `${c.address}, ${c.city}, ${c.state}`,
      salePrice: price, saleDate: source?.sale_date ?? null, distanceMiles: c.distanceMiles,
      pricePerSqft: price != null && c.squareFeet ? price / c.squareFeet : null,
      adjustedPrice: price == null ? null : price + adjustment,
      isEnabled: accepted.has(c.id), compGroup: accepted.has(c.id) ? 'arv' : investorIds.has(c.id) ? 'as_is' : null,
      arvWeight: decision?.arv_weight == null ? null : decimal(decision.arv_weight, 'ARV weight'),
      arvCohort: decision?.arv_cohort ?? null,
      conditionClassification: decision?.condition_classification ?? null,
      matchPercent: decision?.match_percent == null ? null : decimal(decision.match_percent, 'rule match percentage'),
      matchRuleCount: decision?.matched_rule_count ?? 0,
      matchRuleTotal: decision?.total_rule_count ?? 0,
      matchReasons: decision?.mismatch_reasons ?? [],
      selectionReason: decision?.selection_reason ?? '',
      priorityRank: decision?.priority_rank ?? null,
      rankingDetails: [...(decision?.ranking_details ?? []),
        ...(decision?.arv_weight != null ? [`ARV contribution: ${Math.round(decimal(decision.arv_weight, 'ARV weight') * 100)}% (rule match and sale recency)`] : []),
        ...(decision?.arv_cohort === 'lower_half' ? ['Lower-price half: excluded from automatic ARV'] : [])],
      disableReasons: accepted.has(c.id) ? [] : decision?.rejection_reasons.length ? decision.rejection_reasons : ['Not selected by Python V4'],
      appraisalRules: {
        passedFilters: (decision?.total_rule_count ?? 0) > 0 && decision?.matched_rule_count === decision?.total_rule_count, totalAdjustment: adjustment,
        filters: decision?.rule_outcomes.map(r => ({ type: r.kind || r.rule_id, passed: r.passed, reason: r.reason })) ?? [],
        adjustments: entries.map(e => ({ type: e.rule_id, applied: true, amount: decimal(e.signed_amount, 'adjustment'), reason: e.evidence })),
      },
    }
  }).sort((a, b) => Number(b.isEnabled) - Number(a.isEnabled) || (a.priorityRank ?? Infinity) - (b.priorityRank ?? Infinity))
  const { enrichment } = params.bundle
  return {
    evaluationEngine: 'python-v4' as const, pythonEvaluation: result, pythonSettings: request.settings,
    pythonRequest: request, evaluationRevision: 0, manualCompSelection: request.selected_comp_ids ?? null,
    subject: {
      ...presentation(p), address: `${p.address}, ${p.city}, ${p.state} ${p.zipCode}`,
      county: p.county ?? null, propertyType: p.propertyType, hoaFee: p.hoaFee ?? null,
      lastSale: p.lastSalePrice ? { price: p.lastSalePrice, date: p.lastSaleDate, pricePerSqft: p.pricePerSqft ?? null } : null,
      taxAssessment: p.assessedValue ?? null,
      permits: enrichment.permits ? {
        status: enrichment.permits.items.length ? 'available' : 'empty',
        items: enrichment.permits.items.map(({ raw, ...permit }) => permit),
      } : { status: 'unavailable', items: [] },
    },
    valuation: insufficient ? null : {
      displayedArv: result.arv!.displayed_arv == null ? undefined : decimal(result.arv!.displayed_arv, 'displayed ARV'),
      displayedBuyPrice: result.deal!.displayed_buy_price == null ? undefined : decimal(result.deal!.displayed_buy_price, 'displayed buy price'),
      displayedWholesalePrice: result.deal!.displayed_mao == null ? undefined : decimal(result.deal!.displayed_mao, 'displayed wholesale price'),
      displayRounding: { increment: request.settings.deal.rounding_increment === '500' ? 500 : 1000, mode: 'half_up' },
      arv, arvSource: 'appraisal' as const, arvMethodology: ['upper_half_rule_weighted_v1', 'provider_authoritative_upper_half_v2'].includes(result.arv!.selection_policy ?? '')
        ? `Python V4 experimental: ${request.selected_comp_ids != null ? 'operator-selected references' : 'upper half of qualifying recorded sale prices, including cutoff ties'}; rule-match and recency-weighted adjusted price per square foot; ${result.status}; snapshot ${result.settings_snapshot_id}`
        : request.selected_comp_ids != null
        ? `Python V4: operator-selected comparables; arithmetic mean of adjusted price per square foot; ${result.status}; snapshot ${result.settings_snapshot_id}`
        : `Python V4: ${result.status}; best reference by subdivision, year built, square footage, lot size, then physical style; snapshot ${result.settings_snapshot_id}`,
      investorAnalysis: investor ? { status: investor.status, methodLabel: investor.method_label, sampleCount: investor.selected_count, eligibleCount: investor.eligible_count, value: investorValue, limitations: investor.limitations } : undefined,
      arvPerSqft: p.squareFeet ? arv / p.squareFeet : 0,
      asIsValue: investorValue, afterRenovationValue: null, spread: null, spreadAnalysis: null, asIsMarketIntel: null,
      buyPrice: buy, buyPricePercent: arv ? buy / arv * 100 : 0,
      rehabCost: rehab, rehabLevel: result.renovation!.renovation_level,
      rehabPerSqft: p.squareFeet ? decimal(result.renovation!.base_rehab, 'base rehab') / p.squareFeet : 0,
      rehabLevelEstimates: [], closingCosts: closing, carryingCosts: carrying, totalCosts: closing + carrying,
      totalInvestment: investment, projectedProfit: profit, projectedROI: investment ? profit / investment * 100 : 0,
      wholesalePrice: wholesale,
    },
    comps: { total: items.length, enabledCount: accepted.size, disabledCount: items.length - accepted.size,
      avgPricePerSqft: insufficient ? null : decimal(result.arv!.average_adjusted_ppsf, 'adjusted PPSF'), medianPrice: null,
      asIsCompIds: [...investorIds], afterRenovationCompIds: [], items },
    riskFlags: [`Python V4 local test: ${result.status}`, 'V4 canonical settings adapter; saved legacy settings are unchanged',
      ...(enrichment.evidenceLimitations ?? []),
      'Comparable flood-zone and hazard evidence has not been retrieved; hazard matching is unavailable',
      ...(enrichment.permits?.count ? ['Permit records are available, but verified system-age mapping is not yet connected to Python'] : []),
      ...(result.arv?.limitations ?? []), ...(result.renovation?.limitations ?? []),
      ...(insufficient ? ['No usable ARV reference remains after the approved search stages. No valuation or buy price was calculated.'] : []),
      ...(result.incomplete_sections.length ? [`Incomplete sections: ${result.incomplete_sections.join(', ')}`] : []),
      'Investor cohort is an engineering proposal; initial offer is not defined'],
    permits: enrichment.permits ? { count: enrichment.permits.count, totalValue: enrichment.permits.totalJobValue ?? null, recentTypes: enrichment.permits.recentPermitTypes ?? [], items: enrichment.permits.items.map(({ raw, ...permit }) => permit) } : null,
    floodZone: enrichment.floodZone ? { zone: enrichment.floodZone.floodZone, inFloodZone: enrichment.floodZone.isInFloodZone, description: enrichment.floodZone.floodZoneDescription } : null,
    neighbourhood: null, dataSupplemented: { hasSupplementedData: false, remarks: [], subject: [], comps: {} },
    meta: { analysisId: params.jobId, timestamp: new Date().toISOString(), dataProvider: p.provider },
    visionAnalysis: null, apiCallStats: params.apiCallStats ?? null,
  }
}

export async function evaluateConfigured(params: EvaluationParams, env: Env): Promise<{ response: AnalysisResponse }> {
  if (!env.EVALUATION_ENGINE || env.EVALUATION_ENGINE === 'legacy') return performAnalysis(params)
  const initial = await evaluatePythonRequest(buildPythonRequest(params), env, params)
  const refreshIds = new Set(initial.decisions.filter(d => d.rule_outcomes.every(rule =>
    rule.passed || !['subdivision_match', 'max_sqft_diff', 'max_distance_miles'].includes(rule.kind)
  )).filter(d => {
    const comp = params.bundle.comparables.find(c => c.id === d.comp_id)
    return comp?.yearBuilt != null && params.bundle.property.yearBuilt != null && Math.abs(comp.yearBuilt - params.bundle.property.yearBuilt) <= 15
  }).map(d => d.comp_id))
  const refreshed = await refreshZillowEvidence(env, params.bundle.property, params.bundle.comparables.filter(c => refreshIds.has(c.id)))
  const resolved = new Map(refreshed.comps.map(c => [c.id, c]))
  const audits = new Map(refreshed.compEvidence.map(e => [e.propertyId, e]))
  let visionCalls = 0
  const imagesFor = (audit: typeof refreshed.subjectEvidence): ConditionImage[] => [
    ...[...new Set([...(audit.frontPhoto && audit.photos.includes(audit.frontPhoto) ? [audit.frontPhoto] : []), ...audit.photos])].map(url => ({ url, kind: 'photo' as const })),
    ...(audit.screenshots ?? []).map(s => ({ url: s.url, kind: 'screenshot' as const })),
  ]
  const record = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
  const property = refreshed.subject
  const comparables = params.bundle.comparables.map(original => resolved.get(original.id) ?? original)
  const resolvedParams = { ...params, bundle: { ...params.bundle, property, comparables } }
  const provisional = await evaluatePythonRequest(buildPythonRequest(resolvedParams), env, params)
  const reportAssets = [] as Awaited<ReturnType<typeof persistReportAssets>>['assets']
  const assetErrors: string[] = []
  let assetBudget = 20
  let assetCalls = 0
  const assetDeadline = Date.now() + 30000
  const selectedIds = new Set(provisional.arv?.accepted_comp_ids ?? [])
  const assetAudits = [refreshed.subjectEvidence, ...[...refreshed.compEvidence].sort((a, b) => Number(selectedIds.has(b.propertyId)) - Number(selectedIds.has(a.propertyId)))]
  for (const audit of assetAudits) {
    if (Date.now() >= assetDeadline) { assetErrors.push('Report photo capture time budget exhausted'); break }
    const sources = imagesFor(audit).slice(0, Math.min(4, assetBudget)).map(image => {
      const provenance = image.kind === 'photo' ? audit.photoEvidence?.find(photo => photo.url === image.url) : audit.screenshots?.find(shot => shot.url === image.url)
      return { ...image, source: provenance?.source ?? audit.source, sourcePageUrl: provenance?.sourceUrl ?? audit.sourceUrl,
        capturedAt: provenance && 'retrievedAt' in provenance ? String(provenance.retrievedAt) : audit.retrievedAt }
    })
    assetBudget -= sources.length
    if (!sources.length) continue
    const stored = await persistReportAssets(env, params.jobId, audit.propertyId, sources, { fetcher: async (input, init) => {
      if (Date.now() >= assetDeadline) throw new Error('Asset capture time budget exhausted')
      assetCalls++
      return fetch(input, { ...init, signal: AbortSignal.timeout(Math.max(1, Math.min(10000, assetDeadline - Date.now()))) })
    } })
    reportAssets.push(...stored.assets)
    assetErrors.push(...stored.errors)
  }
  const storedImages = new Map<string, ConditionImage[]>()
  let visionBytes = 0
  for (const asset of reportAssets) {
    if (visionBytes + asset.bytes > 10 * 1024 * 1024) { assetErrors.push('Condition image byte budget exhausted; remaining images stay in the report'); continue }
    try {
      const stored = await env.REPORT_ASSETS?.get(assetKey(params.jobId, asset.id))
      if (!stored) continue
      const bytes = new Uint8Array(await stored.arrayBuffer())
      visionBytes += bytes.length
      let binary = ''
      for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192))
      const images = storedImages.get(asset.propertyId) ?? []
      images.push({ url: asset.sourceUrl, kind: asset.kind, base64: btoa(binary), mimeType: asset.contentType })
      storedImages.set(asset.propertyId, images)
    } catch { assetErrors.push(`${asset.propertyId}: Stored image unavailable for condition observation`) }
  }
  const conditionObservations = await observeConditions(env, assetAudits.map(audit => ({
    id: audit.propertyId, images: storedImages.get(audit.propertyId) ?? [], saleDate: audit.resolvedSale.date,
  })), () => { visionCalls++ })
  const finalParams = { ...resolvedParams, bundle: { ...resolvedParams.bundle, comparables: comparables.map(comp => ({
    ...comp, raw: { ...record(comp.raw), ...(conditionObservations[comp.id] ? { conditionEvidence: conditionObservations[comp.id].condition } : {}) },
  })) } }
  const request = buildPythonRequest(finalParams)
  const result = await evaluatePythonRequest(request, env, params)
  const evidenceRefresh = { subject: refreshed.subjectEvidence, comps: refreshed.compEvidence, providerCalls: refreshed.providerCalls, visionCalls }
  const mapped = mapPythonResponse(finalParams, result, request)
  const assetPhotos = (id: string) => reportAssets.filter(asset => asset.propertyId === id && asset.kind === 'photo').map(asset => asset.url)
  const response = { ...mapped,
    apiCallStats: { ...(params.apiCallStats ?? { corelogic: { total: 0, cached: 0, endpoints: [] } }),
      firecrawl: { calls: refreshed.providerCalls }, vision: { calls: visionCalls },
      reportAssets: { calls: assetCalls },
      totalExternalCalls: (params.apiCallStats?.totalExternalCalls ?? 0) + refreshed.providerCalls + visionCalls + assetCalls },
    evidenceRefresh,
    conditionObservations, reportAssets,
    providerPoolAudit: params.bundle.comparables.flatMap(comp => {
      const raw = record(comp.raw)
      return raw.retrievalVariants ? [{ propertyId: comp.id, variants: raw.retrievalVariants,
        priceQuarantined: raw.retrievalConflict === true, physicalConflicts: raw.retrievalPhysicalConflicts ?? [] }] : []
    }),
    retrievalCoverage: { requested: params.bundle.metadata.comparablesParams, returnedCount: params.bundle.comparables.length, limitation: 'Evaluation covers the returned provider pool, not every sale in the market.' },
    subject: { ...mapped.subject, photos: assetPhotos(property.id), zillowUrl: refreshed.subjectEvidence.source === 'zillow' ? refreshed.subjectEvidence.sourceUrl : null,
      listingSourceUrl: refreshed.subjectEvidence.sourceUrl,
      frontPhoto: reportAssets.find(asset => asset.propertyId === property.id && asset.sourceUrl === refreshed.subjectEvidence.frontPhoto)?.url ?? null },
    comps: { ...mapped.comps, items: mapped.comps.items.map(comp => ({ ...comp,
      photos: assetPhotos(comp.id), zillowUrl: audits.get(comp.id)?.source === 'zillow' ? audits.get(comp.id)?.sourceUrl ?? null : null,
      listingSourceUrl: audits.get(comp.id)?.sourceUrl ?? null,
      frontPhoto: reportAssets.find(asset => asset.propertyId === comp.id && asset.sourceUrl === audits.get(comp.id)?.frontPhoto)?.url ?? null })) },
    riskFlags: [...mapped.riskFlags, ...[refreshed.subjectEvidence, ...refreshed.compEvidence]
      .filter(e => ['conflict', 'unavailable', 'identity_mismatch'].includes(e.status)).map(e => `${e.propertyId}: Listing evidence ${e.status}; ${e.reason}`),
      ...[refreshed.subjectEvidence, ...refreshed.compEvidence].filter(e => e.status === 'updated' && e.originalSale.price && e.resolvedSale.price &&
        (e.resolvedSale.price < e.originalSale.price / 3 || e.resolvedSale.price > e.originalSale.price * 3))
        .map(e => `${e.propertyId}: Listing sale changed by more than a factor of three; verify transaction scope before treating it as market value`),
      ...assetErrors,
      ...params.bundle.comparables.filter(comp => Array.isArray(record(comp.raw).retrievalPhysicalConflicts)).map(comp => `${comp.id}: Provider pools disagree on some characteristics; current provider-detail values were retained where available`),
      ...Object.entries(conditionObservations).filter(([, e]) => !e.condition.sale_relevant).map(([id, e]) => `${id}: Condition evidence is not tied to the sale; ${e.condition.reason}`)],
    pythonRequestSignature: await signConfiguredPythonSnapshot(params.jobId, request, env),
  }
  return { response: response as AnalysisResponse }
}

export async function evaluatePythonRequest(request: PythonRequest, env: Env, context?: PythonExecutionContext): Promise<PythonResult> {
  if (env.EVALUATION_ENGINE !== 'python-v4') throw new Error('Unknown evaluation engine')
  if (env.ENVIRONMENT === 'staging') return evaluateHostedPython(request, env, context)
  if (env.ENVIRONMENT !== 'development') throw new Error('Python V4 bridge is restricted to local development')
  const url = new URL(env.V4_LOCAL_BRIDGE_URL || 'http://127.0.0.1:8788')
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || url.username || url.password) throw new Error('Python V4 bridge must use loopback HTTP')
  if (!env.V4_LOCAL_BRIDGE_TOKEN || env.V4_LOCAL_BRIDGE_TOKEN.length < 32) throw new Error('Python V4 bridge token is not configured')
  const response = await fetch(new URL('/evaluate', url), {
    method: 'POST', headers: { Authorization: `Bearer ${env.V4_LOCAL_BRIDGE_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(request), signal: AbortSignal.timeout(20000), redirect: 'manual',
  })
  if (!response.ok) {
    const error = await response.json().catch(() => null) as { detail?: { fields?: Array<{ path: string; message: string }> } } | null
    const fields = error?.detail?.fields?.map(field => `${field.path}: ${field.message}`).join('; ')
    throw new Error(`Python V4 bridge rejected evaluation: HTTP ${response.status}${fields ? ` (${fields})` : ''}; no legacy fallback was used`)
  }
  const body = await response.json() as { engine: string; result: PythonResult }
  if (body.engine !== 'python-v4' || body.result?.methodology_version !== 'evaluation-v4' || !Array.isArray(body.result.decisions)) throw new Error('Invalid Python V4 response')
  return body.result
}

type SavedPythonReport = ReturnType<typeof mapPythonResponse> & { pythonRequestSignature?: string }

export async function recalculatePythonReport(saved: SavedPythonReport, jobId: string, selectedCompIds: string[] | null, env: Env, userId?: string) {
  if (saved.evaluationEngine !== 'python-v4' || !saved.pythonRequest || !saved.pythonRequestSignature ||
      !await verifyConfiguredPythonSnapshot(jobId, saved.pythonRequest, saved.pythonRequestSignature, env)) {
    throw Object.assign(new Error('This report has no verified recalculation snapshot. Run New Analysis first.'), { status: 409 })
  }
  const request: PythonRequest = { ...saved.pythonRequest, selected_comp_ids: selectedCompIds }
  if (selectedCompIds !== null) {
    const eligible = new Set(saved.pythonEvaluation.decisions.filter(d => d.priority_rank != null).map(d => d.comp_id))
    if (selectedCompIds.some(id => !eligible.has(id))) throw Object.assign(new Error('One or more comparables lack valid sale evidence and cannot be added.'), { status: 422 })
  }
  const result = await evaluatePythonRequest(request, env, { jobId, userId })
  const params = {
    jobId,
    bundle: {
      property: { ...saved.subject, provider: saved.meta.dataProvider, city: request.subject.city, state: request.subject.state, zipCode: request.subject.zip },
      comparables: saved.comps.items.map(comp => ({ ...comp,
        construction: { buildingStyle: comp.buildingStyle, foundationType: comp.foundationType, storiesType: comp.storiesType },
        features: { poolType: comp.pool, garageType: comp.garage, garageSquareFeet: comp.garageSquareFeet, carportType: comp.carport },
      })),
      metadata: { fetchedAt: `${request.evaluation_date}T00:00:00Z` },
      enrichment: { permits: null, floodZone: null },
    },
  } as unknown as EvaluationParams
  const mapped = mapPythonResponse(params, result, request)
  const prior = new Map(saved.comps.items.map(comp => [comp.id, comp]))
  return {
    ...saved,
    ...mapped,
    subject: saved.subject, permits: saved.permits, floodZone: saved.floodZone,
    neighbourhood: saved.neighbourhood, dataSupplemented: saved.dataSupplemented,
    visionAnalysis: saved.visionAnalysis, apiCallStats: saved.apiCallStats,
    valuation: mapped.valuation ? { ...saved.valuation, ...mapped.valuation } : null,
    comps: { ...mapped.comps, items: mapped.comps.items.map(comp => ({ ...prior.get(comp.id), ...comp,
      address: prior.get(comp.id)?.address ?? comp.address, photos: prior.get(comp.id)?.photos ?? [],
      zillowUrl: prior.get(comp.id)?.zillowUrl ?? null })) },
    riskFlags: [...new Set([...mapped.riskFlags, ...saved.riskFlags.filter(flag => /permit|flood|hazard|zillow|listing|condition|asset|visual/i.test(flag))])],
    evaluationRevision: (saved.evaluationRevision ?? 0) + 1,
    pythonRequestSignature: await signConfiguredPythonSnapshot(jobId, request, env),
  }
}
