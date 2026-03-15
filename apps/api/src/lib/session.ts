/**
 * Shared Session Helper
 *
 * Provides getSession() with admin impersonation support.
 * When an admin sends X-Impersonate-User-Id header, the returned session
 * has the impersonated user's ID instead of the admin's.
 */

import { drizzle } from 'drizzle-orm/d1'
import { eq } from 'drizzle-orm'
import { createAuth } from './auth'
import { users } from '../db'

export interface SessionResult {
  user: {
    id: string
    email: string
    name: string
    [key: string]: unknown
  }
  session: unknown
}

/**
 * Get the authenticated session from the request.
 * If the caller is an admin with X-Impersonate-User-Id header,
 * the returned session.user.id is swapped to the impersonated user.
 */
export async function getSession(c: any): Promise<SessionResult | null> {
  const url = new URL(c.req.url)
  const baseURL = `${url.protocol}//${url.host}/auth`
  const auth = createAuth(c.env.DB, c.env.BETTER_AUTH_SECRET, baseURL)

  try {
    const session = await auth.api.getSession({ headers: c.req.raw.headers })
    if (!session?.user) return null

    // Check for impersonation header
    const impersonateUserId = c.req.raw.headers.get('x-impersonate-user-id')
    if (impersonateUserId) {
      const db = drizzle(c.env.DB)

      // Verify caller is admin
      const [adminUser] = await db.select({ role: users.role })
        .from(users)
        .where(eq(users.id, session.user.id))
        .limit(1)

      if (!adminUser || adminUser.role !== 'admin') {
        console.warn(`Non-admin ${session.user.email} attempted impersonation`)
        return session as SessionResult
      }

      // Verify target user exists
      const [targetUser] = await db.select({
        id: users.id,
        email: users.email,
        name: users.name,
      }).from(users).where(eq(users.id, impersonateUserId)).limit(1)

      if (!targetUser) {
        console.warn(`Admin ${session.user.email} tried to impersonate non-existent user ${impersonateUserId}`)
        return session as SessionResult
      }

      console.log(`Admin ${session.user.email} impersonating ${targetUser.email}`)

      // Return session with swapped user ID
      return {
        ...session,
        user: {
          ...session.user,
          id: targetUser.id,
          email: targetUser.email,
          name: targetUser.name,
        },
      } as SessionResult
    }

    return session as SessionResult
  } catch (error) {
    console.error('Error getting session:', error)
    return null
  }
}
