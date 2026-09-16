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
import dealParamsRoute from './routes/deal-params'
import { uiPrefsRoute } from './routes/ui-prefs'
import { tasksRoute } from './routes/tasks'
import locationSettingsRoute from './routes/location-settings'
import majorItemCostsRoute from './routes/major-item-costs'
import reportsRoute from './routes/reports'
import batchRoute from './routes/batch'
import ghlSettingsRoute from './routes/ghl-settings'
import userReportsRoute from './routes/user-reports'
import reportAssetsRoute from './routes/report-assets'
import waitlistRoute from './routes/waitlist'
import adminRoute from './routes/admin'
// Vision analysis removed
import arvThresholdRoute from './routes/arv-threshold'
import proximityConfigRoute from './routes/proximity-config'
import typeaheadRoute from './routes/typeahead'
import compSelectionRoute from './routes/comp-selection'
import mlExportRoute from './routes/ml-export'
import sseStream from './routes/sse-stream'
import ghlWebhook from './routes/webhooks/ghl'
import { sweepStaleBatches } from './services/batch-queue'

type Variables = { auth: AuthContext }

const app = new Hono<{ Bindings: Env; Variables: Variables }>()

// Global middleware
app.use('*', logger())
app.use(
  '*',
  cors({
    origin: (origin, c) => {
      if (!origin) return ''
      if (c.env.DASHBOARD_URL) return origin === c.env.DASHBOARD_URL ? origin : ''
      // Allow localhost, any *.flowstate.homes subdomain, and flowstate.homes itself
      if (origin === 'http://localhost:3000') return origin
      if (/^https:\/\/([\w-]+\.)?flowstate\.homes$/.test(origin)) return origin
      return ''
    },
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'X-Dashboard-User-Id', 'X-Dashboard-Secret', 'X-Impersonate-User-Id'],
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

// Proximity adjustment config routes (session auth via Better Auth cookies)
app.route('/proximity-config', proximityConfigRoute)

// UI prefs routes (session auth via Better Auth cookies)
app.route('/ui-prefs', uiPrefsRoute)

// Tasks routes (session auth via Better Auth cookies)
app.route('/tasks', tasksRoute)

// Batch analysis routes (session auth via Better Auth cookies)
app.route('/batch', batchRoute)

// GHL integration settings routes (session auth via Better Auth cookies)
app.route('/ghl-settings', ghlSettingsRoute)

// User reports routes (session auth via Better Auth cookies)
app.route('/user/reports', userReportsRoute)
app.route('/user/reports', reportAssetsRoute)

// Waitlist routes (no auth)
app.route('/waitlist', waitlistRoute)

// Admin routes (session auth + admin role check inside routes)
app.route('/admin', adminRoute)

// ARV threshold routes (session auth via Better Auth cookies)
app.route('/arv-threshold', arvThresholdRoute)

// Address typeahead routes (session auth via Better Auth cookies)
app.route('/typeahead', typeaheadRoute)

// Comp selection (session-authenticated, LLM-only)
app.route('/comp-selection', compSelectionRoute)

// SSE stream routes (token-authenticated)
app.route('/sse', sseStream)

// GHL webhook routes (self-authenticating via URL secret, no auth middleware)
app.route('/webhooks/ghl', ghlWebhook)

// Public reports (no auth - jobId is unguessable)
app.route('/reports', reportsRoute)

// API v1 routes (require API key auth)
const v1 = new Hono<{ Bindings: Env; Variables: Variables }>()
v1.use('*', authMiddleware)
v1.route('/analyze', analyze)
v1.route('/ml', mlExportRoute)

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

// Export Durable Object classes
export { AnalysisJobDO, BatchJobDO, RateLimitCoordinatorDO } from './durable-objects'

// Export worker
export default {
  fetch: app.fetch,
  // Cron (every 5 min): revive dead batch jobs and stranded queues so lists
  // run unattended to completion — no one needs the dashboard open
  scheduled: (_event: ScheduledEvent, env: Env, ctx: ExecutionContext) => {
    ctx.waitUntil(sweepStaleBatches(env))
  },
}
