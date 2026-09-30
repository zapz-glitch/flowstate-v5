#!/usr/bin/env node
// attom-mcp.mjs — drive the ATTOM MCP server from the CLI.
//
//   node scripts/attom-mcp.mjs "16049 Magnolia Hill St, Clermont, FL 34714"
//   node scripts/attom-mcp.mjs "<address>" --datasets identity,overview,valuation
//   node scripts/attom-mcp.mjs "<address>" --raw        # dump raw JSON-RPC result
//
// Auth: reuses the Devin CLI OAuth tokens in ~/.local/share/devin/mcp/oauth/
// (created by `devin mcp login attom`). Access tokens live ~10 min; the
// refresh token rotates on each refresh, so this script refreshes first and
// writes the rotated pair back to the same file.
//
// Full JSON output is saved to .data/attom-mcp/<slug>-<ts>.json as the
// repeatable verification artifact.

import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const MCP_URL = 'https://mcp.intelligence.attomdata.com'
const TOKEN_URL = 'https://auth.intelligence.attomdata.com/oauth2/v1/apps/token'
const OAUTH_DIR = join(homedir(), '.local/share/devin/mcp/oauth')
const OUT_DIR = new URL('../.data/attom-mcp/', import.meta.url).pathname
const UA = 'Mozilla/5.0 (X11; Linux x86_64) attom-mcp-cli/0.1'

const DEFAULT_DATASETS = [
  'identity', 'overview', 'valuation', 'comparables',
  'permits', 'fema-context', 'sales-history', 'tax-history',
]

// --- auth ------------------------------------------------------------------

export function loadCreds() {
  for (const f of readdirSync(OAUTH_DIR)) {
    if (!f.endsWith('.json')) continue
    const p = join(OAUTH_DIR, f)
    try {
      const d = JSON.parse(readFileSync(p, 'utf8'))
      if (d.url?.includes('attomdata') && d.refresh_token) return { path: p, ...d }
    } catch { /* skip malformed */ }
  }
  throw new Error(`No ATTOM OAuth creds in ${OAUTH_DIR} — run: devin mcp login attom`)
}

export async function refreshToken(creds) {
  const resp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: creds.refresh_token,
      client_id: creds.client_id,
    }),
  })
  const body = await resp.json()
  if (!resp.ok) throw new Error(`token refresh failed ${resp.status}: ${JSON.stringify(body)}`)
  const next = {
    ...creds,
    access_token: body.access_token,
    refresh_token: body.refresh_token ?? creds.refresh_token,
    expires_at: Math.floor(Date.now() / 1000) + (body.expires_in ?? 600),
  }
  const { path, ...persist } = next
  writeFileSync(path, JSON.stringify(persist))
  return next
}

export async function getToken() {
  const creds = loadCreds()
  if (creds.expires_at > Date.now() / 1000 + 30) return creds.access_token
  console.error('access token expired — refreshing via Descope')
  return (await refreshToken(creds)).access_token
}

// --- mcp -------------------------------------------------------------------

export async function rpc(token, method, params) {
  const resp = await fetch(MCP_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${token}`,
      'User-Agent': UA,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const text = await resp.text()
  if (!resp.ok) throw new Error(`MCP ${method} -> HTTP ${resp.status}: ${text.slice(0, 300)}`)
  // streamable-HTTP servers may answer SSE; take the last data: payload
  const dataLine = text.split('\n').filter((l) => l.startsWith('data:')).pop()
  const json = JSON.parse(dataLine ? dataLine.slice(5).trim() : text)
  if (json.error) throw new Error(`MCP ${method} -> ${json.error.code}: ${json.error.message}`)
  return json.result
}

// --- main ------------------------------------------------------------------

import { fileURLToPath } from 'node:url'
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) main()

async function main() {
const args = process.argv.slice(2)
const raw = args.includes('--raw')
const dsFlag = args.indexOf('--datasets')
const datasets = dsFlag >= 0 ? args[dsFlag + 1].split(',') : DEFAULT_DATASETS
const address = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--datasets')[0]

if (!address) {
  console.error('usage: node scripts/attom-mcp.mjs "<address>" [--datasets a,b,c] [--raw]')
  process.exit(1)
}

const token = await getToken()
console.error(`resolving + fetching [${datasets.join(', ')}] for: ${address}`)

const result = await rpc(token, 'tools/call', {
  name: 'get_property_data',
  arguments: {
    property: { lookupMode: 'address', address },
    datasets,
  },
})

mkdirSync(OUT_DIR, { recursive: true })
const slug = address.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 50)
const outPath = join(OUT_DIR, `${slug}-${Date.now()}.json`)
writeFileSync(outPath, JSON.stringify({ address, datasets, result }, null, 2))

if (raw) {
  console.log(JSON.stringify(result, null, 2))
} else {
  for (const c of result.content ?? []) {
    if (c.type === 'text') console.log(c.text)
    else if (c.type === 'resource_link') console.log(`\n→ resource: ${c.uri}`)
  }
  if (result.structuredContent) {
    console.log('\n--- structuredContent ---')
    console.log(JSON.stringify(result.structuredContent, null, 2))
  }
}
console.error(`\nartifact: ${outPath}`)
}
