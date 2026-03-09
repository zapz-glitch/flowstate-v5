/**
 * Public Reports Route
 *
 * Serves saved analysis reports by jobId.
 * No authentication required — jobId is unguessable (UUID + timestamp).
 * Used by GHL report links and any public sharing.
 */

import { Hono } from 'hono'
import { drizzle } from 'drizzle-orm/d1'
import { eq } from 'drizzle-orm'
import type { Env } from '../types'
import { savedReports } from '../db/schema'

const reports = new Hono<{ Bindings: Env }>()

/**
 * GET /reports/:jobId
 *
 * Fetch a saved analysis report by job ID.
 * Returns the full analysis response JSON.
 */
reports.get('/:jobId', async (c) => {
  try {
    const jobId = c.req.param('jobId')

    const db = drizzle(c.env.DB)
    const report = await db
      .select()
      .from(savedReports)
      .where(eq(savedReports.jobId, jobId))
      .limit(1)
      .then((rows) => rows[0] ?? null)

    if (!report) {
      return c.json({ success: false, error: 'Report not found' }, 404)
    }

    // Parse the full response JSON
    let analysisData = null
    if (report.fullResponseJson) {
      try {
        analysisData = JSON.parse(report.fullResponseJson)
      } catch {
        return c.json({ success: false, error: 'Report data is corrupted' }, 500)
      }
    }

    return c.json(
      {
        success: true,
        data: {
          jobId: report.jobId,
          address: report.propertyAddress,
          createdAt: report.createdAt,
          analysis: analysisData,
        },
      },
      200,
      {
        'Cache-Control': 'public, max-age=86400',
      }
    )
  } catch (error) {
    console.error('[Reports] Error fetching report:', error)
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to fetch report',
      },
      500
    )
  }
})

export default reports
