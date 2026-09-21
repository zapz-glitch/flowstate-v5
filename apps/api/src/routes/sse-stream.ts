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

  // CORS — match global pattern (localhost + *.flowstate.homes)
  const origin = c.req.header('Origin') || ''
  const allowedOrigin = origin === 'http://localhost:3000' ? origin
    : /^https:\/\/([\w-]+\.)?flowstate\.homes$/.test(origin) ? origin
    : 'http://localhost:3000'

  const doId = c.env.ANALYSIS_JOB.idFromName(jobId)
  const stub = c.env.ANALYSIS_JOB.get(doId)

  // Proxy the DO's push stream (same as /sse/batch): events reach clients in
  // real time, the DO replays buffered events for late joiners, and the open
  // fetch keeps the DO alive while a run is in flight. Holding the client
  // signal lets a disconnect propagate and clean up the DO-side writer.
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

  // CORS — match global pattern (localhost + *.flowstate.homes)
  const origin = c.req.header('Origin') || ''
  const allowedOrigin = origin === 'http://localhost:3000' ? origin
    : /^https:\/\/([\w-]+\.)?flowstate\.homes$/.test(origin) ? origin
    : 'http://localhost:3000'

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
