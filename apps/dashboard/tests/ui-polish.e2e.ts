// UI E2E for the dashboard polish pass: exact checks, no model.
//   - every menu page has a title-only header
//   - Property Search: the empty state, the subject card, the map, the hover
//     panel, the comp dialog, and the one-row-per-notch scroll
//   - phone width: the tab strips scroll inside themselves, the page does not
//
// The saved-report page autosaves on load, so every test that opens a report
// blocks non-GET calls to the API first and never writes.
import { describe, test } from '@e2e-dev/web'
import { expect } from 'e2e'

const WEB = { session: 'local', platforms: ['web'] } as const

const MENU_PAGES = [
  { path: '/dashboard', title: 'Overview' },
  { path: '/dashboard/reports', title: 'Property Reports' },
  { path: '/dashboard/evaluation-settings', title: 'Evaluation Settings' },
  { path: '/dashboard/tasks', title: 'Tasks' },
  { path: '/dashboard/give-offer', title: 'Offers' },
  { path: '/dashboard/analytics', title: 'Analytics' },
  { path: '/dashboard/api-hub', title: 'API Hub' },
  { path: '/dashboard/settings', title: 'Settings' },
]

describe('page headers are title only', () => {
  for (const page of MENU_PAGES) {
    test(`${page.title} opens with one title and no subtitle line`, WEB, async ({ app, screen }) => {
      await app.open(page.path)
      await expect(screen.getByRole('heading', page.title, { level: 1 })).toBeVisible()
      await expect(screen.getByRole('heading', { level: 1 })).toHaveCount(1)
    })
  }
})

describe('Property Search with nothing loaded', () => {
  test('opens like the other pages: a title, then the search box', WEB, async ({ app, screen }) => {
    // ?address= (even empty) skips restoring the last report
    await app.open('/dashboard/analyze?address=')
    await expect(screen.getByRole('heading', 'Property Search', { level: 1 })).toBeVisible()
    await expect(screen.getByPlaceholder('123 Main St, Tampa, FL 33607')).toBeVisible()
    await expect(screen.getByRole('button', 'Run')).toBeVisible()
    // The old header: API route name, tagline, eyebrow
    await expect(screen.getByText('/v1/analyze')).toHaveCount(0)
    await expect(screen.getByText('Property details, comparables, and valuation')).toHaveCount(0)
    await expect(screen.getByText('Search an address. Underwrite the deal.')).toHaveCount(0)
    await expect(screen.getByText('Flowstate | Property underwriting', { exact: false })).toHaveCount(0)
  })
})

// ── A loaded report on Property Search ───────────────────────────────────────

type Rect = { x: number; y: number; width: number; height: number }

/** Block writes to the API, find a saved report, point the "last analysis"
 *  pointer at it, and open Property Search so it restores that report. */
async function openLoadedSearch({ app, screen, browser }: Pick<Parameters<Parameters<typeof test>[2]>[0], 'app' | 'screen' | 'browser'>) {
  await browser.route('**/user/reports/**', async (route) => {
    if (route.request.method === 'GET') await route.continue()
    else await route.abort()
  })
  await app.open('/dashboard/reports')
  const firstReport = screen.getByRole('link', 'View').first()
  await expect(firstReport).toBeVisible({ timeout: 30_000 })
  const href = await firstReport.getAttribute('href')
  expect(href, 'there is at least one saved report to open').toMatch(/\/dashboard\/reports\/.+/)
  const jobId = String(href).split('/').pop() ?? ''
  await browser.evaluate((id: string) => {
    localStorage.setItem('flowstate:last-analysis', JSON.stringify({ jobId: id, address: '', savedAt: Date.now() }))
    return true
  }, jobId)
  await app.open('/dashboard/analyze')
  await expect(browser.locator('[data-card-key="subject"]')).toBeVisible({ timeout: 30_000 })
}

