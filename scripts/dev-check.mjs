#!/usr/bin/env node
// Dev environment verification — run after starting `npm run dev`.
// Catches the recurring localhost breakers: missing keys, dead servers,
// broken login, Google Maps referrer blocks, bad provider credentials.
//
//   node scripts/dev-check.mjs            verify everything
//   node scripts/dev-check.mjs --fix-login  also reset the local test
//     account password + clear the IP lockout (repairs local login)
//
// Exit code 0 = all green, 1 = something failed.

import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs'
import { execSync } from 'child_process'
import { scryptSync, randomBytes } from 'crypto'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const API_URL = 'http://localhost:8787'
const DASH_URL = 'http://localhost:3000'
const FIX_LOGIN = process.argv.includes('--fix-login')

let failures = 0
const ok = (msg) => console.log(`  ✓ ${msg}`)
const fail = (msg) => { failures++; console.log(`  ✗ ${msg}`) }
const warn = (msg) => console.log(`  ~ ${msg}`)

// --- env file parsing -------------------------------------------------------
function parseEnvFile(path) {
  const vars = {}
  if (!existsSync(path)) return null
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*"?([^"\n]*)"?/)
    if (m) vars[m[1]] = m[2]
  }
  return vars
}

// --- checks -----------------------------------------------------------------
console.log('\n[1] Env files')

const apiVars = parseEnvFile(join(ROOT, 'apps/api/.dev.vars'))
const REQUIRED_API = [
  'BETTER_AUTH_SECRET',
  'DASHBOARD_INTERNAL_SECRET',
  'DASHBOARD_URL',
  'CORELOGIC_CLIENT_ID',
  'CORELOGIC_CLIENT_SECRET',
  'FIRECRAWL_API_KEY',
  'OPENROUTER_API_KEY',
]
if (!apiVars) {
  fail('apps/api/.dev.vars missing — copy it from the main checkout')
} else {
  const missing = REQUIRED_API.filter((k) => !apiVars[k])
  missing.length ? fail(`.dev.vars missing keys: ${missing.join(', ')}`) : ok('.dev.vars has all required keys')
  if (apiVars.DASHBOARD_URL !== DASH_URL)
    warn(`.dev.vars DASHBOARD_URL is ${apiVars.DASHBOARD_URL} — CORS expects ${DASH_URL}`)
}

const dashVars = parseEnvFile(join(ROOT, 'apps/dashboard/.env.local'))
const REQUIRED_DASH = [
  'NEXT_PUBLIC_API_URL',
  'NEXT_PUBLIC_GOOGLE_MAP_KEY',
  'BETTER_AUTH_SECRET',
  'DASHBOARD_INTERNAL_SECRET',
]
if (!dashVars) {
  fail('apps/dashboard/.env.local missing — copy it from the main checkout')
} else {
  const missing = REQUIRED_DASH.filter((k) => !dashVars[k])
  missing.length ? fail(`.env.local missing keys: ${missing.join(', ')}`) : ok('.env.local has all required keys')
  if (dashVars.NEXT_PUBLIC_API_URL !== API_URL)
    warn(`NEXT_PUBLIC_API_URL is ${dashVars.NEXT_PUBLIC_API_URL} — expected ${API_URL}`)
}

if (apiVars && dashVars) {
  for (const key of ['BETTER_AUTH_SECRET', 'DASHBOARD_INTERNAL_SECRET']) {
    if (apiVars[key] && dashVars[key] && apiVars[key] !== dashVars[key])
      fail(`${key} differs between .dev.vars and .env.local — sessions/dashboard calls will fail`)
  }
  if (!failures) ok('shared secrets match between API and dashboard')
}

// --- servers ----------------------------------------------------------------
console.log('\n[2] Servers')

async function get(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(5000) })
    return { status: r.status, body: await r.text() }
  } catch {
    return null
  }
}

const apiHealth = await get(`${API_URL}/health`)
apiHealth?.status === 200 ? ok(`API healthy on ${API_URL}`) : fail(`API not responding on ${API_URL} — run: cd apps/api && npm run dev`)

const dashHealth = await get(DASH_URL)
dashHealth && dashHealth.status < 500 ? ok(`Dashboard responding on ${DASH_URL}`) : fail(`Dashboard not responding on ${DASH_URL} — run: cd apps/dashboard && npm run dev`)

// --- auth -------------------------------------------------------------------
console.log('\n[3] Login')

