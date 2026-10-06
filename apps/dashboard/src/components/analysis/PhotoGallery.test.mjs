import assert from 'node:assert/strict'
import { test } from 'node:test'
import React from 'react'
import { loadModule, realUtils } from '../../lib/test-load.mjs'

const stub = () => null
const { visibleThumbnails } = loadModule(new URL('./PhotoGallery.tsx', import.meta.url), {
  '@/lib/utils': realUtils(),
  'lucide-react': { ChevronLeft: stub, ChevronRight: stub, X: stub },
  '@/components/ui/dialog': { Dialog: stub, DialogContent: stub, DialogTitle: stub },
  '@radix-ui/react-visually-hidden': { Root: stub },
})
const photos = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']

test('shows the first six photos, keeping their positions', () => {
  const shown = visibleThumbnails(photos, new Set())
  assert.deepEqual(shown.map((p) => p.photo), ['a', 'b', 'c', 'd', 'e', 'f'])
  assert.deepEqual(shown.map((p) => p.i), [0, 1, 2, 3, 4, 5])
})

test('photos that failed to load are dropped, so they leave no gap', () => {
  // The bug this guards: four broken photos left four empty slots and pushed
  // the one working thumbnail 24px right of the "Permits" text.
  const shown = visibleThumbnails(['x', 'y', 'z', 'w', 'ok'], new Set([0, 1, 2, 3]))
  assert.deepEqual(shown.map((p) => p.photo), ['ok'])
  assert.equal(shown[0].i, 4, 'the lightbox still opens at the right photo')
})

test('all photos failed: nothing to draw', () => {
  assert.deepEqual(visibleThumbnails(['a', 'b'], new Set([0, 1])), [])
})

test('no photos: nothing to draw', () => {
  assert.deepEqual(visibleThumbnails([], new Set()), [])
})
