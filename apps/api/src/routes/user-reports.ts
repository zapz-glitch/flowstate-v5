/**
 * User Reports Routes (Session Auth)
 *
 * Authenticated endpoints for listing and viewing saved analysis reports.
 * Uses session auth via Better Auth cookies.
 */

import { Hono } from 'hono'
import { drizzle } from 'drizzle-orm/d1'
import { eq, desc, sql, like, or, and } from 'drizzle-orm'
import type { Env } from '../types'
import { getSession } from '../lib/session'
import { savedReports, reportHistory, analysisRuns } from '../db/schema'
import { hashSharePassword } from '../lib/share-token'
import { bodyLimit } from 'hono/body-limit'
import { recalculateReport } from '../services/evaluation/recalculate'
import { deleteReportAssets } from '../services/report-assets'
import { createPropertyApi } from '../services/property-api'
import { createValuationService } from '../services/valuation'
import { calculateAllRehabLevelEstimates } from '../services/analysis'
import { assessMajorItems, toValuationMajorItems } from '../services/evaluation/major-items'
import { loadMajorItemConfig, computeLocationPenalty } from '../services/evaluation'
import { loadUserAnalysisSettings } from '../services/user-settings'
import type { MajorItem } from '../services/valuation/types'

const userReports = new Hono<{ Bindings: Env }>()

userReports.post('/:jobId/comps', bodyLimit({ maxSize: 20000 }), async (c) => {
  const session = await getSession(c)
  if (!session?.user) return c.json({ error: 'Not authenticated' }, 401)
  const origin = c.req.header('Origin')
  // Browsers always send Origin on POST; a missing Origin means a
  // server-side caller (dashboard server action) — already session-authed.
  if (origin != null && origin !== (c.env.DASHBOARD_URL ? new URL(c.env.DASHBOARD_URL).origin : null)) return c.json({ error: 'Untrusted origin' }, 403)
  if (!c.req.header('Content-Type')?.toLowerCase().startsWith('application/json')) return c.json({ error: 'JSON request required' }, 415)
  const body = await c.req.json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).some(key => !['selectedCompIds', 'expectedRevision'].includes(key)) ||
      !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0 ||
      !(body.selectedCompIds === null || (Array.isArray(body.selectedCompIds) && body.selectedCompIds.length > 0 && body.selectedCompIds.length <= 500 &&
        body.selectedCompIds.every((id: unknown) => typeof id === 'string' && id.length > 0 && id.length <= 128) && new Set(body.selectedCompIds).size === body.selectedCompIds.length))) {
    return c.json({ error: 'Provide at least one unique comparable ID (or null to reset) and the current revision' }, 400)
  }
  const jobId = c.req.param('jobId')
  const db = drizzle(c.env.DB)
  const [report] = await db.select().from(savedReports)
    .where(and(eq(savedReports.jobId, jobId), eq(savedReports.userId, session.user.id))).limit(1)
  if (!report) return c.json({ error: 'Report not found' }, 404)
  let saved
  try { saved = JSON.parse(report.fullResponseJson ?? '{}') } catch { return c.json({ error: 'Report data is corrupted' }, 409) }
  if ((saved.evaluationRevision ?? 0) !== body.expectedRevision) return c.json({ error: 'This report changed. Reload it before editing comparables.' }, 409)
  let analysis
  try {
    analysis = await recalculateReport(saved, jobId, body.selectedCompIds, c.env, session.user.id)
  } catch (error) {
    if ((error as { status?: number }).status === 409) return c.json({ error: (error as Error).message }, 409)
    if ((error as { status?: number }).status === 422) return c.json({ error: (error as Error).message }, 422)
    return c.json({ error: 'Could not recalculate this selection. The saved report was not changed.' }, 502)
  }
  const nextJson = JSON.stringify(analysis)
  const changes = JSON.stringify({ actor: session.user.id, before: saved, after: analysis })
  const description = body.selectedCompIds === null ? 'Restored automatic comparable selection' : `Recalculated ${body.selectedCompIds.length} operator-selected comparables`
  const results = await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO report_history (id, report_id, user_id, action, description, changes_json, created_at) SELECT ?, id, user_id, ?, ?, ?, ? FROM saved_reports WHERE id = ? AND user_id = ? AND full_response_json = ?')
      .bind(crypto.randomUUID(), 'comp_selection', description, changes, new Date().toISOString(), report.id, session.user.id, report.fullResponseJson),
    c.env.DB.prepare('UPDATE saved_reports SET full_response_json = ?, valuation_data = ?, comparables_data = ?, arv = ?, as_is_value = ?, max_allowable_offer = ?, estimated_repairs = ? WHERE id = ? AND user_id = ? AND full_response_json = ?')
      .bind(nextJson, JSON.stringify(analysis.valuation), JSON.stringify(analysis.comps), analysis.valuation?.arv ?? null, analysis.valuation?.asIsValue ?? null, analysis.valuation?.buyPrice ?? null, analysis.valuation?.rehabCost ?? null, report.id, session.user.id, report.fullResponseJson),
  ])
  if (results[1].meta.changes !== 1) return c.json({ error: 'This report changed. Reload it before editing comparables.' }, 409)
  return c.json({ analysis })
})

