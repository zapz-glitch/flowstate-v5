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
import rehabConfigRoute from './routes/rehab-config'
import rehabConfigV1 from './routes/rehab-config-v1'
import dealParamsRoute from './routes/deal-params'
import locationSettingsRoute from './routes/location-settings'
import majorItemCostsRoute from './routes/major-item-costs'
import comments from './routes/comments'
import sseStream from './routes/sse-stream'
import reportsRoute from './routes/reports'
import ghlSettingsRoute from './routes/ghl-settings'
import userReportsRoute from './routes/user-reports'
import ghlWebhook from './routes/webhooks/ghl'

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

// Rehab config routes (session auth via Better Auth cookies)
app.route('/rehab-config', rehabConfigRoute)

// Deal params routes (session auth via Better Auth cookies)
app.route('/deal-params', dealParamsRoute)

// Location settings routes (session auth via Better Auth cookies)
app.route('/location-settings', locationSettingsRoute)

// Major item costs routes (session auth via Better Auth cookies)
app.route('/major-item-costs', majorItemCostsRoute)

// Comments routes (session auth via Better Auth cookies)
app.route('/comments', comments)

// GHL integration settings routes (session auth via Better Auth cookies)
app.route('/ghl-settings', ghlSettingsRoute)

// User reports routes (session auth via Better Auth cookies)
app.route('/user/reports', userReportsRoute)

// GHL webhook routes (self-authenticating via URL secret, no auth middleware)
app.route('/webhooks/ghl', ghlWebhook)

// SSE stream routes (handles its own auth via signed tokens)
// Mounted outside /v1 because EventSource can't set custom headers
app.route('/sse', sseStream)

// Public reports (no auth - jobId is unguessable)
app.route('/reports', reportsRoute)

// API v1 routes (require API key auth)
const v1 = new Hono<{ Bindings: Env; Variables: Variables }>()
v1.use('*', authMiddleware)
v1.route('/analyze', analyze)
v1.route('/rehab-config', rehabConfigV1)

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
