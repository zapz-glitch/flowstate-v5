/**
 * SSE Stream Route
 *
 * Streams enrichment events from the AnalysisJobDO to dashboard clients.
 * Creates SSE stream in the Worker and reads events from the DO state.
 * The DO runs enrichment in its persistent context; this route streams results.
 */

import { Hono } from 'hono'
import type { Env } from '../types'
import { verifySseToken } from '../utils/sse-token'

const sseStream = new Hono<{ Bindings: Env }>()

sseStream.get('/analyze/:jobId', async (c) => {
  const jobId = c.req.param('jobId')
  const token = c.req.query('token')

  if (!token) {
    return new Response(JSON.stringify({ error: 'Missing token' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const secret = c.env.BETTER_AUTH_SECRET || ''
  const payload = await verifySseToken(secret, token)
  if (!payload || payload.jobId !== jobId) {
    return new Response(JSON.stringify({ error: 'Invalid token' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  // CORS
  const origin = c.req.header('Origin') || ''
  const allowed = ['http://localhost:3000']
  if (c.env.DASHBOARD_URL) allowed.push(c.env.DASHBOARD_URL)
  const allowedOrigin = allowed.includes(origin) ? origin : allowed[0]

  const doId = c.env.ANALYSIS_JOB.idFromName(jobId)
  const stub = c.env.ANALYSIS_JOB.get(doId)

  // Create SSE stream in the Worker — read events from the DO
  const { readable, writable } = new TransformStream()
  const writer = writable.getWriter()
  const encoder = new TextEncoder()

  const sendSSE = async (event: string, data: unknown) => {
    await writer.write(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
  }

  // Background: poll DO state and stream events
  ;(async () => {
    let lastEventCount = 0
    await sendSSE('connected', { jobId })

    for (let i = 0; i < 600; i++) { // max 5 minutes
      try {
        const resp = await stub.fetch('http://internal/state')
        if (!resp.ok) {
          await new Promise((r) => setTimeout(r, 500))
          continue
        }

        const state = await resp.json() as {
          status?: string
          events?: Array<{ event: string; data: unknown }>
        }

        if (!state.status || state.status === 'not_found') {
          await new Promise((r) => setTimeout(r, 500))
          continue
        }

        // Stream new events
        const events = state.events ?? []
        for (let j = lastEventCount; j < events.length; j++) {
          await sendSSE(events[j].event, events[j].data)
        }
        lastEventCount = events.length

        // Done
        if (state.status === 'complete' || state.status === 'error') {
          break
        }
      } catch {
        // DO not ready yet
      }

      await new Promise((r) => setTimeout(r, 500))
    }

    await sendSSE('enrichment_done', { finished: true })
    writer.close()
  })()

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': allowedOrigin,
      'Access-Control-Allow-Credentials': 'true',
    },
  })
})

// ─── Batch SSE Stream ─────────────────────────────────────────────────────

sseStream.get('/batch/:batchId', async (c) => {
  const batchId = c.req.param('batchId')
  const token = c.req.query('token')

  if (!token) {
    return new Response(JSON.stringify({ error: 'Missing token' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const secret = c.env.BETTER_AUTH_SECRET || ''
  const payload = await verifySseToken(secret, token)
  if (!payload || payload.jobId !== batchId) {
    return new Response(JSON.stringify({ error: 'Invalid token' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  // CORS
  const origin = c.req.header('Origin') || ''
  const allowed = ['http://localhost:3000']
  if (c.env.DASHBOARD_URL) allowed.push(c.env.DASHBOARD_URL)
  const allowedOrigin = allowed.includes(origin) ? origin : allowed[0]

  const doId = c.env.BATCH_JOB.idFromName(batchId)
  const stub = c.env.BATCH_JOB.get(doId)

  // Proxy SSE from the BatchJobDO
  const doResp = await stub.fetch('http://internal/sse', {
    signal: c.req.raw.signal,
  })

  return new Response(doResp.body, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': allowedOrigin,
      'Access-Control-Allow-Credentials': 'true',
    },
  })
})

export default sseStream
