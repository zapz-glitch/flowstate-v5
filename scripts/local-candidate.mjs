import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'
import { execFileSync, spawn } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const branch = execFileSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8' }).trim()
if (branch !== 'v4-python') throw new Error('Local candidate setup requires v4-python')
const state = resolve(root, '.data/local-candidate')
mkdirSync(state, { recursive: true, mode: 0o700 })
const credentialsPath = resolve(state, 'login.json')
const secretsPath = resolve(state, 'secrets.json')
const command = process.argv[2]

function save(path, content) {
  writeFileSync(path, content, { mode: 0o600 })
  chmodSync(path, 0o600)
}

function encodeEnvironment(values) {
  return Object.entries(values).map(([key, value]) => {
    const encoded = ['V4_SNAPSHOT_KEYS', 'V4_SNAPSHOT_LEGACY_KEYS'].includes(key)
      ? `'${String(value).replaceAll("'", '\\u0027')}'` : JSON.stringify(value)
    return `${key}=${encoded}`
  }).join('\n') + '\n'
}

function snapshotConfiguration(current = {}) {
  const path = resolve(state, 'snapshot-keys.json')
  const cached = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null
  const explicit = current.V4_SNAPSHOT_ACTIVE_KEY_ID || current.V4_SNAPSHOT_KEYS
  const config = explicit ? {
    V4_SNAPSHOT_ACTIVE_KEY_ID: current.V4_SNAPSHOT_ACTIVE_KEY_ID,
    V4_SNAPSHOT_KEYS: current.V4_SNAPSHOT_KEYS,
    V4_SNAPSHOT_LEGACY_KEYS: current.V4_SNAPSHOT_LEGACY_KEYS ?? cached?.V4_SNAPSHOT_LEGACY_KEYS ?? '[]',
  } : cached ?? {
    V4_SNAPSHOT_ACTIVE_KEY_ID: current.V4_SNAPSHOT_ACTIVE_KEY_ID || 'local-1',
    V4_SNAPSHOT_KEYS: current.V4_SNAPSHOT_KEYS || JSON.stringify({ 'local-1': randomBytes(48).toString('hex') }),
    V4_SNAPSHOT_LEGACY_KEYS: current.V4_SNAPSHOT_LEGACY_KEYS || JSON.stringify(current.V4_LOCAL_BRIDGE_TOKEN ? [current.V4_LOCAL_BRIDGE_TOKEN] : []),
  }
  const keys = JSON.parse(config.V4_SNAPSHOT_KEYS || '{}')
  const legacy = JSON.parse(config.V4_SNAPSHOT_LEGACY_KEYS || '[]')
  if (!keys || typeof keys !== 'object' || Array.isArray(keys) || Object.keys(keys).length > 8 ||
      !Object.hasOwn(keys, config.V4_SNAPSHOT_ACTIVE_KEY_ID ?? '') ||
      Object.entries(keys).some(([id, value]) => !/^[a-zA-Z0-9_-]{1,40}$/.test(id) || typeof value !== 'string' || value.length < 32) ||
      !Array.isArray(legacy) || legacy.length > 8 || legacy.some(value => typeof value !== 'string' || value.length < 32)) {
    throw new Error('Invalid local snapshot configuration; no key files changed')
  }
  save(path, JSON.stringify(config, null, 2) + '\n')
  return config
}

