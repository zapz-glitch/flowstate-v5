#!/usr/bin/env node
// sync-attom-token.mjs — refresh the ATTOM OAuth pair and inject it into
// apps/api/.dev.vars as ATTOM_MCP_* env vars so the wrangler Worker can use
// the MCP provider (PROPERTY_PROVIDER=attom-mcp).
//
// Run before `npm run dev`, or any time MCP calls in the API start 401ing:
//   node scripts/sync-attom-token.mjs
//
// The OAuth refresh token rotates on every refresh — this script persists
// the rotated pair back to the Devin creds file AND into .dev.vars.

import { readFileSync, writeFileSync } from 'node:fs'
import { loadCreds, refreshToken } from './attom-mcp.mjs'

const DEV_VARS = new URL('../apps/api/.dev.vars', import.meta.url).pathname

const creds = loadCreds()
const fresh = await refreshToken(creds)
console.log('refreshed — access token good for ~10 min, refresh token rotated')

// rewrite .dev.vars in place: replace or append the ATTOM_MCP_* lines
let text = ''
try {
  text = readFileSync(DEV_VARS, 'utf8')
} catch {
  console.error(`no ${DEV_VARS} — creating`)
}
const vars = {
  PROPERTY_PROVIDER: 'attom-mcp',
  ATTOM_MCP_ACCESS_TOKEN: fresh.access_token,
  ATTOM_MCP_REFRESH_TOKEN: fresh.refresh_token,
  ATTOM_MCP_CLIENT_ID: fresh.client_id,
  ATTOM_MCP_EXPIRES_AT: String(fresh.expires_at),
}
for (const [k, v] of Object.entries(vars)) {
  const re = new RegExp(`^${k}=.*$`, 'm')
  text = re.test(text) ? text.replace(re, `${k}=${v}`) : `${text.trimEnd()}\n${k}=${v}\n`
}
writeFileSync(DEV_VARS, text)
console.log('wrote ATTOM_MCP_* + PROPERTY_PROVIDER=attom-mcp to apps/api/.dev.vars')
console.log('restart `npm run dev` (or just the API) so wrangler picks up the vars')
