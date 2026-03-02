/**
 * Flowstate API - Property Valuation & Underwriting API
 *
 * Cloudflare Worker with Hono
 */

import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import type { Env } from './types'
import type { AuthContext } from './middleware/auth'
import { authMiddleware } from './middleware/auth'

// Routes
import health from './routes/health'
import auth from './routes/auth'
import user from './routes/user'
import analyze from './routes/analyze'
import appraisalRules from './routes/appraisal-rules'
import comments from './routes/comments'
import wsStream from './routes/ws-stream'

// Durable Objects
export { AnalysisJobDO, RateLimitCoordinatorDO, FirecrawlRateLimiterDO } from './durable-objects'

// Workflows
export { AnalysisWorkflow } from './workflows'

type Variables = { auth: AuthContext }

const app = new Hono<{ Bindings: Env; Variables: Variables }>()

// Global middleware
app.use('*', logger())
app.use(
  '*',
  cors({
    origin: [
      'http://localhost:3000',
      'https://dashboard.flowstate.homes',
      'https://app.flowstate.homes',
    ],
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'X-Dashboard-User-Id', 'X-Dashboard-Secret'],
    exposeHeaders: ['X-Request-Id', 'X-RateLimit-Remaining', 'X-RateLimit-Limit', 'X-RateLimit-Reset'],
    credentials: true,
    maxAge: 86400,
  })
)

// Root endpoint
app.get('/', (c) => {
  return c.json({
    name: 'Flowstate API',
    version: '1.0.0',
    docs: 'https://docs.flowstate.homes',
    endpoints: {
      health: '/health',
      auth: '/auth/*',
      user: '/user',
      apiKeys: '/user/api-keys',
      usage: '/user/usage',
      appraisalPresets: '/appraisal-presets',
      analyze: '/v1/analyze',
    },
  })
})

// Health routes (no auth)
app.route('/health', health)

// Auth routes (no auth required - handled by Better Auth)
app.route('/auth', auth)

// User routes (session auth via Better Auth cookies)
app.route('/user', user)

// Appraisal rules routes (session auth via Better Auth cookies)
app.route('/appraisal-presets', appraisalRules)

// Comments routes (session auth via Better Auth cookies)
app.route('/comments', comments)

// WebSocket routes (handles its own auth via signed tokens)
// Mounted outside /v1 because browsers can't set headers on WebSocket connections
app.route('/ws', wsStream)

// API v1 routes (require API key auth)
const v1 = new Hono<{ Bindings: Env; Variables: Variables }>()
v1.use('*', authMiddleware)
v1.route('/analyze', analyze)

app.route('/v1', v1)

// 404 handler
app.notFound((c) => {
  return c.json(
    {
      success: false,
      error: 'Not found',
      path: c.req.path,
    },
    404
  )
})

// Error handler
app.onError((err, c) => {
  console.error('Unhandled error:', err)
  return c.json(
    {
      success: false,
      error: 'Internal server error',
      message: err instanceof Error ? err.message : 'Unknown error',
    },
    500
  )
})

// Export worker
export default {
  fetch: app.fetch,
}
