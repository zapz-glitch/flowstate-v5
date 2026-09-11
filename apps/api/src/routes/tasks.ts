import { Hono } from 'hono'
import { drizzle } from 'drizzle-orm/d1'
import { eq, and, asc } from 'drizzle-orm'
import { tasks } from '../db'
import { getSession } from '../lib/session'
import type { Env } from '../types'

export const tasksRoute = new Hono<{ Bindings: Env }>()

const serialize = (t: typeof tasks.$inferSelect) => ({ ...t, done: t.done === 1 })

// GET /tasks — all tasks, open first then by created date
tasksRoute.get('/', async (c) => {
  const session = await getSession(c)
  if (!session?.user) return c.json({ error: 'Not authenticated' }, 401)
  const db = drizzle(c.env.DB)
  const rows = await db
    .select()
    .from(tasks)
    .where(eq(tasks.userId, session.user.id))
    .orderBy(asc(tasks.done), asc(tasks.dueDate), asc(tasks.createdAt))
  return c.json({ tasks: rows.map(serialize) })
})

// POST /tasks — create
tasksRoute.post('/', async (c) => {
  const session = await getSession(c)
  if (!session?.user) return c.json({ error: 'Not authenticated' }, 401)
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
  const title = typeof body.title === 'string' ? body.title.trim().slice(0, 200) : ''
  if (!title) return c.json({ error: 'Title is required' }, 400)
  const project = typeof body.project === 'string' && body.project.trim() ? body.project.trim().slice(0, 120) : null
  const dueDate = typeof body.dueDate === 'string' && body.dueDate.trim() ? body.dueDate.slice(0, 40) : null

  const db = drizzle(c.env.DB)
  const [row] = await db.insert(tasks).values({ userId: session.user.id, title, project, dueDate }).returning()
  return c.json({ task: serialize(row) })
})

// PATCH /tasks/:id — update title/project/dueDate/done
tasksRoute.patch('/:id', async (c) => {
  const session = await getSession(c)
  if (!session?.user) return c.json({ error: 'Not authenticated' }, 401)
  const id = c.req.param('id')
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>

  const set: Record<string, unknown> = { updatedAt: new Date().toISOString() }
  if (typeof body.title === 'string' && body.title.trim()) set.title = body.title.trim().slice(0, 200)
  if ('project' in body) set.project = typeof body.project === 'string' && body.project.trim() ? body.project.trim().slice(0, 120) : null
  if ('dueDate' in body) set.dueDate = typeof body.dueDate === 'string' && body.dueDate.trim() ? body.dueDate.slice(0, 40) : null
  if (typeof body.done === 'boolean') {
    set.done = body.done ? 1 : 0
    set.doneAt = body.done ? new Date().toISOString() : null
  }

  const db = drizzle(c.env.DB)
  const res = await db.update(tasks).set(set)
    .where(and(eq(tasks.id, id), eq(tasks.userId, session.user.id)))
  if ((res.meta?.changes ?? 0) === 0) return c.json({ error: 'Task not found' }, 404)
  const [row] = await db.select().from(tasks).where(eq(tasks.id, id)).limit(1)
  return c.json({ task: serialize(row) })
})

// DELETE /tasks/:id
tasksRoute.delete('/:id', async (c) => {
  const session = await getSession(c)
  if (!session?.user) return c.json({ error: 'Not authenticated' }, 401)
  const db = drizzle(c.env.DB)
  const res = await db.delete(tasks)
    .where(and(eq(tasks.id, c.req.param('id')), eq(tasks.userId, session.user.id)))
  if ((res.meta?.changes ?? 0) === 0) return c.json({ error: 'Task not found' }, 404)
  return c.json({ success: true })
})
