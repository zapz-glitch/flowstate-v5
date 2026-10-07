import assert from 'node:assert/strict'
import { test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { loadModule, realUtils } from '../../lib/test-load.mjs'

const utils = realUtils()
const Icon = ({ className }) => React.createElement('svg', { className, 'data-icon': true })
const Link = ({ href, children, ...rest }) => React.createElement('a', { href, ...rest }, children)
const button = loadModule(new URL('./button.tsx', import.meta.url), { '@/lib/utils': utils })
const states = loadModule(new URL('./states.tsx', import.meta.url), {
  '@/lib/utils': utils,
  '@/components/ui/button': button,
  'next/link': { default: Link, __esModule: true },
  'lucide-react': { Loader2: Icon },
})
const skeleton = loadModule(new URL('./skeleton.tsx', import.meta.url), { '@/lib/utils': utils })
const render = (node) => renderToStaticMarkup(node)
const h = React.createElement

test('ErrorState says what failed, why, and offers a retry link', () => {
  const out = render(h(states.ErrorState, {
    title: "Couldn't load your reports",
    detail: 'Check your connection or sign in again.',
    action: { label: 'Try again', href: '/dashboard/reports?page=2' },
  }))
  assert.match(out, /role="alert"/)
  assert.match(out, /Couldn&#x27;t load your reports|Couldn't load your reports/)
  assert.match(out, /Check your connection/)
  assert.match(out, /<a [^>]*href="\/dashboard\/reports\?page=2"[^>]*>Try again<\/a>/)
  assert.doesNotMatch(out, /sorry|oops|unfortunately/i, 'errors never apologize')
})

test('ErrorState with a click action renders a button, not a link', () => {
  const out = render(h(states.ErrorState, { title: 'Save failed', action: { label: 'Retry', onClick() {} } }))
  assert.match(out, /<button[^>]*>Retry<\/button>/)
  assert.doesNotMatch(out, /<a /)
})

test('ErrorState variants differ: panel is bordered, page is centered, inline is plain', () => {
  const panel = render(h(states.ErrorState, { title: 'x' }))
  const page = render(h(states.ErrorState, { title: 'x', variant: 'page' }))
  const inline = render(h(states.ErrorState, { title: 'x', variant: 'inline' }))
  assert.match(panel, /border-destructive\/30/)
  assert.match(page, /text-center/)
  assert.doesNotMatch(inline, /border-destructive/)
})

test('EmptyState: a title, a line, a next step, and no decorative icon', () => {
  const out = render(h(states.EmptyState, {
    title: 'No reports yet',
    description: 'Run an analysis to create your first report.',
    action: { label: 'Run an analysis', href: '/dashboard/analyze' },
  }))
  assert.match(out, /No reports yet/)
  assert.match(out, /href="\/dashboard\/analyze"/)
  assert.doesNotMatch(out, /<svg/)
})

test('EmptyState without a description or action stays minimal', () => {
  const out = render(h(states.EmptyState, { title: 'No tasks yet' }))
  assert.doesNotMatch(out, /<a |<button/)
})

test('LoadingState announces itself and keeps its text size', () => {
  const out = render(h(states.LoadingState, { label: 'Loading comps' }))
  assert.match(out, /role="status"/)
  assert.match(out, /aria-live="polite"/)
  assert.match(out, /Loading comps/)
  // Regression guard: cn() drops a custom size that sits next to a text color
  assert.match(out, /text-caption/)
  assert.match(out, /motion-reduce:animate-none/)
})

test('LoadingState block variant reserves vertical room', () => {
  assert.match(render(h(states.LoadingState, { block: true })), /py-10/)
})

test('InlineStatus: errors are alerts in the destructive color, the rest are quiet status text', () => {
  const error = render(h(states.InlineStatus, { kind: 'error' }, 'Save failed. Edit again to retry.'))
  const saved = render(h(states.InlineStatus, { kind: 'saved' }, 'Saved'))
  const saving = render(h(states.InlineStatus, { kind: 'saving' }, 'Saving…'))
  assert.match(error, /role="alert"/)
  assert.match(error, /text-destructive/)
  assert.match(saved, /role="status"/)
  assert.match(saving, /text-foreground-tertiary/)
  for (const out of [error, saved, saving]) assert.match(out, /text-caption/, 'size survives the merge')
})

test('SkeletonRows renders the rows asked for and one spoken label', () => {
  const out = render(h(skeleton.SkeletonRows, { label: 'Loading tasks', rows: 3 }))
  assert.match(out, /role="status"/)
  assert.match(out, /aria-busy="true"/)
  assert.equal((out.match(/Loading tasks/g) ?? []).length, 1)
  assert.equal((out.match(/last:border-0/g) ?? []).length, 3)
})

test('SkeletonTable: header plus rows, first column takes the free space', () => {
  const out = render(h(skeleton.SkeletonTable, { label: 'Loading reports', columns: ['w-48', 'w-24', 'w-16'], rows: 4 }))
  // 3 header cells + 4 rows x 3 cells
  assert.equal((out.match(/animate-pulse/g) ?? []).length, 3 + 12)
  assert.equal((out.match(/mr-auto/g) ?? []).length, 1 + 4)
})

test('SkeletonStat renders the tiles asked for', () => {
  const out = render(h(skeleton.SkeletonStat, { label: 'Loading usage', count: 3 }))
  assert.equal((out.match(/rounded-sm border border-border p-4/g) ?? []).length, 3)
})

test('SkeletonPageHeader matches the real header height', () => {
  assert.match(render(h(skeleton.SkeletonPageHeader, {})), /min-h-9/)
})

test('skeletons stop pulsing for people who ask for reduced motion', () => {
  assert.match(render(h(skeleton.Skeleton, {})), /motion-reduce:animate-none/)
})