// ─── POST /user/reports/:jobId/permits ────────────────────────────────────────
// On-demand permit pull. Permits are no longer fetched during analysis (a paid
// provider call per report); this route pulls them for the subject, re-derives
// the permit-age major items, and re-runs valuation so the buy price reflects
// real permit evidence instead of the no-permit assumptions.
userReports.post('/:jobId/permits', async (c) => {
  const session = await getSession(c)
  if (!session?.user) return c.json({ error: 'Not authenticated' }, 401)
  const origin = c.req.header('Origin')
  if (origin != null && origin !== (c.env.DASHBOARD_URL ? new URL(c.env.DASHBOARD_URL).origin : null)) return c.json({ error: 'Untrusted origin' }, 403)

  const jobId = c.req.param('jobId')
  const db = drizzle(c.env.DB)
  const [report] = await db.select().from(savedReports)
    .where(and(eq(savedReports.jobId, jobId), eq(savedReports.userId, session.user.id))).limit(1)
  if (!report) return c.json({ error: 'Report not found' }, 404)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let saved: any
  try { saved = JSON.parse(report.fullResponseJson ?? '{}') } catch { return c.json({ error: 'Report data is corrupted' }, 409) }

  const subject = saved.subject
  if (!subject?.id) return c.json({ error: 'Report has no subject property to pull permits for' }, 409)

  const address = typeof subject.address === 'string' ? subject.address : ''
  const comma = address.indexOf(',')
  const propertyApi = createPropertyApi(c.env)
  const permitsResult = await propertyApi.getBuildingPermits(subject.id, {
    address1: comma > 0 ? address.slice(0, comma).trim() : address,
    address2: comma > 0 ? address.slice(comma + 1).trim() : '',
  })
  if (!permitsResult.success || !permitsResult.data) {
    return c.json({ error: ('error' in permitsResult ? permitsResult.error : null) ?? 'Permit lookup failed' }, 502)
  }
  const permits = permitsResult.data.permits ?? []

  // Re-derive major items — caller-specified (manual) items carry over; the
  // permit-age engine re-assesses everything else against real evidence.
  const prevMajor: Array<{ id: MajorItem['id']; enabled: boolean; cost: number; reason?: string }> =
    Array.isArray(saved.appliedSettings?.majorItems) ? saved.appliedSettings.majorItems : []
  const callerItems: MajorItem[] = prevMajor
    .filter((m) => typeof m?.reason === 'string' && m.reason.startsWith('Caller-specified'))
    .map((m) => ({ id: m.id, enabled: m.enabled !== false, cost: m.cost }))
  const majorItemConfig = await loadMajorItemConfig(c.env, session.user.id)
  const assessments = assessMajorItems(permits, majorItemConfig, callerItems, undefined, subject.yearBuilt ?? null)
  const valuationItems = toValuationMajorItems(assessments, callerItems)
  const assessmentById = new Map(assessments.map((a) => [a.id, a]))
  const callerIds = new Set(callerItems.filter((m) => m.enabled).map((m) => m.id))
  const derivedMajorItems = valuationItems.map((m) => ({
    ...m,
    reason: callerIds.has(m.id)
      ? `Caller-specified item${assessmentById.get(m.id)?.deduplicated ? ' (permit rule deduplicated)' : ''}`
      : (assessmentById.get(m.id)?.reason ?? 'Enabled'),
  }))

  // Re-run valuation with the report's applied-settings snapshot — ARV and
  // comp selection are unchanged; only major-item cost evidence moves.
  const applied = saved.appliedSettings ?? {}
  const subjectSqft = subject.squareFeet ?? 0
  const arvItems = (saved.comps?.items ?? []).filter(
    (item: { compGroup?: string; squareFeet?: number | null }) => item?.compGroup === 'arv' && (item?.squareFeet ?? 0) > 0
  )
  const compAvgSqft = arvItems.length
    ? arvItems.reduce((s: number, item: { squareFeet: number }) => s + item.squareFeet, 0) / arvItems.length
    : subjectSqft
  // The proximity deduction isn't serialized into the response — rebuild it
  // from the saved locationRisks with the user's proximity config, resolved
  // against the subject's address the same way the original analysis did.
  const addrParts = address.split(',').map((s: string) => s.trim())
  const stateZip = (addrParts[2] ?? '').split(/\s+/)
  const userSettings = await loadUserAnalysisSettings(c.env.DB, {
    userId: session.user.id,
    address: { city: addrParts[1], state: stateZip[0], zipCode: stateZip[1] },
  }, c.env.API_CACHE)
  const locationPenaltyAmount = computeLocationPenalty(
    Array.isArray(saved.locationRisks) ? saved.locationRisks : null,
    saved.valuation?.arv ?? 0,
    userSettings.proximityConfig
  )
  const valuationService = createValuationService(applied.rehabTable)
  const valuation = valuationService.calculateValuation({
    arv: saved.valuation?.arv ?? 0,
    subjectSqft,
    compAvgSqft,
    rehabLevelIndex: applied.rehabLevelIndex ?? 2,
    skipBaseRehab: saved.valuation?.rehabLevel === 'Renovated',
    locationPenaltyAmount,
    majorItems: valuationItems,
    additionPlay: applied.additionPlay ?? 0,
    closingCostsPercent: applied.dealParams?.closingCostsPercent ?? 8,
    carryingCostsPercent: applied.dealParams?.carryingCostsPercent ?? 2,
    wholesaleFee: applied.dealParams?.wholesaleFee ?? 10000,
  })
  const rehabLevelEstimates = calculateAllRehabLevelEstimates(valuationService, {
    arv: saved.valuation?.arv ?? 0,
    subjectSqft,
    compAvgSqft,
    selectedRehabLevelIndex: applied.rehabLevelIndex ?? 2,
    majorItems: valuationItems,
    additionPlay: applied.additionPlay ?? 0,
    closingCostsPercent: applied.dealParams?.closingCostsPercent ?? 8,
    carryingCostsPercent: applied.dealParams?.carryingCostsPercent ?? 2,
    wholesaleFee: applied.dealParams?.wholesaleFee ?? 10000,
  })

  const conf = saved.report?.confidence
  const recommendationReason = conf === 'low'
    ? `${valuation.recommendationReason ?? ''} — LOW confidence: comp evidence is thin or stale`.trim()
    : conf === 'medium'
      ? `${valuation.recommendationReason ?? ''} — medium confidence: some dimensions unverified`.trim()
      : valuation.recommendationReason

  // Rebuild the report's rehab ledger + deductions so the audit trail shows
  // the new permit evidence, not the old no-permit assumptions.
  const prevLedger: Array<Record<string, unknown>> = saved.report?.rehab?.ledger ?? []
  const ledger = [
    ...prevLedger.filter((l) => l.source === 'rehab_tier'),
    ...derivedMajorItems.filter((m) => m.enabled).map((m) => ({
      label: m.id,
      amount: m.cost,
      source: callerIds.has(m.id) ? 'major_item_manual' : 'major_item_permit',
      reason: m.reason,
      deduplicated: assessmentById.get(m.id)?.deduplicated ?? false,
      evidenceStatus: assessmentById.get(m.id)?.evidenceStatus,
    })),
    ...assessments.filter((a) => !a.enabled && a.deduplicated).map((a) => ({
      label: a.id,
      amount: 0,
      source: 'major_item_permit',
      reason: a.reason,
      deduplicated: true,
      evidenceStatus: a.evidenceStatus,
    })),
    ...prevLedger.filter((l) => l.source === 'addition'),
  ]
  const prevDeductions: Array<{ label: string; reason?: string }> = saved.report?.deductions ?? []
  const baseReason = prevDeductions.find((d) => d.label === 'Base Rehab')?.reason
    ?? `${valuation.rehabLevel} at $${valuation.rehabPerSqft}/sqft`
  const additionPlay = applied.additionPlay ?? 0
  const deductions = [
    { label: 'Base Rehab', amount: -valuation.baseRehabCost, reason: baseReason },
    ...derivedMajorItems.filter((m) => m.enabled).map((m) => ({ label: m.id, amount: -m.cost, reason: m.reason })),
    ...(additionPlay > 0 ? [{ label: 'Addition Play', amount: -additionPlay, reason: 'Additional improvement budget' }] : []),
    ...(locationPenaltyAmount > 0 ? [{ label: 'Location Penalty', amount: -locationPenaltyAmount, reason: 'Proximity risk deduction (major road/railroad/commercial)' }] : []),
    { label: 'Closing Costs', amount: -valuation.closingCosts, reason: `${valuation.closingCostsPercent}% of ARV — purchase + resale transaction costs` },
    { label: 'Carrying Costs', amount: -valuation.carryingCosts, reason: `${valuation.carryingCostsPercent}% of ARV — holding costs during rehab` },
    { label: 'Minimum Profit', amount: -valuation.desiredProfit, reason: `Required margin for ${valuation.arvTier} price tier` },
  ]

  const analysis = {
    ...saved,
    subject: {
      ...subject,
      permits: {
        status: permits.length > 0 ? 'available' : 'empty',
        error: null,
        items: permits.map((p) => ({
          permitId: p.permitId,
          permitNumber: p.permitNumber ?? null,
          projectType: p.projectType ?? null,
          description: p.description ?? null,
          status: p.status ?? null,
          effectiveDate: p.effectiveDate ?? null,
          jobValue: p.jobValue ?? null,
        })),
      },
    },
    valuation: {
      ...(saved.valuation ?? {}),
      buyPrice: valuation.buyPrice,
      buyPricePercent: valuation.buyPricePercent,
      rehabCost: valuation.totalRehabCost,
      rehabLevel: valuation.rehabLevel,
      rehabPerSqft: valuation.rehabPerSqft,
      baseRehabCost: valuation.baseRehabCost,
      majorItemsCost: valuation.majorItemsCost,
      closingCosts: valuation.closingCosts,
      carryingCosts: valuation.carryingCosts,
      totalCosts: valuation.closingCosts + valuation.carryingCosts,
      totalInvestment: valuation.totalInvestment,
      projectedProfit: valuation.projectedProfit,
      projectedROI: valuation.projectedROI,
      wholesalePrice: valuation.wholesalePrice,
      recommendation: valuation.recommendation,
      recommendationReason,
      rehabLevelEstimates,
      breakdown: valuation.breakdown,
    },
    permits: {
      count: permits.length,
      totalValue: permits.reduce((sum: number, p: { jobValue?: number | null }) => sum + (p.jobValue ?? 0), 0),
      recentTypes: [...new Set(permits.map((p) => p.projectType).filter(Boolean) as string[])].slice(0, 5),
    },
    riskFlags: (() => {
      const flags: string[] = Array.isArray(saved.riskFlags) ? [...saved.riskFlags] : []
      if (permits.some((p) => p.jobValue && p.jobValue > 50000) && !flags.includes('Major Permits (>$50K)')) {
        flags.push('Major Permits (>$50K)')
      }
      return flags.length > 0 ? flags : null
    })(),
    appliedSettings: { ...applied, majorItems: derivedMajorItems },
    evaluationRevision: (saved.evaluationRevision ?? 0) + 1,
    ...(saved.report ? {
      report: {
        ...saved.report,
        rehab: {
          ...(saved.report.rehab ?? {}),
          majorItems: derivedMajorItems.filter((m) => m.enabled).map((m) => ({ name: m.id, cost: m.cost, reason: m.reason })),
          majorItemsCost: valuation.majorItemsCost,
          totalCost: valuation.totalRehabCost,
          ledger,
        },
        deductions,
        outcome: {
          ...(saved.report.outcome ?? {}),
          maxBuyPrice: valuation.buyPrice,
          buyPricePercent: valuation.buyPricePercent,
          wholesalePrice: valuation.wholesalePrice,
          projectedProfit: valuation.projectedProfit,
          projectedROI: valuation.projectedROI,
          totalInvestment: valuation.totalInvestment,
          recommendation: valuation.recommendation,
          recommendationReason,
        },
        // Stale no-permit notes are replaced by the fresh unknown-count note
        confidenceReasons: [
          ...(saved.report.confidenceReasons ?? []).filter((r: string) => !/no permit evidence|permit evidence/i.test(r)),
          ...(() => {
            const unknown = assessments.filter((a) => a.evidenceStatus === 'unknown' && !a.deduplicated && !a.enabled).length
            return unknown > 0 ? [`${unknown} major item(s) have no permit evidence — UNKNOWN (not charged)`] : []
          })(),
        ],
      },
    } : {}),
  }

  const nextJson = JSON.stringify(analysis)
  const changes = JSON.stringify({ actor: session.user.id, before: saved, after: analysis })
  const results = await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO report_history (id, report_id, user_id, action, description, changes_json, created_at) SELECT ?, id, user_id, ?, ?, ?, ? FROM saved_reports WHERE id = ? AND user_id = ? AND full_response_json = ?')
      .bind(crypto.randomUUID(), 'permits_pull', `Pulled ${permits.length} building permit(s); re-derived major items and valuation`, changes, new Date().toISOString(), report.id, session.user.id, report.fullResponseJson),
    c.env.DB.prepare('UPDATE saved_reports SET full_response_json = ?, valuation_data = ?, arv = ?, max_allowable_offer = ?, estimated_repairs = ? WHERE id = ? AND user_id = ? AND full_response_json = ?')
      .bind(nextJson, JSON.stringify(analysis.valuation), analysis.valuation?.arv ?? null, analysis.valuation?.buyPrice ?? null, analysis.valuation?.rehabCost ?? null, report.id, session.user.id, report.fullResponseJson),
  ])
  if (results[1].meta.changes !== 1) return c.json({ error: 'This report changed. Reload it and try again.' }, 409)
  return c.json({ analysis })
})

