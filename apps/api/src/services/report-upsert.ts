/**
 * Shared report upsert — one saved report per property per user.
 *
 * A completed analysis for a property the user already has a report for
 * overwrites the newest matching row in place (and records a 'reanalyzed'
 * history entry). Any additional duplicate rows for the same property are
 * deleted, so the table self-heals even if duplicates were written by an
 * older code path or a direct insert.
 *
 * Matching prefers the provider property id (CoreLogic CLIP) — a stable
 * identifier unaffected by address formatting — and falls back to a
 * case-insensitive address + city + state match so the same street name
 * in a different city is never overwritten.
 */

import { and, desc, eq, inArray, or, sql } from 'drizzle-orm'
import type { drizzle } from 'drizzle-orm/d1'
import { savedReports, reportHistory, runTelemetry } from '../db/schema'

type DrizzleDb = ReturnType<typeof drizzle>

export interface ReportIdentity {
  userId: string
  jobId: string
  propertyAddress: string
  propertyCity: string
  propertyState: string
  propertyZip?: string
  /** Provider property id (CoreLogic CLIP) — preferred match key */
  propertyClip?: string | null
}

export interface ReportMetrics {
  fullResponseJson: string
  arv: number | null
  asIsValue: number | null
  maxAllowableOffer: number | null
  estimatedRepairs: number | null
  /** Set-B mechanics — queryable without parsing full_response_json */
  arvSource?: string | null
  bConfidence?: string | null
  bHealed?: boolean | null
  bAnchorAddress?: string | null
  bFlagCount?: number | null
}

/** Extract Set-B mechanics from the serialized valuation block. */
export function bMetricsFromValuation(valuation: Record<string, unknown> | null | undefined) {
  const m = valuation?.bMechanics as {
    source?: string; confidence?: string; healed?: boolean;
    anchorAddress?: string | null; flags?: string[]
  } | null | undefined
  if (!m) return {}
  return {
    arvSource: m.source ?? null,
    bConfidence: m.confidence ?? null,
    bHealed: m.healed ?? null,
    bAnchorAddress: m.anchorAddress ?? null,
    bFlagCount: Array.isArray(m.flags) ? m.flags.length : null,
  }
}

export async function upsertPropertyReport(
  db: DrizzleDb,
  fields: ReportIdentity,
  reportData: ReportMetrics,
): Promise<void> {
  const historyChanges = JSON.stringify({
    arv: reportData.arv,
    buyPrice: reportData.maxAllowableOffer,
    rehabCost: reportData.estimatedRepairs,
  })

  const addressCondition = and(
    sql`UPPER(${savedReports.propertyAddress}) = UPPER(${fields.propertyAddress})`,
    sql`UPPER(${savedReports.propertyCity}) = UPPER(${fields.propertyCity})`,
    sql`UPPER(${savedReports.propertyState}) = UPPER(${fields.propertyState})`,
  )
  const clip = fields.propertyClip?.trim()
  const condition = and(
    eq(savedReports.userId, fields.userId),
    clip ? or(eq(savedReports.propertyClip, clip), addressCondition) : addressCondition,
  )

  const matches = await db
    .select({ id: savedReports.id })
    .from(savedReports)
    .where(condition)
    .orderBy(desc(savedReports.createdAt))

  const [keep, ...extras] = matches

  if (keep) {
    await db
      .update(savedReports)
      .set({
        ...reportData,
        jobId: fields.jobId,
        propertyAddress: fields.propertyAddress,
        propertyCity: fields.propertyCity,
        propertyState: fields.propertyState,
        propertyZip: fields.propertyZip ?? '',
        ...(clip ? { propertyClip: clip } : {}),
      })
      .where(eq(savedReports.id, keep.id))

    if (extras.length > 0) {
      await db.delete(savedReports).where(inArray(savedReports.id, extras.map((e) => e.id)))
      console.log(`[report-upsert] Removed ${extras.length} duplicate report row(s) for ${fields.propertyAddress}`)
    }

    await db.insert(reportHistory).values({
      reportId: keep.id,
      userId: fields.userId,
      action: 'reanalyzed',
      description: extras.length > 0
        ? `Report overwritten by a new analysis (${extras.length} duplicate(s) removed)`
        : 'Report overwritten by a new analysis',
      changesJson: historyChanges,
    })
    console.log(`[report-upsert] Report overwritten for ${fields.propertyAddress} (job ${fields.jobId})`)
    return
  }

  const [inserted] = await db
    .insert(savedReports)
    .values({
      ...fields,
      propertyClip: clip ?? null,
      propertyZip: fields.propertyZip ?? '',
      ...reportData,
    })
    .returning({ id: savedReports.id })
  await db.insert(reportHistory).values({
    reportId: inserted.id,
    userId: fields.userId,
    action: 'created',
    description: 'Report created',
    changesJson: historyChanges,
  })
  console.log(`[report-upsert] Report saved for job ${fields.jobId}`)
}

/** Record one appraisal run into run_telemetry — the queryable decision
 *  trail for audits: what the machine decided, per comp, per rule. */
export async function recordRunTelemetry(
  db: DrizzleDb,
  opts: {
    jobId?: string | null
    userId: string
    address: string
    valuation?: Record<string, unknown> | null
    comps?: { items?: unknown[] } | null
    durationMs?: number | null
  },
): Promise<void> {
  const val = opts.valuation ?? null
  const m = val?.bMechanics as {
    source?: string; confidence?: string; bracket?: string;
    anchorAddress?: string | null; flags?: string[];
    drivers?: { address: string | null }[];
    decisions?: unknown[];
    attemptTrail?: string[]
  } | null | undefined
  const RULE_RE: [RegExp, string][] = [
    [/rescued/i, 'rescue'], [/pocket trend/i, 'market-trend'], [/land adj/i, 'marginal-land'],
    [/size rate|sqft/i, 'marginal-sqft'], [/adjustment — bound/i, 'urar-cap-25'],
    [/dropped from drivers — outside/i, 'geo-tier'], [/similarity .*below gate/i, 'sim-gate'],
    [/suspected outlier, set aside/i, 'microscope'], [/anchored to/i, 'anchor'],
    [/self-heal/i, 'self-heal'], [/below maintained band/i, 'maintained-floor'],
    [/exceeds size-adjusted ceiling/i, 'outlier-ceiling'], [/evicted/i, 'tight-band'],
    [/pocket-tiers/i, 'pocket-tiers'], [/median-tier driver|median-tier anchor/i, 'median-tier'],
    [/bracketing/i, 'bracketing'], [/retail/i, 'retail-band'],
  ]
  const rules = [...new Set((m?.flags ?? [])
    .map((f) => RULE_RE.find(([re]) => re.test(f))?.[1] ?? null)
    .filter((x): x is string => !!x))]
  await db.insert(runTelemetry).values({
    jobId: opts.jobId ?? null,
    userId: opts.userId,
    address: opts.address,
    arv: (val?.arv as number) ?? null,
    arvSource: m?.source ?? null,
    confidence: m?.confidence ?? null,
    bracket: m?.bracket ?? null,
    anchorAddress: m?.anchorAddress ?? null,
    poolSize: opts.comps?.items?.length ?? null,
    driverCount: m?.drivers?.length ?? null,
    decisionsJson: m?.decisions ? JSON.stringify(m.decisions) : null,
    rulesFiredJson: JSON.stringify(rules),
    durationMs: opts.durationMs ?? null,
  })
}