const loginFile = join(ROOT, '.data/local-candidate/login.json')
const creds = existsSync(loginFile) ? JSON.parse(readFileSync(loginFile, 'utf8')) : null
if (!creds) {
  warn('no recorded local credential (.data/local-candidate/login.json) — skipping sign-in check')
} else if (apiHealth?.status === 200) {
  const res = await fetch(`${API_URL}/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: DASH_URL },
    body: JSON.stringify({ email: creds.email, password: creds.password }),
  })
  const body = await res.json().catch(() => ({}))
  if (res.status === 200 && body.token) {
    ok(`sign-in works for ${creds.email}`)
  } else if (res.status === 429) {
    fail(`IP locked out — fix with: node scripts/dev-check.mjs --fix-login`)
  } else {
    fail(`sign-in failed (${res.status} ${body.code || ''}) — fix with: node scripts/dev-check.mjs --fix-login`)
  }
} else {
  warn('API down — skipping sign-in check')
}

if (FIX_LOGIN && creds && apiHealth?.status === 200) {
  // Re-hash the recorded password (Better Auth scrypt params) and write it
  // back; clear login_failures so the IP lockout releases immediately.
  const salt = randomBytes(16).toString('hex')
  const key = scryptSync(creds.password.normalize('NFKC'), salt, 64, {
    N: 16384, r: 16, p: 1, maxmem: 128 * 16384 * 16 * 2,
  })
  const hash = `${salt}:${key.toString('hex')}`
  const sqlFile = join(ROOT, '.dev-check-login.sql')
  writeFileSync(sqlFile, `
UPDATE account SET password='${hash}'
  WHERE providerId='credential'
    AND userId=(SELECT id FROM user WHERE email='${creds.email}');
DELETE FROM login_failures;
`)
  try {
    execSync(`npx wrangler d1 execute DB --local --config wrangler.local.toml --file "${sqlFile}"`, {
      cwd: join(ROOT, 'apps/api'), stdio: 'pipe',
    })
    ok(`reset password for ${creds.email} and cleared lockout`)
  } catch (e) {
    fail(`login repair failed: ${e.message.slice(0, 120)}`)
  } finally {
    unlinkSync(sqlFile)
  }
}

// --- google maps ------------------------------------------------------------
console.log('\n[4] Google Maps key')

const mapKey = dashVars?.NEXT_PUBLIC_GOOGLE_MAP_KEY
if (!mapKey) {
  fail('NEXT_PUBLIC_GOOGLE_MAP_KEY not set in dashboard env')
} else {
  // Referer header required — this is what the browser sends and what the
  // GCP key restriction evaluates.
  const ref = await fetch(
    `https://maps.googleapis.com/maps/api/streetview/metadata?location=40.7,-74&key=${mapKey}`,
    { headers: { Referer: `${DASH_URL}/` }, signal: AbortSignal.timeout(8000) },
  ).then((x) => x.json()).catch(() => null)
  if (ref?.status === 'OK') {
    ok(`maps key authorized for ${DASH_URL}`)
  } else {
    fail(`maps key rejected localhost referrer (${ref?.status || 'no response'}) — add ${DASH_URL}/* to the key's allowed referrers in GCP console`)
  }
}

// --- property provider ------------------------------------------------------
console.log('\n[5] Property provider (CoreLogic)')

const clId = apiVars?.CORELOGIC_CLIENT_ID
const clSecret = apiVars?.CORELOGIC_CLIENT_SECRET
if (!clId || !clSecret) {
  fail('CoreLogic credentials missing from .dev.vars')
} else {
  const res = await fetch('https://prod.corelogicapi.com/oauth/token?grant_type=client_credentials', {
    method: 'POST',
    redirect: 'manual',
    signal: AbortSignal.timeout(10000),
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${Buffer.from(`${clId}:${clSecret}`).toString('base64')}`,
    },
  }).catch(() => null)
  if (res?.ok) {
    ok('CoreLogic token mint succeeds (credentials valid)')
  } else {
    const body = res ? (await res.text()).slice(0, 120) : 'no response'
    fail(`CoreLogic token request failed: ${res?.status || 'network'} ${body}`)
  }
}

// --- summary ----------------------------------------------------------------
console.log(failures ? `\n${failures} check(s) FAILED\n` : '\nAll checks passed — dev environment is healthy\n')
process.exit(failures ? 1 : 0)
