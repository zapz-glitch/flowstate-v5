import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import { test } from 'node:test'
import { transformSync } from 'esbuild'

const require = createRequire(import.meta.url)
const { code } = transformSync(readFileSync(new URL('./StreetViewImage.tsx', import.meta.url), 'utf8'), {
  loader: 'tsx', format: 'cjs', jsx: 'automatic',
})

// Exercise rendered image props and error callbacks without a DOM. The single
// state hook is retained across rerenders and reset at React's keyed boundary.
function harness(key = 'test-google-key') {
  let state
  let identity
  const module = { exports: {} }
  vm.runInNewContext(code, {
    module, exports: module.exports,
    process: { env: { NEXT_PUBLIC_GOOGLE_MAP_KEY: key } },
    require: name => name === 'react' ? {
      useState(initial) {
        state ??= initial
        return [state, update => { state = typeof update === 'function' ? update(state) : update }]
      },
    } : name === 'lucide-react' ? { Home: () => null } : require(name),
  })
  return {
    ...module.exports,
    render(props) {
      let node = module.exports.StreetViewImage(props)
      if (identity !== node.key) { state = undefined; identity = node.key }
      while (typeof node.type === 'function') node = node.type(node.props)
      return node
    },
  }
}

const firstPhoto = '/user/reports/job_1/assets/12345678-1234-1234-1234-123456789abc'
const secondPhoto = '/user/reports/job_1/assets/abcdef12-1234-1234-1234-123456789abc'

test('Street View accepts zero coordinates and requests an HTTP error for missing coverage', () => {
  const { getStreetViewUrl } = harness()
  const url = new URL(getStreetViewUrl({ latitude: 0, longitude: 0, address: 'Ignored address' }))
  assert.equal(url.origin, 'https://maps.googleapis.com')
  assert.equal(url.pathname, '/maps/api/streetview')
  assert.equal(url.searchParams.get('location'), '0,0')
  assert.equal(url.searchParams.get('return_error_code'), 'true')
  assert.equal(url.searchParams.get('source'), 'outdoor')
})

test('address fallback safely encodes punctuation and rejects missing locations or keys', () => {
  const { getStreetViewUrl } = harness()
  const address = '12 A & B St, Austin #3'
  const url = new URL(getStreetViewUrl({ latitude: NaN, longitude: -97, address, width: 640, height: 480 }))
  assert.equal(url.searchParams.get('location'), address)
  assert.equal(url.searchParams.get('size'), '640x480')
  assert.equal(getStreetViewUrl({ latitude: Infinity, longitude: 0 }), null)
  assert.equal(getStreetViewUrl({ latitude: 30 }), null)
  assert.equal(getStreetViewUrl({}), null)
  assert.equal(harness('').getStreetViewUrl({ address }), null)
})

test('Street View wins over saved photos and errors advance through private fallbacks', () => {
  const { render } = harness()
  const props = { address: '123 Main St', photos: ['https://example.com/photo.jpg', firstPhoto, secondPhoto] }
  let node = render(props)
  assert.equal(node.type, 'img')
  assert.match(node.props.src, /^https:\/\/maps.googleapis.com\/maps\/api\/streetview\?/)
  assert.match(node.props.alt, /^Google Street View: 123 Main St$/)
  assert.equal(node.props.loading, 'lazy')
  node.props.onError()
  node = render(props)
  assert.equal(node.props.src, firstPhoto)
  assert.match(node.props.alt, /^Saved property photo:/)
  node.props.onError()
  node = render(props)
  assert.equal(node.props.src, secondPhoto)
  node.props.onError()
  assert.equal(render(props).props['aria-label'], 'No imagery available')
})

test('without a Google key only valid private report images are rendered', () => {
  const { render } = harness('')
  const invalidPhotos = ['https://example.com/photo.jpg', '//example.com/photo.jpg', '/user/reports/job_1/assets/not-an-id', `${firstPhoto}?redirect=https://example.com`]
  assert.equal(render({ address: 'A', photos: invalidPhotos }).props['aria-label'], 'No imagery available')
  assert.equal(render({ address: 'A', photos: [...invalidPhotos, firstPhoto] }).props.src, firstPhoto)
})

test('a card reused for another location retries Street View after an image failure', () => {
  const { render } = harness()
  const props = { address: '123 Main St', latitude: 30, longitude: -97 }
  const initial = render(props)
  initial.props.onError()
  assert.equal(render(props).props['aria-label'], 'No imagery available')
  const next = render({ ...props, latitude: 31 })
  assert.equal(next.type, 'img')
  assert.equal(new URL(next.props.src).searchParams.get('location'), '31,-97')
})
