/**
 * Process Documentation Comments Routes
 *
 * CRUD endpoints for collaborative comments on methodology documentation.
 * All routes require session authentication via Better Auth cookies.
 */

import { Hono } from 'hono'
import { drizzle } from 'drizzle-orm/d1'
import { eq, and, isNull, isNotNull, asc } from 'drizzle-orm'
import type { Env } from '../types'
import { createAuth } from '../lib/auth'
import { processDocComments, user as usersTable } from '@flowstate-api/db'

const comments = new Hono<{ Bindings: Env }>()

// Valid section IDs (must match frontend content.tsx)
const VALID_SECTION_IDS = [
  'property-classification',
  'appraisal-filters',
  'price-adjustments',
  'weighted-arv',
  'investment-scenarios',
  'valuation-recommendations',
  'analysis-flow',
] as const

// Helper to get session from request (same pattern as routes/user.ts)
async function getSession(c: any) {
  const url = new URL(c.req.url)
  const baseURL = `${url.protocol}//${url.host}/auth`
  const auth = createAuth(c.env.DB, c.env.BETTER_AUTH_SECRET, baseURL)

  try {
    const session = await auth.api.getSession({ headers: c.req.raw.headers })
    return session
  } catch (error) {
    console.error('Error getting session:', error)
    return null
  }
}

// GET /comments?sectionId=xxx — List comments for a section
comments.get('/', async (c) => {
  const session = await getSession(c)
  if (!session?.user) {
    return c.json({ error: 'Not authenticated' }, 401)
  }

  const sectionId = c.req.query('sectionId')
  if (!sectionId) {
    return c.json({ error: 'sectionId is required' }, 400)
  }

  const db = drizzle(c.env.DB)

  // Fetch top-level comments with user info
  const topLevel = await db
    .select({
      id: processDocComments.id,
      sectionId: processDocComments.sectionId,
      content: processDocComments.content,
      isDeleted: processDocComments.isDeleted,
      createdAt: processDocComments.createdAt,
      updatedAt: processDocComments.updatedAt,
      userId: processDocComments.userId,
      userName: usersTable.name,
      userEmail: usersTable.email,
    })
    .from(processDocComments)
    .leftJoin(usersTable, eq(processDocComments.userId, usersTable.id))
    .where(
      and(
        eq(processDocComments.sectionId, sectionId),
        isNull(processDocComments.parentId)
      )
    )
    .orderBy(asc(processDocComments.createdAt))

  // Fetch all replies for this section
  const replies = await db
    .select({
      id: processDocComments.id,
      parentId: processDocComments.parentId,
      sectionId: processDocComments.sectionId,
      content: processDocComments.content,
      isDeleted: processDocComments.isDeleted,
      createdAt: processDocComments.createdAt,
      updatedAt: processDocComments.updatedAt,
      userId: processDocComments.userId,
      userName: usersTable.name,
      userEmail: usersTable.email,
    })
    .from(processDocComments)
    .leftJoin(usersTable, eq(processDocComments.userId, usersTable.id))
    .where(
      and(
        eq(processDocComments.sectionId, sectionId),
        isNotNull(processDocComments.parentId)
      )
    )
    .orderBy(asc(processDocComments.createdAt))

  // Nest replies under parents
  const repliesByParent = new Map<string, typeof replies>()
  for (const reply of replies) {
    if (!reply.parentId) continue
    const existing = repliesByParent.get(reply.parentId) || []
    existing.push(reply)
    repliesByParent.set(reply.parentId, existing)
  }

  const result = topLevel.map((comment) => ({
    id: comment.id,
    sectionId: comment.sectionId,
    content: comment.isDeleted ? '[Comment deleted]' : comment.content,
    isDeleted: comment.isDeleted,
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt,
    user: {
      id: comment.userId,
      name: comment.userName || 'Unknown',
      email: comment.userEmail || '',
    },
    replies: (repliesByParent.get(comment.id) || []).map((r) => ({
      id: r.id,
      sectionId: r.sectionId,
      content: r.isDeleted ? '[Comment deleted]' : r.content,
      isDeleted: r.isDeleted,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      user: {
        id: r.userId,
        name: r.userName || 'Unknown',
        email: r.userEmail || '',
      },
      replies: [],
    })),
  }))

  return c.json({
    comments: result,
    totalCount: topLevel.length + replies.length,
  })
})