if (command === 'init') {
  const providerFile = process.argv[3]
  const provider = providerFile ? parseEnv(readFileSync(resolve(providerFile), 'utf8')) : {}
  const secrets = existsSync(secretsPath) && !process.argv.includes('--rotate-auth')
    ? JSON.parse(readFileSync(secretsPath, 'utf8'))
    : { BETTER_AUTH_SECRET: randomBytes(48).toString('hex'), DASHBOARD_INTERNAL_SECRET: randomBytes(48).toString('hex') }
  save(secretsPath, JSON.stringify(secrets, null, 2) + '\n')
  const apiEnv = {
    ...secrets,
    ...snapshotConfiguration(existsSync(resolve(root, 'apps/api/.dev.vars')) ? parseEnv(readFileSync(resolve(root, 'apps/api/.dev.vars'), 'utf8')) : {}),
    ENVIRONMENT: 'development',
    DASHBOARD_URL: 'http://localhost:3004',
    PROPERTY_PROVIDER: 'corelogic',
    ...(existsSync(resolve(state, 'python-token')) ? {
      EVALUATION_ENGINE: 'python-v4', V4_LOCAL_BRIDGE_URL: 'http://127.0.0.1:8788',
      V4_LOCAL_BRIDGE_TOKEN: readFileSync(resolve(state, 'python-token'), 'utf8').trim(),
    } : {}),
  }
  for (const name of ['CORELOGIC_CLIENT_ID', 'CORELOGIC_CLIENT_SECRET']) {
    if (provider[name]) apiEnv[name] = provider[name]
  }
  const encode = encodeEnvironment
  const apiFile = resolve(root, 'apps/api/.dev.vars')
  const dashboardFile = resolve(root, 'apps/dashboard/.env.local')
  const dashboardBindingsFile = resolve(root, 'apps/dashboard/.dev.vars')
  for (const path of [apiFile, dashboardFile, dashboardBindingsFile]) {
    if (existsSync(path)) save(resolve(state, `${path === apiFile ? 'api' : path === dashboardFile ? 'dashboard-env' : 'dashboard-bindings'}-${Date.now()}.backup`), readFileSync(path))
  }
  save(apiFile, encode(apiEnv))
  save(dashboardFile, encode({ ...secrets, NEXT_PUBLIC_API_URL: 'http://localhost:8787' }))
  save(dashboardBindingsFile, encode({ ...secrets, NEXT_PUBLIC_API_URL: 'http://localhost:8787' }))
  if (!existsSync(credentialsPath)) save(credentialsPath, JSON.stringify({ name: 'Local Test', email: 'local@flowstate.test', password: randomBytes(24).toString('base64url') }, null, 2) + '\n')
  console.log(JSON.stringify({ initialized: true, localAuthFresh: process.argv.includes('--rotate-auth'), corelogicConfigured: Boolean(apiEnv.CORELOGIC_CLIENT_ID && apiEnv.CORELOGIC_CLIENT_SECRET), loginFile: credentialsPath }))
} else if (command === 'configure-snapshots') {
  const path = resolve(root, 'apps/api/.dev.vars')
  const current = parseEnv(readFileSync(path, 'utf8'))
  save(resolve(state, `api-before-snapshot-keys-${Date.now()}.backup`), readFileSync(path))
  const snapshotInput = process.argv.includes('--from-saved-keys') ? JSON.parse(readFileSync(resolve(state, 'snapshot-keys.json'), 'utf8')) : current
  save(path, encodeEnvironment({ ...current, ...snapshotConfiguration(snapshotInput) }))
  console.log('Independent local snapshot keys configured; prior signatures retained. No authentication tokens rotated.')
} else if (command === 'enable-evidence') {
  const provider = parseEnv(readFileSync(resolve(process.argv[3]), 'utf8'))
  const path = resolve(root, 'apps/api/.dev.vars')
  const current = parseEnv(readFileSync(path, 'utf8'))
  save(resolve(state, `api-before-evidence-${Date.now()}.backup`), readFileSync(path))
  const imported = []
  for (const key of ['FIRECRAWL_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY']) {
    if (provider[key]) { current[key] = provider[key]; imported.push(key) }
  }
  save(path, encodeEnvironment(current))
  console.log(JSON.stringify({ localEvidenceConfigured: imported, providerAccountKeysChanged: false }))
} else if (command === 'enable-python') {
  const tokenPath = resolve(state, 'python-token')
  const token = existsSync(tokenPath) ? readFileSync(tokenPath, 'utf8').trim() : randomBytes(48).toString('hex')
  save(tokenPath, token + '\n')
  const path = resolve(root, 'apps/api/.dev.vars')
  const current = parseEnv(readFileSync(path, 'utf8'))
  save(resolve(state, `api-before-python-${Date.now()}.backup`), readFileSync(path))
  save(path, encodeEnvironment({ ...current, ...snapshotConfiguration(current), EVALUATION_ENGINE: 'python-v4', V4_LOCAL_BRIDGE_URL: 'http://127.0.0.1:8788', V4_LOCAL_BRIDGE_TOKEN: token }))
  console.log('Local API configured for Python V4; start the python command before running analysis.')
} else if (command === 'python') {
  const token = readFileSync(resolve(state, 'python-token'), 'utf8').trim()
  const python = process.argv[3]
  if (!python) throw new Error('Provide the evaluation virtualenv Python executable')
  const child = spawn(python, ['-m', 'uvicorn', 'eval_engine.local_bridge:app', '--host', '127.0.0.1', '--port', '8788'], {
    cwd: root, stdio: 'inherit', env: { ...process.env, PYTHONPATH: resolve(root, 'services/eval-engine/src'), V4_LOCAL_BRIDGE_ENABLED: 'true', V4_LOCAL_BRIDGE_TOKEN: token },
  })
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
  child.on('error', error => { console.error(error.message); process.exitCode = 1 })
  child.on('exit', code => { process.exitCode = code ?? 1 })
} else if (command === 'account') {
  const credentials = JSON.parse(readFileSync(credentialsPath, 'utf8'))
  const base = 'http://localhost:8787/auth'
  const send = (route, body) => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:3004' }, body: JSON.stringify(body) })
  const signup = await send('/sign-up/email', credentials)
  if (!signup.ok && signup.status !== 422 && signup.status !== 400) throw new Error(`Local signup failed: HTTP ${signup.status}`)
  const login = await send('/sign-in/email', { email: credentials.email, password: credentials.password })
  const payload = await login.json()
  if (!login.ok || !payload.user?.id) throw new Error(`Local login failed: HTTP ${login.status}, code ${payload.code || 'unknown'}`)
  const cookies = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
  const session = await fetch(base + '/get-session', { headers: { Cookie: cookies, Origin: 'http://localhost:3004' } })
  const sessionData = await session.json()
  if (!session.ok || sessionData.user?.id !== payload.user.id) throw new Error('Local session verification failed')
  save(resolve(state, 'session.json'), JSON.stringify({ cookies, userId: payload.user.id }) + '\n')
  console.log(JSON.stringify({ login: 'passed', session: 'passed', email: credentials.email, loginFile: credentialsPath }))
} else {
  throw new Error('Usage: node scripts/local-candidate.mjs init [provider-env] [--rotate-auth] | account | enable-python | python <python-executable>')
}
