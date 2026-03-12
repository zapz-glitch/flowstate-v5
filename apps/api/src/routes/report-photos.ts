/**
 * Report Photos Routes (Session Auth)
 *
 * Upload property photos to R2, run AI analysis, list/delete photos.
 */

import { Hono } from 'hono'
import { drizzle } from 'drizzle-orm/d1'
import { eq, and, desc } from 'drizzle-orm'
import type { Env } from '../types'
import { createAuth } from '../lib/auth'
import { reportPhotos, photoAnalysisResults, savedReports } from '../db/schema'
import { analyzePropertyPhotos } from '../services/photo-analysis'
import { detectMimeType } from '../services/llm/image-utils'

const reportPhotosRoute = new Hono<{ Bindings: Env }>()

const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])
const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10MB
const MAX_FILES = 20

async function getSession(c: any) {
  const url = new URL(c.req.url)
  const baseURL = `${url.protocol}//${url.host}/auth`
  const auth = createAuth(c.env.DB, c.env.BETTER_AUTH_SECRET, baseURL)
  try {
    return await auth.api.getSession({ headers: c.req.raw.headers })
  } catch {
    return null
  }
}

async function verifyReportOwnership(c: any, jobId: string, userId: string): Promise<boolean> {
  const db = drizzle(c.env.DB)
  const report = await db
    .select({ userId: savedReports.userId })
    .from(savedReports)
    .where(eq(savedReports.jobId, jobId))
    .limit(1)
    .then((rows) => rows[0] ?? null)
  return report?.userId === userId
}

// ─── POST /:jobId/photos — Upload photos ────────────────────────────────────

reportPhotosRoute.post('/:jobId/photos', async (c) => {
  const session = await getSession(c)
  if (!session?.user) return c.json({ error: 'Not authenticated' }, 401)

  const jobId = c.req.param('jobId')
  if (!(await verifyReportOwnership(c, jobId, session.user.id))) {
    return c.json({ error: 'Report not found' }, 404)
  }

  if (!c.env.REPORT_PHOTOS) {
    return c.json({ error: 'Photo storage not configured' }, 503)
  }

  const formData = await c.req.formData()
  const rawEntries = formData.getAll('photos') as unknown as File[]
  const files = rawEntries.filter((entry) => typeof entry !== 'string' && typeof entry.arrayBuffer === 'function')

  if (!files.length) {
    return c.json({ error: 'No files provided' }, 400)
  }
  if (files.length > MAX_FILES) {
    return c.json({ error: `Maximum ${MAX_FILES} files per upload` }, 400)
  }

  const db = drizzle(c.env.DB)
  const uploaded: Array<{ id: string; fileName: string; mimeType: string; sizeBytes: number }> = []

  for (const file of files) {
    const mimeType = file.type || detectMimeType(null, file.name)
    if (!ALLOWED_TYPES.has(mimeType)) {
      return c.json({ error: `Invalid file type: ${mimeType}. Allowed: JPEG, PNG, WebP` }, 400)
    }
    if (file.size > MAX_FILE_SIZE) {
      return c.json({ error: `File ${file.name} exceeds 10MB limit` }, 400)
    }

    const id = crypto.randomUUID()
    const ext = file.name.split('.').pop() || 'jpg'
    const r2Key = `${session.user.id}/${jobId}/${id}.${ext}`

    const arrayBuffer = await file.arrayBuffer()
    await c.env.REPORT_PHOTOS.put(r2Key, arrayBuffer, {
      httpMetadata: { contentType: mimeType },
    })

    await db.insert(reportPhotos).values({
      id,
      userId: session.user.id,
      jobId,
      r2Key,
      fileName: file.name,
      mimeType,
      sizeBytes: file.size,
    })

    uploaded.push({ id, fileName: file.name, mimeType, sizeBytes: file.size })
  }

  return c.json({ photos: uploaded })
})

// ─── POST /:jobId/photos/analyze — Run AI analysis ─────────────────────────

