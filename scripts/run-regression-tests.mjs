import { readdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const target = process.argv[2]
if (!['api', 'dashboard'].includes(target)) throw new Error('Expected api or dashboard')
const directory = resolve(root, target === 'api' ? 'apps/api/tests' : 'apps/dashboard/src')
function discover(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(directory, entry.name)
    return entry.isDirectory() ? discover(path) : /\.test\.(ts|mjs)$/.test(entry.name) ? [path] : []
  })
}
const tests = discover(directory).sort()
if (!tests.length) throw new Error(`No ${target} regression tests found`)
let failed = false
for (const path of tests) {
  const args = path.endsWith('.ts') ? ['--import', 'tsx', path] : ['--test', path]
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit', env: process.env, timeout: 120_000 })
  if (result.error) console.error(result.error.message)
  if (result.status !== 0) failed = true
}
console.log(`${target}: ${tests.length} regression files; ${failed ? 'FAILED' : 'passed'}`)
process.exitCode = failed ? 1 : 0
