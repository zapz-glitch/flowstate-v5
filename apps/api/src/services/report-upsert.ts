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
import { savedReports, reportHistory } from '../db/schema'

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
