/**
 * ML Export Route — CDARV ideal-report feed
 *
 * Cursor-paginated export of the caller's human-validated reports for the
 * CDARV training pipeline (services/ml). Each row carries the full stored
 * analysis JSON: subject, the entire evaluated comp pool with filter
 * results and adjustments, and the final approved comp selection.
 *
 * Auth: standard /v1 API key (Bearer fs_...) — the route is scoped to the
 * key owner's reports, identical trust boundary to the rest of /v1.
 */

import { Hono } from 'hono'
import type { Env } from '../types'
import type { AuthContext } from '../middleware/auth'

type Variables = { auth: AuthContext }

const mlExport = new Hono<{ Bindings: Env; Variables: Variables }>()

const DEFAULT_LIMIT = 25
const MAX_LIMIT = 50

/** Cursor = `${created_at}~${id}` of the last row of the previous page.
 * `~` is URL-safe unencoded; report ids and ISO timestamps never contain it. */
function encodeCursor(createdAt: string, id: string): string {
  return `${createdAt}~${id}`
}

function decodeCursor(raw: string): { createdAt: string; id: string } | null {
  const sep = raw.lastIndexOf('~')
  if (sep <= 0) return null
  return { createdAt: raw.slice(0, sep), id: raw.slice(sep + 1) }
}

mlExport.get('/ideal-reports', async (c) => {
  const auth = c.get('auth')
  const limitParam = Number(c.req.query('limit') ?? DEFAULT_LIMIT)
  const limit = Number.isSafeInteger(limitParam) && limitParam > 0
    ? Math.min(limitParam, MAX_LIMIT)
    : DEFAULT_LIMIT

  const cursorParam = c.req.query('cursor')
  const cursor = cursorParam ? decodeCursor(cursorParam) : null
  if (cursorParam && !cursor) {
    return c.json({ success: false, error: 'Invalid cursor' }, 400)
  }

  const rows = await c.env.DB.prepare(
    `SELECT id, user_id, job_id, property_address, property_city, property_state,
            property_zip, feedback_status, feedback_at, feedback_notes,
            created_at, full_response_json
     FROM saved_reports
     WHERE user_id = ?
       AND feedback_status = 'validated'
       AND full_response_json IS NOT NULL
       ${cursor ? 'AND (created_at > ? OR (created_at = ? AND id > ?))' : ''}
     ORDER BY created_at, id
     LIMIT ?`
  )
    .bind(
      ...[auth.userId,
        ...(cursor ? [cursor.createdAt, cursor.createdAt, cursor.id] : []),
        limit + 1]
    )
    .all<{
      id: string
      user_id: string
      job_id: string | null
      property_address: string
      property_city: string
      property_state: string
      property_zip: string | null
      feedback_status: string | null
      feedback_at: string | null
      feedback_notes: string | null
      created_at: string
      full_response_json: string
    }>()

  const results = rows.results ?? []
  const page = results.slice(0, limit)
  const last = page[page.length - 1]

  return c.json({
    success: true,
    reports: page.map((r) => {
      let report: unknown = null
      try {
        report = JSON.parse(r.full_response_json)
      } catch {
        report = null
      }
      return {
        reportId: r.id,
        userId: r.user_id,
        jobId: r.job_id,
        address: [r.property_address, r.property_city, r.property_state]
          .filter(Boolean)
          .join(', '),
        zip: r.property_zip,
        feedbackStatus: r.feedback_status,
        feedbackAt: r.feedback_at,
        feedbackNotes: r.feedback_notes,
        createdAt: r.created_at,
        report,
      }
    }),
    nextCursor:
      results.length > limit && last ? encodeCursor(last.created_at, last.id) : null,
  })
})

export default mlExport
