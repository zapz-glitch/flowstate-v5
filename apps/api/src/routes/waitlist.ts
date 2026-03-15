import { Hono } from 'hono'
import { drizzle } from 'drizzle-orm/d1'
import { z } from 'zod'
import type { Env } from '../types'
import { waitlist } from '../db/schema'

const app = new Hono<{ Bindings: Env }>()

const waitlistSchema = z.object({
  email: z.string().email('Invalid email address'),
  firstName: z.string().min(1, 'First name is required').max(100),
  lastName: z.string().min(1, 'Last name is required').max(100),
})

app.post('/', async (c) => {
  const body = await c.req.json().catch(() => null)
  if (!body) {
    return c.json({ success: false, error: 'Invalid request body' }, 400)
  }

  const parsed = waitlistSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ success: false, error: parsed.error.issues[0].message }, 400)
  }

  const { email, firstName, lastName } = parsed.data
  const db = drizzle(c.env.DB)

  try {
    await db.insert(waitlist).values({
      email: email.toLowerCase(),
      firstName,
      lastName,
    })
  } catch (err: unknown) {
    // Unique constraint violation — already on waitlist
    if (err instanceof Error && err.message.includes('UNIQUE')) {
      return c.json({ success: true, message: 'You\'re already on the waitlist!' })
    }
    throw err
  }

  return c.json({ success: true, message: 'You\'ve been added to the waitlist!' })
})

export default app