describe('Property Search with a report loaded', () => {
  test('the subject card carries the deal actions, once', WEB, async (fx) => {
    const { screen, browser } = fx
    await openLoadedSearch(fx)
    const card = browser.locator('[data-card-key="subject"]')
    for (const name of ['Prep offer', 'No margin', 'No offer', 'Re-run', 'Evaluation Settings']) {
      await expect(card.getByRole('button', name)).toBeVisible()
      // They moved from the valuation box; they are not in both places
      await expect(screen.getByRole('button', name)).toHaveCount(1)
    }
  })

  test('the five deal buttons are one horizontal row', WEB, async (fx) => {
    const { browser } = fx
    await openLoadedSearch(fx)
    const card = browser.locator('[data-card-key="subject"]')
    const labels = ['Prep offer', 'No margin', 'No offer', 'Re-run', 'Evaluation Settings']
    const boxes: Rect[] = []
    for (const label of labels) boxes.push((await card.getByRole('button', label).boundingBox()) as Rect)
    for (const box of boxes) expect(Math.abs(box.y - boxes[0].y), 'same row').toBeLessThan(4)
    for (let i = 1; i < boxes.length; i++) expect(boxes[i].x, 'left to right, in order').toBeGreaterThan(boxes[i - 1].x)
  })

  test('there is no comp rules line on the subject card', WEB, async (fx) => {
    const { screen } = fx
    await openLoadedSearch(fx)
    await expect(screen.getByText('Comp rules')).toHaveCount(0)
  })

  test('the valuation header carries the costs, right-aligned, and List is not repeated', WEB, async (fx) => {
    const { screen, browser } = fx
    await openLoadedSearch(fx)
    const close = (await screen.getByText('Close $', { exact: false }).boundingBox()) as Rect
    const carry = (await screen.getByText('Carry $', { exact: false }).boundingBox()) as Rect
    const invest = (await screen.getByText('Invest $', { exact: false }).boundingBox()) as Rect
    const wholesale = (await screen.getByText('Wholesale $', { exact: false }).boundingBox()) as Rect
    // Close at the left of the line, Wholesale at the right, all on one row
    expect(close.x).toBeLessThan(carry.x)
    expect(carry.x).toBeLessThan(invest.x)
    expect(invest.x).toBeLessThan(wholesale.x)
    for (const box of [carry, invest, wholesale]) expect(Math.abs(box.y - close.y)).toBeLessThan(4)
    // Right-aligned: Wholesale ends at the right edge of the valuation box
    const gapToEdge = (await browser.evaluate(() => {
      const span = [...document.querySelectorAll('span')].find((e) => e.textContent?.startsWith('Wholesale $'))
      const box = span?.closest('.border.rounded-sm') as HTMLElement | null
      if (!span || !box) return -1
      return Math.round(box.getBoundingClientRect().right - span.getBoundingClientRect().right)
    })) as number
    expect(gapToEdge, 'Wholesale sits at the right edge of the valuation box').toBeGreaterThanOrEqual(0)
    expect(gapToEdge).toBeLessThanOrEqual(16)
    // The old footer repeated the list price; it is already the List tile
    await expect(screen.getByText('List $', { exact: false })).toHaveCount(0)
  })

  test('Condition sits under Sq Ft', WEB, async (fx) => {
    const { browser } = fx
    await openLoadedSearch(fx)
    const card = browser.locator('[data-card-key="subject"]')
    const sqft = (await card.getByText('Sq Ft', { exact: true }).boundingBox()) as Rect
    const condition = (await card.getByText('Condition', { exact: true }).boundingBox()) as Rect
    expect(Math.abs(condition.x - sqft.x), 'same left edge as the Sq Ft column').toBeLessThan(4)
    expect(condition.y, 'on the row below').toBeGreaterThan(sqft.y)
  })

  test('the map has no toolbar buttons; the legend stays', WEB, async (fx) => {
    const { screen } = fx
    await openLoadedSearch(fx)
    for (const name of ['Street View', 'Subject', 'Satellite', 'Map', '3D', 'Zoom in', 'Zoom out']) {
      await expect(screen.getByRole('button', name, { exact: true })).toHaveCount(0)
    }
    await expect(screen.getByText('Included', { exact: true })).toBeVisible()
    await expect(screen.getByText('Excluded', { exact: true })).toBeVisible()
  })

  test('hovering a marker opens the comp beside the subject, and it fades out', WEB, async (fx) => {
    const { screen, browser } = fx
    await openLoadedSearch(fx)
    // The map draws its markers a moment after the page does
    await expect
      .poll(() => browser.evaluate(() => document.querySelectorAll('[data-testid="subject-map"] img[src^="data:image/svg+xml"]').length), { timeout: 30_000 })
      .toBeGreaterThan(0)
    // A comp marker whose centre is inside the visible map (some sit past its edge)
    const point = (await browser.evaluate(() => {
      const map = document.querySelector('[data-testid="subject-map"]') as HTMLElement
      const m = map.getBoundingClientRect()
      const markers = [...map.querySelectorAll('img[src^="data:image/svg+xml"]')] as HTMLElement[]
      for (const marker of markers) {
        const r = marker.getBoundingClientRect()
        // The circle with the card number is at the marker's left edge
        const x = r.x + 12
        const y = r.y + r.height / 2
        if (x > m.left + 40 && x < m.right - 40 && y > m.top + 40 && y < m.bottom - 40) return { x, y }
      }
      return null
    })) as { x: number; y: number } | null
    expect(point, 'a comp marker is inside the visible map').not.toBeNull()
    const panel = screen.getByRole('dialog', 'Comp beside the subject property')
    const target = point as { x: number; y: number }
    // Approach in steps so the map sees the pointer enter the marker
    await browser.mouse.move(target.x - 40, target.y - 40)
    await browser.mouse.move(target.x - 8, target.y - 8)
    await browser.mouse.move(target.x, target.y)
    await expect(panel).toBeVisible()
    // Record the panel's opacity while it closes
    await browser.evaluate(() => {
      const w = window as unknown as { __opacity: Array<number | null> }
      w.__opacity = []
      const id = setInterval(() => {
        const el = document.querySelector('[role="dialog"][aria-label="Comp beside the subject property"]')
        w.__opacity.push(el ? Number(getComputedStyle(el).opacity) : null)
      }, 16)
      setTimeout(() => clearInterval(id), 3000)
      return true
    })
    await browser.mouse.move(5, 5)
    await expect(panel).toBeHidden({ timeout: 5000 })
    const opacity = (await browser.evaluate(() => (window as unknown as { __opacity: Array<number | null> }).__opacity)) as Array<number | null>
    expect(opacity.some((v) => v !== null && v > 0.05 && v < 0.95), 'it faded rather than cut out').toBe(true)
  })

  test('the comp dialog opens, and fades out when closed', WEB, async (fx) => {
    const { screen, browser } = fx
    await openLoadedSearch(fx)
    const card = browser.locator('[data-card-key]:not([data-card-key="subject"])').first()
    await card.scrollIntoView()
    const box = (await card.boundingBox()) as Rect
    await card.tap({ position: { x: 120, y: box.height - 40 } })
    const dialog = screen.getByRole('dialog', 'Comparable Details')
    await expect(dialog).toBeVisible()
    await browser.evaluate(() => {
      const w = window as unknown as { __opacity: Array<number | null> }
      w.__opacity = []
      const id = setInterval(() => {
        const el = document.querySelector('[role="dialog"]:not([aria-label="Comp beside the subject property"])')
        w.__opacity.push(el ? Number(getComputedStyle(el).opacity) : null)
      }, 16)
      setTimeout(() => clearInterval(id), 2500)
      return true
    })
    await browser.keyboard.press('Escape')
    await expect(dialog).toBeHidden({ timeout: 5000 })
    const opacity = (await browser.evaluate(() => (window as unknown as { __opacity: Array<number | null> }).__opacity)) as Array<number | null>
    expect(opacity.some((v) => v !== null && v > 0.05 && v < 0.95), 'it faded rather than cut out').toBe(true)
    // And it can open again
    await card.tap({ position: { x: 120, y: box.height - 40 } })
    await expect(dialog).toBeVisible()
  })

  test('each wheel notch lands the next row of comps flush under the bar, up and down', WEB, async (fx) => {
    const { browser } = fx
    await openLoadedSearch(fx)
    type Step = { scrollTop: number; gap: number | null }
    const run = (await browser.evaluate(async () => {
      const bar = document.querySelector('[data-comps-anchor]') as HTMLElement
      let pane: HTMLElement | null = bar
      while (pane && !['auto', 'scroll'].includes(getComputedStyle(pane).overflowY)) pane = pane.parentElement
      if (!pane) throw new Error('no scrolling pane')
      const scroller = pane
      const settle = async () => {
        let last = -1
        let still = 0
        while (still < 8) {
          await new Promise((r) => setTimeout(r, 50))
          still = scroller.scrollTop === last ? still + 1 : 0
          last = scroller.scrollTop
        }
      }
      const gap = () => {
        const barBottom = bar.getBoundingClientRect().bottom
        const cards = [...scroller.querySelectorAll('[data-card-key]')].filter((c) => (c as HTMLElement).dataset.cardKey !== 'subject')
        const tops = cards.map((c) => c.getBoundingClientRect()).filter((r) => r.height > 0 && r.top >= barBottom - 2).sort((a, b) => a.top - b.top)
        return tops.length ? Math.round(tops[0].top - barBottom) : null
      }
      const notch = async (deltaY: number) => {
        scroller.dispatchEvent(new WheelEvent('wheel', { deltaY, deltaMode: 0, bubbles: true, cancelable: true }))
        await settle()
        return { scrollTop: Math.round(scroller.scrollTop), gap: gap() }
      }
      const down: Array<{ scrollTop: number; gap: number | null }> = []
      for (let i = 0; i < 4; i++) down.push(await notch(100))
      const up: Array<{ scrollTop: number; gap: number | null }> = []
      for (let i = 0; i < 4; i++) up.push(await notch(-100))
      return { down, up }
    })) as { down: Step[]; up: Step[] }

    // Strictly increasing going down, and every landing has a row flush under the bar
    for (let i = 1; i < run.down.length; i++) expect(run.down[i].scrollTop).toBeGreaterThan(run.down[i - 1].scrollTop)
    for (const step of run.down) expect(step.gap, 'a row sits 8px under the bar').toBeLessThanOrEqual(12)
    // Going up retraces the same positions and ends at the top
    expect(run.up.map((s) => s.scrollTop).slice(0, 3)).toEqual([run.down[2].scrollTop, run.down[1].scrollTop, run.down[0].scrollTop])
    expect(run.up[3].scrollTop).toBeLessThan(5)
  })
})

describe('phone width', () => {
  for (const path of ['/dashboard/api-hub', '/dashboard/evaluation-settings']) {
    test(`${path} does not scroll sideways`, WEB, async ({ app, screen, browser }) => {
      await browser.setViewport({ width: 390, height: 844 })
      await app.open(path)
      await expect(screen.getByRole('heading', { level: 1 })).toBeVisible()
      const overflow = (await browser.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) as number
      expect(overflow, 'the tab strip scrolls inside itself, not the page').toBeLessThanOrEqual(1)
    })
  }
})
