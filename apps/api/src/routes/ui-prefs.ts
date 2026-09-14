import { Hono } from 'hono'
import { drizzle } from 'drizzle-orm/d1'
import { eq } from 'drizzle-orm'
import { uiPrefs } from '../db'
import { getSession } from '../lib/session'
import { withDbRetry } from '../lib/db-retry'
import type { Env } from '../types'

export const uiPrefsRoute = new Hono<{ Bindings: Env }>()

interface UiPrefsShape {
  navLabels: Record<string, string>
  navOrder: string[]
  navHidden: string[]
  customLinks: Array<{ label: string; url: string }>
  faviconUrl: string | null
}

function sanitize(body: Record<string, unknown>): UiPrefsShape {
  const navLabels: Record<string, string> = {}
  if (body.navLabels && typeof body.navLabels === 'object') {
    for (const [href, label] of Object.entries(body.navLabels as Record<string, unknown>)) {
      if (typeof href === 'string' && typeof label === 'string' && label.trim()) {
        navLabels[href] = label.trim().slice(0, 60)
      }
    }
  }
  const customLinks: Array<{ label: string; url: string }> = []
  if (Array.isArray(body.customLinks)) {
    for (const link of body.customLinks.slice(0, 10)) {
      if (
        link && typeof link === 'object' &&
        typeof (link as { label?: unknown }).label === 'string' &&
        typeof (link as { url?: unknown }).url === 'string' &&
        /^(https?:\/\/|\/)/.test((link as { url: string }).url)
      ) {
        customLinks.push({
          label: (link as { label: string }).label.trim().slice(0, 60),
          url: (link as { url: string }).url.trim().slice(0, 500),
        })
      }
    }
  }
  const faviconUrl =
    typeof body.faviconUrl === 'string' && /^(https?:\/\/|\/)/.test(body.faviconUrl)
      ? body.faviconUrl.slice(0, 500)
      : null
  const navOrder = Array.isArray(body.navOrder)
    ? body.navOrder.filter((h): h is string => typeof h === 'string' && h.startsWith('/')).slice(0, 30)
    : []
  const navHidden = Array.isArray(body.navHidden)
    ? body.navHidden.filter((h): h is string => typeof h === 'string' && h.startsWith('/')).slice(0, 30)
    : []
  return { navLabels, navOrder, navHidden, customLinks, faviconUrl }
}

uiPrefsRoute.get('/', async (c) => {
  const session = await getSession(c)
  if (!session?.user) return c.json({ error: 'Not authenticated' }, 401)
  const db = drizzle(c.env.DB)
  const [row] = await db.select().from(uiPrefs).where(eq(uiPrefs.userId, session.user.id)).limit(1)
  return c.json({
    navLabels: row?.navLabelsJson ? JSON.parse(row.navLabelsJson) : {},
    navOrder: row?.navOrderJson ? JSON.parse(row.navOrderJson) : [],
    navHidden: row?.navHiddenJson ? JSON.parse(row.navHiddenJson) : [],
    customLinks: row?.customLinksJson ? JSON.parse(row.customLinksJson) : [],
    faviconUrl: row?.faviconUrl ?? null,
  })
})

uiPrefsRoute.put('/', async (c) => {
  const session = await getSession(c)
  if (!session?.user) return c.json({ error: 'Not authenticated' }, 401)
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
  const prefs = sanitize(body)
  const db = drizzle(c.env.DB)
  const values = {
    userId: session.user.id,
    navLabelsJson: JSON.stringify(prefs.navLabels),
    navOrderJson: JSON.stringify(prefs.navOrder),
    navHiddenJson: JSON.stringify(prefs.navHidden),
    customLinksJson: JSON.stringify(prefs.customLinks),
    faviconUrl: prefs.faviconUrl,
    updatedAt: new Date().toISOString(),
  }
  const [existing] = await withDbRetry(() => db.select({ id: uiPrefs.id }).from(uiPrefs).where(eq(uiPrefs.userId, session.user.id)).limit(1))
  if (existing) {
    await withDbRetry(() => db.update(uiPrefs).set(values).where(eq(uiPrefs.id, existing.id)))
  } else {
    await withDbRetry(() => db.insert(uiPrefs).values(values))
  }
  return c.json({ success: true, ...prefs })
})