// POST /comments — Create a new comment
comments.post('/', async (c) => {
  const session = await getSession(c)
  if (!session?.user) {
    return c.json({ error: 'Not authenticated' }, 401)
  }

  const body = await c.req.json().catch(() => ({}))
  const { sectionId, content, parentId } = body as {
    sectionId?: string
    content?: string
    parentId?: string
  }

  // Validate sectionId
  if (!sectionId || !(VALID_SECTION_IDS as readonly string[]).includes(sectionId)) {
    return c.json({ error: 'Invalid sectionId' }, 400)
  }

  // Validate content
  if (!content || content.trim().length === 0) {
    return c.json({ error: 'Content is required' }, 400)
  }
  if (content.length > 2000) {
    return c.json({ error: 'Content must be 2000 characters or less' }, 400)
  }

  const db = drizzle(c.env.DB)

  // If replying, verify parent exists and is top-level
  if (parentId) {
    const [parent] = await db
      .select()
      .from(processDocComments)
      .where(eq(processDocComments.id, parentId))
      .limit(1)

    if (!parent) {
      return c.json({ error: 'Parent comment not found' }, 404)
    }
    if (parent.parentId !== null) {
      return c.json({ error: 'Cannot reply to a reply' }, 400)
    }
  }

  // Insert comment
  const [newComment] = await db
    .insert(processDocComments)
    .values({
      userId: session.user.id,
      sectionId,
      parentId: parentId || null,
      content: content.trim(),
    })
    .returning()

  // Fetch user info for response
  const [userData] = await db
    .select({ name: usersTable.name, email: usersTable.email })
    .from(usersTable)
    .where(eq(usersTable.id, session.user.id))
    .limit(1)

  return c.json({
    id: newComment.id,
    sectionId: newComment.sectionId,
    content: newComment.content,
    isDeleted: newComment.isDeleted,
    createdAt: newComment.createdAt,
    updatedAt: newComment.updatedAt,
    user: {
      id: session.user.id,
      name: userData?.name || 'Unknown',
      email: userData?.email || '',
    },
    replies: [],
  })
})

// PATCH /comments/:id — Edit a comment
comments.patch('/:id', async (c) => {
  const session = await getSession(c)
  if (!session?.user) {
    return c.json({ error: 'Not authenticated' }, 401)
  }

  const commentId = c.req.param('id')
  const body = await c.req.json().catch(() => ({}))
  const { content } = body as { content?: string }

  if (!content || content.trim().length === 0) {
    return c.json({ error: 'Content is required' }, 400)
  }
  if (content.length > 2000) {
    return c.json({ error: 'Content must be 2000 characters or less' }, 400)
  }

  const db = drizzle(c.env.DB)

  // Verify ownership
  const [comment] = await db
    .select()
    .from(processDocComments)
    .where(eq(processDocComments.id, commentId))
    .limit(1)

  if (!comment) {
    return c.json({ error: 'Comment not found' }, 404)
  }
  if (comment.userId !== session.user.id) {
    return c.json({ error: 'Not authorized' }, 403)
  }
  if (comment.isDeleted) {
    return c.json({ error: 'Cannot edit a deleted comment' }, 400)
  }

  await db
    .update(processDocComments)
    .set({
      content: content.trim(),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(processDocComments.id, commentId))

  return c.json({ success: true })
})

// DELETE /comments/:id — Soft delete a comment
comments.delete('/:id', async (c) => {
  const session = await getSession(c)
  if (!session?.user) {
    return c.json({ error: 'Not authenticated' }, 401)
  }

  const commentId = c.req.param('id')
  const db = drizzle(c.env.DB)

  // Verify ownership
  const [comment] = await db
    .select()
    .from(processDocComments)
    .where(eq(processDocComments.id, commentId))
    .limit(1)

  if (!comment) {
    return c.json({ error: 'Comment not found' }, 404)
  }
  if (comment.userId !== session.user.id) {
    return c.json({ error: 'Not authorized' }, 403)
  }

  await db
    .update(processDocComments)
    .set({
      isDeleted: true,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(processDocComments.id, commentId))

  return c.json({ success: true })
})

export default comments
