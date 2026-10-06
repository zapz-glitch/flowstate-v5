import assert from 'node:assert/strict'
import { test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { loadModule, realUtils } from '../../lib/test-load.mjs'

const stub = (name) => (props) => React.createElement('i', { 'data-icon': name, className: props?.className })
const progressLib = loadModule(new URL('../../lib/permit-progress.ts', import.meta.url))

// The Permits row with a given server stage on the atom
const render = (progress, props) => {
  const { PropertyPermits } = loadModule(new URL('./PropertyPermits.tsx', import.meta.url), {
    '@/lib/utils': realUtils(),
    jotai: { useAtomValue: () => progress },
    'lucide-react': { ChevronDown: stub('chevron'), Loader2: stub('spinner'), FileText: stub('file'), Check: stub('check') },
    sonner: { toast: { success() {}, error() {} } },
    '@/hooks/use-evaluation': { useEvaluation: () => ({ feedbackContext: null, onPermitsPulled: null }) },
    '@/lib/client-api': { pullReportPermits: async () => ({}) },
    '@/atoms/analysis': { permitProgressAtom: {} },
    '@/lib/permit-progress': progressLib,
    './format-helpers': { formatShortDate: (d) => d },
  })
  return renderToStaticMarkup(React.createElement(PropertyPermits, props))
}

test('while permits load with no stage yet, the row says Loading', () => {
  const out = render(null, { permits: undefined, loading: true })
  assert.match(out, /Loading…/)
  assert.doesNotMatch(out, /role="status"/)
})

test('each server stage shows its words, a step marker and a spinner while more is coming', () => {
  const requesting = render({ stage: 'requesting', message: 'Requesting permit records' }, { permits: undefined, loading: true })
  assert.match(requesting, /role="status"/)
  assert.match(requesting, /Requesting permit records/)
  assert.match(requesting, /aria-label="Step 1 of 3"/)
  assert.match(requesting, /data-icon="spinner"/)
  assert.doesNotMatch(requesting, /Loading…/)

  const found = render({ stage: 'received', state: 'ok', count: 3, message: '3 permits found' }, { permits: undefined, loading: true })
  assert.match(found, /3 permits found/)
  assert.match(found, /aria-label="Step 2 of 3"/)
  assert.match(found, /data-icon="spinner"/, 'major items are still to be assessed')
})

test('a check replaces the spinner when nothing more is coming', () => {
  const assessed = render({ stage: 'assessed', message: 'Major items assessed from permits · 2 charged' }, { permits: undefined, loading: true })
  assert.match(assessed, /aria-label="Step 3 of 3"/)
  assert.match(assessed, /data-icon="check"/)
  assert.doesNotMatch(assessed, /data-icon="spinner"/)

  const none = render({ stage: 'received', state: 'empty', count: 0, message: 'No permits on file' }, { permits: undefined, loading: true })
  assert.match(none, /No permits on file/)
  assert.match(none, /data-icon="check"/)

  const failed = render({ stage: 'received', state: 'unavailable', message: 'Permit lookup unavailable' }, { permits: undefined, loading: true })
  assert.match(failed, /Permit lookup unavailable/)
  assert.doesNotMatch(failed, /data-icon="spinner"/)
})

test('the step marker has three marks and fills as far as the step', () => {
  const out = render({ stage: 'received', state: 'ok', count: 1, message: '1 permit found' }, { permits: undefined, loading: true })
  const marks = out.match(/h-1 w-3 rounded-full[^"]*/g) ?? []
  assert.equal(marks.length, 3)
  assert.equal(marks.filter((m) => m.includes('bg-foreground-secondary')).length, 2)
  assert.equal(marks.filter((m) => m.includes('bg-border')).length, 1)
})

test('once the result is in, the stage no longer shows: the permits themselves do', () => {
  const permits = { status: 'available', items: [{ permitId: 'a', projectType: 'Roof', jobValue: 9000 }] }
  const out = render({ stage: 'assessed', message: 'x' }, { permits, loading: false })
  assert.match(out, /Permits \(1\)/)
  assert.doesNotMatch(out, /role="status"/)
})