reportPhotosRoute.post('/:jobId/photos/analyze', async (c) => {
  const session = await getSession(c)
  if (!session?.user) return c.json({ error: 'Not authenticated' }, 401)

  const jobId = c.req.param('jobId')
  if (!(await verifyReportOwnership(c, jobId, session.user.id))) {
    return c.json({ error: 'Report not found' }, 404)
  }

  if (!c.env.REPORT_PHOTOS) {
    return c.json({ error: 'Photo storage not configured' }, 503)
  }

  const db = drizzle(c.env.DB)

  // Get all photos for this report
  const photos = await db
    .select()
    .from(reportPhotos)
    .where(and(eq(reportPhotos.userId, session.user.id), eq(reportPhotos.jobId, jobId)))

  if (!photos.length) {
    return c.json({ error: 'No photos to analyze. Upload photos first.' }, 400)
  }

  // Read photos from R2
  const photoData: Array<{ data: ArrayBuffer; mimeType: string }> = []
  for (const photo of photos) {
    const obj = await c.env.REPORT_PHOTOS.get(photo.r2Key)
    if (obj) {
      photoData.push({
        data: await obj.arrayBuffer(),
        mimeType: photo.mimeType,
      })
    }
  }

  if (!photoData.length) {
    return c.json({ error: 'Could not read photos from storage' }, 500)
  }

  // Run AI analysis
  const result = await analyzePropertyPhotos(c.env, photoData)

  // Save results
  await db.insert(photoAnalysisResults).values({
    userId: session.user.id,
    jobId,
    findingsJson: JSON.stringify(result.findings),
    model: result.model,
  })

  return c.json({
    findings: result.findings,
    model: result.model,
    photoCount: result.photoCount,
  })
})

// ─── GET /:jobId/photos — List photos + latest findings ────────────────────

reportPhotosRoute.get('/:jobId/photos', async (c) => {
  const session = await getSession(c)
  if (!session?.user) return c.json({ error: 'Not authenticated' }, 401)

  const jobId = c.req.param('jobId')
  const db = drizzle(c.env.DB)

  const [photos, latestAnalysis] = await Promise.all([
    db
      .select({
        id: reportPhotos.id,
        fileName: reportPhotos.fileName,
        mimeType: reportPhotos.mimeType,
        sizeBytes: reportPhotos.sizeBytes,
        createdAt: reportPhotos.createdAt,
      })
      .from(reportPhotos)
      .where(and(eq(reportPhotos.userId, session.user.id), eq(reportPhotos.jobId, jobId))),
    db
      .select()
      .from(photoAnalysisResults)
      .where(and(eq(photoAnalysisResults.userId, session.user.id), eq(photoAnalysisResults.jobId, jobId)))
      .orderBy(desc(photoAnalysisResults.createdAt))
      .limit(1)
      .then((rows) => rows[0] ?? null),
  ])

  let findings = null
  if (latestAnalysis) {
    try {
      findings = JSON.parse(latestAnalysis.findingsJson)
    } catch {
      findings = null
    }
  }

  return c.json({
    photos,
    findings,
    analysisModel: latestAnalysis?.model ?? null,
    analysisDate: latestAnalysis?.createdAt ?? null,
  })
})

// ─── DELETE /:jobId/photos/:photoId — Delete a photo ────────────────────────

reportPhotosRoute.delete('/:jobId/photos/:photoId', async (c) => {
  const session = await getSession(c)
  if (!session?.user) return c.json({ error: 'Not authenticated' }, 401)

  const { jobId, photoId } = c.req.param()
  const db = drizzle(c.env.DB)

  const photo = await db
    .select()
    .from(reportPhotos)
    .where(and(
      eq(reportPhotos.id, photoId),
      eq(reportPhotos.userId, session.user.id),
      eq(reportPhotos.jobId, jobId),
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null)

  if (!photo) {
    return c.json({ error: 'Photo not found' }, 404)
  }

  // Delete from R2
  if (c.env.REPORT_PHOTOS) {
    await c.env.REPORT_PHOTOS.delete(photo.r2Key)
  }

  // Delete from DB
  await db.delete(reportPhotos).where(eq(reportPhotos.id, photoId))

  return c.json({ success: true })
})

export default reportPhotosRoute
