/**
 * Cloudflare Context Utilities
 *
 * In Cloudflare Workers with OpenNext, environment variables are accessed
 * via getCloudflareContext, not process.env.
 *
 * Development options:
 * - `npm run preview` - Full Cloudflare emulation (slower, no hot reload)
 * - `npm run dev` - Hot reload with .env.local fallback
 */

export interface CloudflareEnv {
  DB?: D1Database
  DASHBOARD_INTERNAL_SECRET?: string
  BETTER_AUTH_SECRET?: string
  [key: string]: unknown
}

/**
 * Get the Cloudflare environment bindings (async).
 * Works in production, `npm run preview`, and `npm run dev` (with .env.local fallback).
 */
export async function getCloudflareEnv(): Promise<CloudflareEnv> {
  // Try Cloudflare context first (works in production and `npm run preview`)
  let cloudflareEnv: CloudflareEnv = {}
  try {
    const { getCloudflareContext } = await import('@opennextjs/cloudflare')
    const { env } = await getCloudflareContext({ async: true })
    if (env && Object.keys(env).length > 0) {
      cloudflareEnv = env as CloudflareEnv
    }
  } catch {
    // Cloudflare context not available
  }

  // Fallback to process.env for `npm run dev` with hot reload
  // Reads from .env.local
  return {
    ...cloudflareEnv,
    DASHBOARD_INTERNAL_SECRET: cloudflareEnv.DASHBOARD_INTERNAL_SECRET ?? process.env.DASHBOARD_INTERNAL_SECRET,
    BETTER_AUTH_SECRET: cloudflareEnv.BETTER_AUTH_SECRET ?? process.env.BETTER_AUTH_SECRET,
  }
}

/**
 * Get the D1 database binding from the Cloudflare context (async).
 * Only works in production or `npm run preview` (not `npm run dev`).
 */
export async function getD1(): Promise<D1Database> {
  const env = await getCloudflareEnv()
  if (!env.DB) {
    throw new Error('D1 database not available. Use `npm run preview` for database access.')
  }
  return env.DB
}

/**
 * Get a specific environment variable from Cloudflare context.
 */
export async function getEnvVar(key: string): Promise<string | undefined> {
  const env = await getCloudflareEnv()
  return env[key] as string | undefined
}
