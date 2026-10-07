// Test helper (not a test): loads a .ts/.tsx source file in a fresh context so
// a unit test can import a component or hook without a bundler. `mocks` maps an
// import name (including the "@/" alias) to a stand-in; anything not mocked is
// required normally.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import { transformSync } from 'esbuild'

const require = createRequire(import.meta.url)

export function loadModule(url, mocks = {}) {
  const path = url instanceof URL ? url : new URL(url)
  const source = readFileSync(path, 'utf8')
  const isTsx = path.pathname.endsWith('.tsx')
  const { code } = transformSync(source, { loader: isTsx ? 'tsx' : 'ts', format: 'cjs', jsx: 'automatic' })
  const module = { exports: {} }
  vm.runInNewContext(code, {
    module,
    exports: module.exports,
    require: (name) => (name in mocks ? mocks[name] : require(name)),
    console,
    window: { requestIdleCallback: undefined },
  })
  return module.exports
}

/** The real `cn()` (clsx + tailwind-merge), so class assertions match production. */
export function realUtils() {
  return loadModule(new URL('./utils.ts', import.meta.url))
}
