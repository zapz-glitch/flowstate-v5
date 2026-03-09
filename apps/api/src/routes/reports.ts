/**
 * Public Reports Route
 *
 * Serves saved analysis reports by jobId with privacy controls.
 * Reports are private by default. Shared reports require password verification.
 * Logged-in report owners bypass the password check.
 */

import { Hono } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'
import { drizzle } from 'drizzle-orm/d1'
import { eq } from 'drizzle-orm'
import type { Env } from '../types'
import { savedReports } from '../db/schema'
import { createAuth } from '../lib/auth'
import { verifySharePassword, signAccessToken, verifyAccessToken } from '../lib/share-token'

const reports = new Hono<{ Bindings: Env }>()

/** Try to get the authenticated user's ID (non-blocking). */
async function tryGetUserId(c: any): Promise<string | null> {
  try {
    const url = new URL(c.req.url)
    const baseURL = `${url.protocol}//${url.host}/auth`
    const auth = createAuth(c.env.DB, c.env.BETTER_AUTH_SECRET, baseURL)
    const session = await auth.api.getSession({ headers: c.req.raw.headers })
    return session?.user?.id ?? null
  } catch {
    return null
  }
}

function reportResponse(report: any) {
  let analysisData = null
  if (report.fullResponseJson) {
    try {
      analysisData = JSON.parse(report.fullResponseJson)
    } catch {
      return null
    }
  }
  return {
    jobId: report.jobId,
    address: report.propertyAddress,
    createdAt: report.createdAt,
    analysis: analysisData,
  }
}

/**
 * GET /reports/:jobId
 *
 * Fetch a saved analysis report by job ID.
 * Access flow:
 *   1. Owner (logged in) → immediate access
 *   2. Not shared → 403
 *   3. Valid access cookie → access
 *   4. No cookie → 401 (password required)
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

    // 1. Check if the requester is the report owner
    const userId = await tryGetUserId(c)
    if (userId && userId === report.userId) {
      const data = reportResponse(report)
      if (!data) return c.json({ success: false, error: 'Report data is corrupted' }, 500)
      return c.json(
        { success: true, data, isOwner: true },
        200,
        { 'Cache-Control': 'private, no-store' }
      )
    }

    // 2. Check if sharing is enabled
    if (!report.isShared) {
      return c.json({ success: false, error: 'This report is private' }, 403)
    }

    // 3. Check for valid access cookie
    const accessToken = getCookie(c, 'report_access')
    if (accessToken) {
      const tokenJobId = await verifyAccessToken(accessToken, c.env.BETTER_AUTH_SECRET || '')
      if (tokenJobId === jobId) {
        const data = reportResponse(report)
        if (!data) return c.json({ success: false, error: 'Report data is corrupted' }, 500)
        return c.json(
          { success: true, data },
          200,
          { 'Cache-Control': 'private, no-store' }
        )
      }
    }

    // 4. Password required
    return c.json(
      { success: false, error: 'Password required', requiresPassword: true },
      401
    )
  } catch (error) {
    console.error('[Reports] Error fetching report:', error)
    return c.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to fetch report' },
      500
    )
  }
})

/**
 * POST /reports/:jobId/verify
 *
 * Verify the share password and set an access cookie.
 */
reports.post('/:jobId/verify', async (c) => {
  try {
    const jobId = c.req.param('jobId')
    const body = await c.req.json<{ password?: string }>()

    if (!body.password) {
      return c.json({ success: false, error: 'Password is required' }, 400)
    }

    const db = drizzle(c.env.DB)
    const report = await db
      .select({
        isShared: savedReports.isShared,
        sharePasswordHash: savedReports.sharePasswordHash,
      })
      .from(savedReports)
      .where(eq(savedReports.jobId, jobId))
      .limit(1)
      .then((rows) => rows[0] ?? null)

    if (!report) {
      return c.json({ success: false, error: 'Report not found' }, 404)
    }

    if (!report.isShared) {
      return c.json({ success: false, error: 'This report is private' }, 403)
    }

    if (!report.sharePasswordHash) {
      return c.json({ success: false, error: 'Share password not configured' }, 500)
    }

    const valid = await verifySharePassword(body.password, report.sharePasswordHash)
    if (!valid) {
      return c.json({ success: false, error: 'Incorrect password' }, 401)
    }

    // Set access cookie (24h)
    const token = await signAccessToken(jobId, c.env.BETTER_AUTH_SECRET || '')
    const isLocal = c.req.url.includes('localhost')
    setCookie(c, 'report_access', token, {
      httpOnly: true,
      secure: !isLocal,
      sameSite: 'Lax',
      maxAge: 24 * 60 * 60,
      path: '/',
      ...(isLocal ? {} : { domain: '.flowstate.homes' }),
    })

    return c.json({ success: true })
  } catch (error) {
    console.error('[Reports] Error verifying password:', error)
    return c.json(
      { success: false, error: error instanceof Error ? error.message : 'Verification failed' },
      500
    )
  }
})

export default reports
