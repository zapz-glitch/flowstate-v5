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

  // Create SSE stream in the Worker — read events from the DO
  const { readable, writable } = new TransformStream()
  const writer = writable.getWriter()
  const encoder = new TextEncoder()

  const sendSSE = async (event: string, data: unknown) => {
    await writer.write(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
  }

  const POLL_INTERVAL_MS = 500
  const MAX_POLLS = 600 // 5 minutes
  const MAX_CONSECUTIVE_FETCH_FAILURES = 20 // 10 seconds of the DO throwing

  // Background: poll DO state and stream events
  ;(async () => {
    let lastEventCount = 0
    let terminalStatus: 'complete' | 'error' | null = null
    let consecutiveFetchFailures = 0
    let lastFetchError: string | null = null
    await sendSSE('connected', { jobId })

    for (let i = 0; i < MAX_POLLS; i++) {
      try {
        const resp = await stub.fetch('http://internal/state')
        consecutiveFetchFailures = 0
        if (!resp.ok) {
          await resp.text() // DO not initialized yet (404) — consume body
        } else {
          const state = await resp.json() as {
            status?: string
            events?: Array<{ event: string; data: unknown }>
          }

          const events = state.events ?? []
          for (let j = lastEventCount; j < events.length; j++) {
            await sendSSE(events[j].event, events[j].data)
          }
          lastEventCount = events.length

          if (state.status === 'complete' || state.status === 'error') {
            terminalStatus = state.status
            break
          }
        }
      } catch (err) {
        consecutiveFetchFailures++
        lastFetchError = err instanceof Error ? err.message : String(err)
        console.warn(`[SSE] AnalysisJobDO state fetch failed (${consecutiveFetchFailures}/${MAX_CONSECUTIVE_FETCH_FAILURES}) for job ${jobId}: ${lastFetchError}`)
        if (consecutiveFetchFailures >= MAX_CONSECUTIVE_FETCH_FAILURES) {
          break
        }
      }

      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
    }

    if (terminalStatus) {
      await sendSSE('enrichment_done', { finished: true, status: terminalStatus })
    } else if (consecutiveFetchFailures >= MAX_CONSECUTIVE_FETCH_FAILURES) {
      console.error(`[SSE] AnalysisJobDO unreachable for job ${jobId}: ${lastFetchError}`)
      await sendSSE('error', { step: 'stream', message: 'Analysis job is unreachable. Please retry the analysis.' })
      await sendSSE('enrichment_done', { finished: false, reason: 'unreachable' })
    } else {
      console.error(`[SSE] Analysis job ${jobId} did not reach a terminal state within ${(MAX_POLLS * POLL_INTERVAL_MS) / 1000}s`)
      await sendSSE('error', { step: 'timeout', message: 'Analysis did not complete in time. Please retry the analysis.' })
      await sendSSE('enrichment_done', { finished: false, reason: 'timeout' })
    }
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