// ─── GET /user/reports ────────────────────────────────────────────────────────

userReports.get('/', async (c) => {
  const session = await getSession(c)
  if (!session?.user) return c.json({ error: 'Not authenticated' }, 401)

  const page = Math.max(1, parseInt(c.req.query('page') || '1', 10))
  const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') || '20', 10)))
  const offset = (page - 1) * limit
  const search = c.req.query('search')?.trim() || ''

  const db = drizzle(c.env.DB)

  // Build where clause with optional search filter
  const baseCondition = eq(savedReports.userId, session.user.id)
  const whereCondition = search
    ? and(
        baseCondition,
        or(
          like(savedReports.propertyAddress, `%${search}%`),
          like(savedReports.propertyCity, `%${search}%`),
          like(savedReports.propertyState, `%${search}%`)
        )
      )
    : baseCondition

  // One report per property — collapse legacy duplicate rows to the newest.
  const latestPerProperty = sql`${savedReports.id} IN (
    SELECT id FROM (
      SELECT id, MAX(created_at) AS mx FROM saved_reports
      WHERE user_id = ${session.user.id}
      GROUP BY property_address
    ) latest WHERE saved_reports.id = latest.id
  )`
  const dedupedCondition = and(whereCondition, latestPerProperty)

  const [reports, countResult] = await Promise.all([
    db
      .select({
        id: savedReports.id,
        jobId: savedReports.jobId,
        propertyAddress: savedReports.propertyAddress,
        propertyCity: savedReports.propertyCity,
        propertyState: savedReports.propertyState,
        arv: savedReports.arv,
        maxAllowableOffer: savedReports.maxAllowableOffer,
        estimatedRepairs: savedReports.estimatedRepairs,
        isShared: savedReports.isShared,
        createdAt: savedReports.createdAt,
      })
      .from(savedReports)
      .where(dedupedCondition)
      .orderBy(desc(savedReports.createdAt))
      .limit(limit)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)` })
      .from(savedReports)
      .where(dedupedCondition)
      .then((r) => r[0]),
  ])

  const total = countResult?.count ?? 0
  const totalPages = Math.ceil(total / limit)

  return c.json({
    reports,
    pagination: { page, limit, total, totalPages },
  })
})

// ─── GET /user/reports/by-property ───────────────────────────────────────────

userReports.get('/by-property', async (c) => {
  const session = await getSession(c)
  if (!session?.user) return c.json({ error: 'Not authenticated' }, 401)

  const clip = c.req.query('clip')?.trim()
  const address = c.req.query('address')?.trim()
  if (!clip && !address) return c.json({ error: 'clip or address query parameter required' }, 400)

  const db = drizzle(c.env.DB)

  // Prefer CLIP match (exact), fall back to address (fuzzy)
  const condition = clip
    ? and(eq(savedReports.userId, session.user.id), eq(savedReports.propertyClip, clip))
    : and(eq(savedReports.userId, session.user.id), like(savedReports.propertyAddress, `%${address!.toUpperCase()}%`))

  const reports = await db.select({
    id: savedReports.id,
    jobId: savedReports.jobId,
    propertyAddress: savedReports.propertyAddress,
    propertyClip: savedReports.propertyClip,
    arv: savedReports.arv,
    maxAllowableOffer: savedReports.maxAllowableOffer,
    estimatedRepairs: savedReports.estimatedRepairs,
    createdAt: savedReports.createdAt,
  })
    .from(savedReports)
    .where(condition)
    .orderBy(desc(savedReports.createdAt))
    .limit(10)

  return c.json({ reports })
})

// ─── GET /user/reports/:jobId/history ───────────────────────────────────────

userReports.get('/:jobId/history', async (c) => {
  const session = await getSession(c)
  if (!session?.user) return c.json({ error: 'Not authenticated' }, 401)

  const jobId = c.req.param('jobId')
  const db = drizzle(c.env.DB)

  // Find the report
  const [report] = await db.select({ id: savedReports.id })
    .from(savedReports)
    .where(and(eq(savedReports.jobId, jobId), eq(savedReports.userId, session.user.id)))
    .limit(1)

  if (!report) return c.json({ error: 'Report not found' }, 404)


  const history = await db.select()
    .from(reportHistory)
    .where(eq(reportHistory.reportId, report.id))
    .orderBy(desc(reportHistory.createdAt))
    .limit(50)

  return c.json({
    history: history.map((h) => ({
      id: h.id,
      action: h.action,
      description: h.description,
      changes: h.changesJson ? JSON.parse(h.changesJson) : null,
      createdAt: h.createdAt,
    })),
  })
})

// ─── POST /user/reports/:jobId/history ──────────────────────────────────────

userReports.post('/:jobId/history', async (c) => {
  const session = await getSession(c)
  if (!session?.user) return c.json({ error: 'Not authenticated' }, 401)

  const jobId = c.req.param('jobId')
  const body = await c.req.json().catch(() => ({})) as {
    action?: string
    description?: string
    changes?: unknown
  }

  if (!body.action || !body.description) {
    return c.json({ error: 'action and description required' }, 400)
  }
  if (body.action.startsWith('python_')) return c.json({ error: 'Reserved server history action' }, 400)

  const db = drizzle(c.env.DB)

  const [report] = await db.select({ id: savedReports.id })
    .from(savedReports)
    .where(and(eq(savedReports.jobId, jobId), eq(savedReports.userId, session.user.id)))
    .limit(1)

  if (!report) return c.json({ error: 'Report not found' }, 404)

  const [entry] = await db.insert(reportHistory).values({
    reportId: report.id,
    userId: session.user.id,
    action: body.action,
    description: body.description,
    changesJson: body.changes ? JSON.stringify(body.changes) : null,
  }).returning()

  return c.json({ entry })
})

// ─── PUT /user/reports/:jobId ────────────────────────────────────────────────

userReports.put('/:jobId', async (c) => {
  const session = await getSession(c)
  if (!session?.user) return c.json({ error: 'Not authenticated' }, 401)

  const jobId = c.req.param('jobId')
  const body = await c.req.json().catch(() => ({})) as {
    fullResponseJson?: string
    arv?: number
    maxAllowableOffer?: number
    estimatedRepairs?: number
    historyAction?: string
    historyDescription?: string
    historyChanges?: unknown
  }
  if (body.historyAction?.startsWith('python_')) return c.json({ error: 'Reserved server history action' }, 400)

  const db = drizzle(c.env.DB)

  const [report] = await db.select({ id: savedReports.id, fullResponseJson: savedReports.fullResponseJson })
    .from(savedReports)
    .where(and(eq(savedReports.jobId, jobId), eq(savedReports.userId, session.user.id)))
    .limit(1)

  if (!report) return c.json({ error: 'Report not found' }, 404)

  // Update report data
  const updates: Record<string, unknown> = {}
  if (body.fullResponseJson !== undefined) updates.fullResponseJson = body.fullResponseJson
  if (body.arv !== undefined) updates.arv = body.arv
  if (body.maxAllowableOffer !== undefined) updates.maxAllowableOffer = body.maxAllowableOffer
  if (body.estimatedRepairs !== undefined) updates.estimatedRepairs = body.estimatedRepairs

  if (Object.keys(updates).length > 0) {
    await db.update(savedReports).set(updates).where(eq(savedReports.id, report.id))
  }

  // Log history entry
  if (body.historyAction && body.historyDescription) {
    await db.insert(reportHistory).values({
      reportId: report.id,
      userId: session.user.id,
      action: body.historyAction,
      description: body.historyDescription,
      changesJson: body.historyChanges ? JSON.stringify(body.historyChanges) : null,
    })
  }

  return c.json({ success: true })
})

// ─── POST /user/reports/:jobId/feedback — Review stamp (batch review loop) ────
// 'validate' = the report/comps look right; 'improve' = flagged for a system fix.
// The generated ticket text is stored for audit; the dashboard also copies it
// so the reviewer can paste it into devin.ai.

userReports.post('/:jobId/feedback', bodyLimit({ maxSize: 100000 }), async (c) => {
  const session = await getSession(c)
  if (!session?.user) return c.json({ error: 'Not authenticated' }, 401)
  const origin = c.req.header('Origin')
  // Browsers always send Origin on POST; a missing Origin means a
  // server-side caller (dashboard server action) — already session-authed.
  if (origin != null && origin !== (c.env.DASHBOARD_URL ? new URL(c.env.DASHBOARD_URL).origin : null)) return c.json({ error: 'Untrusted origin' }, 403)
  if (!c.req.header('Content-Type')?.toLowerCase().startsWith('application/json')) return c.json({ error: 'JSON request required' }, 415)

  const body = await c.req.json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).some(key => !['type', 'notes', 'report'].includes(key)) ||
      (body.type !== 'validate' && body.type !== 'improve') ||
      (body.notes != null && typeof body.notes !== 'string') ||
      (body.report != null && typeof body.report !== 'string')) {
    return c.json({ error: 'Invalid feedback — type must be "validate" or "improve"' }, 400)
  }

  const jobId = c.req.param('jobId')
  const db = drizzle(c.env.DB)
  const status = body.type === 'validate' ? 'validated' : 'improve'
  const updated = await db
    .update(savedReports)
    .set({
      feedbackStatus: status,
      feedbackNotes: typeof body.notes === 'string' ? body.notes.slice(0, 5000) : null,
      feedbackReport: typeof body.report === 'string' ? body.report.slice(0, 50000) : null,
      feedbackAt: new Date().toISOString(),
    })
    .where(and(eq(savedReports.jobId, jobId), eq(savedReports.userId, session.user.id)))
    .returning({ id: savedReports.id })

  if (updated.length === 0) {
    // Batch-run reports have no saved_reports row — create one so the stamp
    // persists and the batch list can join it back.
    const [run] = await db
      .select({
        propertyAddress: analysisRuns.propertyAddress,
        arv: analysisRuns.arv,
      })
      .from(analysisRuns)
      .where(and(eq(analysisRuns.jobId, jobId), eq(analysisRuns.userId, session.user.id)))
      .limit(1)
    if (!run?.propertyAddress) return c.json({ error: 'Report not found' }, 404)

    const parts = run.propertyAddress.split(',').map((s) => s.trim())
    const stateZip = (parts[2] ?? '').split(/\s+/)
    await db.insert(savedReports).values({
      userId: session.user.id,
      jobId,
      propertyAddress: parts[0] ?? run.propertyAddress,
      propertyCity: parts[1] ?? '',
      propertyState: stateZip[0] ?? '',
      propertyZip: stateZip[1] ?? null,
      arv: run.arv ?? null,
      feedbackStatus: status,
      feedbackNotes: typeof body.notes === 'string' ? body.notes.slice(0, 5000) : null,
      feedbackReport: typeof body.report === 'string' ? body.report.slice(0, 50000) : null,
      feedbackAt: new Date().toISOString(),
    })
  }

  return c.json({ success: true, feedbackStatus: status })
})

// ─── GET /user/reports/:jobId ─────────────────────────────────────────────────

userReports.get('/:jobId', async (c) => {
  const session = await getSession(c)
  if (!session?.user) return c.json({ error: 'Not authenticated' }, 401)

  const jobId = c.req.param('jobId')
  const db = drizzle(c.env.DB)

  const report = await db
    .select()
    .from(savedReports)
    .where(eq(savedReports.jobId, jobId))
    .limit(1)
    .then((rows) => rows[0] ?? null)

  if (!report) {
    return c.json({ error: 'Report not found' }, 404)
  }

  // Verify the report belongs to the authenticated user
  if (report.userId !== session.user.id) {
    return c.json({ error: 'Report not found' }, 404)
  }

  let analysis = null
  if (report.fullResponseJson) {
    try {
      analysis = JSON.parse(report.fullResponseJson)
    } catch {
      return c.json({ error: 'Report data is corrupted' }, 500)
    }
  }

  return c.json({
    jobId: report.jobId,
    address: report.propertyAddress,
    createdAt: report.createdAt,
    analysis,
    feedbackStatus: report.feedbackStatus ?? null,
    feedbackAt: report.feedbackAt ?? null,
  })
})

// ─── GET /user/reports/:jobId/share ────────────────────────────────────────────

userReports.get('/:jobId/share', async (c) => {
  const session = await getSession(c)
  if (!session?.user) return c.json({ error: 'Not authenticated' }, 401)

  const jobId = c.req.param('jobId')
  const db = drizzle(c.env.DB)

  const report = await db
    .select({
      userId: savedReports.userId,
      isShared: savedReports.isShared,
      sharePasswordHash: savedReports.sharePasswordHash,
    })
    .from(savedReports)
    .where(eq(savedReports.jobId, jobId))
    .limit(1)
    .then((rows) => rows[0] ?? null)

  if (!report || report.userId !== session.user.id) {
    return c.json({ error: 'Report not found' }, 404)
  }

  const url = new URL(c.req.url)
  const baseUrl = url.hostname.includes('localhost')
    ? 'http://localhost:3000'
    : (c.env.DASHBOARD_URL || 'https://flowstate.homes')

  return c.json({
    isShared: report.isShared,
    hasPassword: !!report.sharePasswordHash,
    shareUrl: `${baseUrl}/report/${jobId}`,
  })
})

// ─── PUT /user/reports/:jobId/share ───────────────────────────────────────────

userReports.put('/:jobId/share', async (c) => {
  const session = await getSession(c)
  if (!session?.user) return c.json({ error: 'Not authenticated' }, 401)

  const jobId = c.req.param('jobId')
  const body = await c.req.json<{ isShared: boolean; password?: string }>()

  const db = drizzle(c.env.DB)

  const report = await db
    .select({ id: savedReports.id, userId: savedReports.userId })
    .from(savedReports)
    .where(eq(savedReports.jobId, jobId))
    .limit(1)
    .then((rows) => rows[0] ?? null)

  if (!report || report.userId !== session.user.id) {
    return c.json({ error: 'Report not found' }, 404)
  }

  if (body.isShared && !body.password) {
    return c.json({ error: 'Password is required when sharing' }, 400)
  }

  const updateData: { isShared: boolean; sharePasswordHash: string | null } = {
    isShared: body.isShared,
    sharePasswordHash: null,
  }

  if (body.isShared && body.password) {
    updateData.sharePasswordHash = await hashSharePassword(body.password)
  }

  await db
    .update(savedReports)
    .set(updateData)
    .where(eq(savedReports.id, report.id))

  const url = new URL(c.req.url)
  const baseUrl = url.hostname.includes('localhost')
    ? 'http://localhost:3000'
    : (c.env.DASHBOARD_URL || 'https://flowstate.homes')

  return c.json({
    isShared: body.isShared,
    hasPassword: !!updateData.sharePasswordHash,
    shareUrl: `${baseUrl}/report/${jobId}`,
  })
})

// ─── DELETE /user/reports/:jobId ─────────────────────────────────────────────

userReports.delete('/:jobId', async (c) => {
  const session = await getSession(c)
  if (!session?.user) return c.json({ error: 'Not authenticated' }, 401)

  const jobId = c.req.param('jobId')
  const db = drizzle(c.env.DB)

  const report = await db
    .select({ id: savedReports.id, userId: savedReports.userId, fullResponseJson: savedReports.fullResponseJson })
    .from(savedReports)
    .where(eq(savedReports.jobId, jobId))
    .limit(1)
    .then((rows) => rows[0] ?? null)

  if (!report || report.userId !== session.user.id) {
    return c.json({ error: 'Report not found' }, 404)
  }

  try {
    const saved = JSON.parse(report.fullResponseJson ?? '{}')
    await deleteReportAssets(c.env, jobId, Array.isArray(saved.reportAssets) && saved.reportAssets.length > 0)
  } catch {
    return c.json({ error: 'Report cleanup incomplete. The report was retained; retry deletion.', retriable: true }, 503)
  }
  await db.delete(savedReports).where(and(eq(savedReports.id, report.id), eq(savedReports.userId, session.user.id)))

  return c.json({ success: true })
})

export default userReports
