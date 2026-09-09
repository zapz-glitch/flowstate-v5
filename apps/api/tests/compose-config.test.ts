import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const compose = read('../../../compose.dev.yaml')
const api = read('../Dockerfile.dev')
const dashboard = read('../../dashboard/Dockerfile.dev')
assert.match(compose, /dockerfile: apps\/api\/Dockerfile\.dev/)
assert.match(compose, /127\.0\.0\.1:\$\{V4_TS_API_PORT:-8787\}:8787/)
assert.match(compose, /127\.0\.0\.1:\$\{V4_API_PORT:-8004\}:8004/)
assert.doesNotMatch(compose, /command: \["wrangler", "dev"\]/)
assert.doesNotMatch(compose, /pull_policy: always/)
for (const dockerfile of [api, dashboard]) {
  assert.match(dockerfile, /FROM node:22-slim@sha256:[a-f0-9]{64}/)
  assert.match(dockerfile, /COPY.*apps\/api/)
  assert.match(dockerfile, /COPY.*apps\/dashboard/)
  assert.match(dockerfile, /RUN npm ci/)
}
assert.match(api, /USER node/)
const scripts = JSON.parse(read('../package.json')).scripts
assert.match(scripts.dev, /--config wrangler\.local\.toml --local/)
assert.match(read('../../../.dockerignore'), /^\.data\/$/m)
assert.match(read('../../../.dockerignore'), /^\*\*\/\.dev\.vars$/m)
assert.match(read('../../../.dockerignore'), /^\*\*\/\.env\.\*$/m)
console.log('Compose builds use pinned Node 22, complete workspaces, explicit local API config and independent loopback ports')
