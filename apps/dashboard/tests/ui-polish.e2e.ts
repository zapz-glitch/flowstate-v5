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
  { path: '/dashboard/batch', title: 'Batch Import' },
  { path: '/dashboard/seo', title: 'SEO Engine' },
  { path: '/dashboard/cdarv', title: 'CDARV' },
  // Admin Panel, User Management and Observability also use PageHeader, but the
  // local test user is not an admin and is redirected, so they are not checked here.
]

describe('page headers are title only on every dashboard page', () => {
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

describe('Offers', () => {
  test('the Evaluating tile icon is still, Ready is not a check mark, and Next up is gone', WEB, async ({ app, screen, browser }) => {
    await app.open('/dashboard/give-offer')
    await expect(screen.getByRole('heading', 'Offers', { level: 1 })).toBeVisible()
    await expect.poll(() => browser.evaluate(() => [...document.querySelectorAll('svg')].length > 0)).toBe(true)
    // The tile for the Evaluating bucket (not the progress rings in the list below it)
    const tile = (await browser.evaluate(() => {
      const el = [...document.querySelectorAll('button')].find((b) => /^Evaluating/i.test((b.textContent ?? '').trim()) && b.querySelector('svg'))
      if (!el) return null
      return { icons: el.querySelectorAll('svg').length, spinning: [...el.querySelectorAll('svg')].some((v) => getComputedStyle(v).animationName !== 'none') }
    })) as { icons: number; spinning: boolean } | null
    expect(tile, 'the Evaluating tile has an icon').not.toBeNull()
    expect(tile!.spinning).toBe(false)
    // Ready uses its own icon, not the check mark
    const readyHasCheck = (await browser.evaluate(() => {
      const el = [...document.querySelectorAll('button')].find((b) => /^Ready/i.test((b.textContent ?? '').trim()) && b.querySelector('svg'))
      return !!el?.querySelector('svg.lucide-check')
    })) as boolean
    expect(readyHasCheck).toBe(false)
    // The "Next up" shortcut above the tiles is gone
    await expect(screen.getByText('Next up', { exact: false })).toHaveCount(0)
  })
})

describe('Skin prototype', () => {
  type Page = { evaluate: (fn: () => unknown) => Promise<unknown> }
  const skin = (browser: Page) => browser.evaluate(() => document.documentElement.dataset.skin ?? 'none') as Promise<string>
  const stored = (browser: Page) => browser.evaluate(() => localStorage.getItem('flowstate:skin-preview') ?? 'none') as Promise<string>
  const switches = (browser: Page) => browser.evaluate(() => {
    const all = [...document.querySelectorAll('[aria-label="Skin prototype"]')]
    return { count: all.length, onBody: all.every((el) => el.parentElement === document.body) }
  }) as Promise<{ count: number; onBody: boolean }>
  const clearChoice = (browser: Page) => browser.evaluate(() => { localStorage.removeItem('flowstate:skin-preview'); return true })

  test('it is off by default, and leaving Property Search by the app\'s own links takes the skin and the switch with it', WEB, async ({ app, screen, browser }) => {
    await app.open('/dashboard/analyze?address=')
    await clearChoice(browser)
    await app.open('/dashboard/analyze?address=')
    await expect(screen.getByRole('button', 'Studio')).toBeVisible()
    expect(await skin(browser), 'the current look is the default').toBe('none')
    expect(await switches(browser), 'one switch, drawn on <body>').toEqual({ count: 1, onBody: true })
    await screen.getByRole('button', 'Studio').click()
    await expect.poll(() => skin(browser)).toBe('nds')
    // Leave through the sidebar: a client-side move in the SAME document, so only the page's own cleanup can
    // remove the attribute (a fresh page load would hide a missing cleanup)
    await browser.evaluate(() => { (window as unknown as { __sameDocument: boolean }).__sameDocument = true; return true })
    await screen.getByRole('link', 'Property Reports').first().click()
    await expect(screen.getByRole('heading', 'Property Reports', { level: 1 })).toBeVisible()
    expect((await browser.evaluate(() => (window as unknown as { __sameDocument?: boolean }).__sameDocument === true)) as boolean, 'the document was not reloaded').toBe(true)
    expect(await skin(browser), 'Studio ends when Property Search is left').toBe('none')
    // The switch lives on every dashboard page now (the America look applies everywhere), but Studio is offered only on Property Search
    expect(await switches(browser)).toEqual({ count: 1, onBody: true })
    await expect(screen.getByRole('button', 'Studio')).toHaveCount(0)
    await expect(screen.getByRole('button', 'America')).toBeVisible()
    // Back: the skin and exactly one switch return
    await browser.back()
    await expect(screen.getByRole('button', 'Studio')).toBeVisible()
    await expect.poll(() => skin(browser)).toBe('nds')
    expect(await switches(browser)).toEqual({ count: 1, onBody: true })
    await screen.getByRole('button', 'Current').click()
    await expect.poll(() => skin(browser)).toBe('none')
    await clearChoice(browser)
  })

  test('the America look applies on every dashboard page and comes off with Current', WEB, async ({ app, screen, browser }) => {
    await app.open('/dashboard?skin=america')
    await expect.poll(() => skin(browser)).toBe('america')
    const ink = () => browser.evaluate(() => getComputedStyle(document.body).color) as Promise<string>
    const navy = await ink()
    for (const [link, title] of [['Property Reports', 'Property Reports'], ['Offers', 'Offers'], ['Tasks', 'Tasks']] as const) {
      await screen.getByRole('link', link).first().click()
      await expect(screen.getByRole('heading', title, { level: 1 })).toBeVisible()
      expect(await skin(browser), `${title} keeps the look`).toBe('america')
      // Titles speak in the serif
      expect((await browser.evaluate(() => getComputedStyle(document.querySelector('h1')!).fontFamily)) as string).toMatch(/serif/i)
    }
    await screen.getByRole('button', 'Current').click()
    await expect.poll(() => skin(browser)).toBe('none')
    expect(await ink(), 'the ink goes back').not.toBe(navy)
    await clearChoice(browser)
  })

  test('?skin= in the address: nds turns it on and is remembered, off turns it off and forgets, anything else changes nothing', WEB, async ({ app, screen, browser }) => {
    await app.open('/dashboard/analyze?address=')
    await clearChoice(browser)
    await app.open('/dashboard/analyze?address=&skin=nds')
    await expect.poll(() => skin(browser)).toBe('nds')
    await expect.poll(() => stored(browser)).toBe('nds')
    // An unknown value is ignored: the remembered choice stands
    await app.open('/dashboard/analyze?address=&skin=garbage')
    await expect(screen.getByRole('button', 'Studio')).toBeVisible()
    await expect.poll(() => skin(browser)).toBe('nds')
    await app.open('/dashboard/analyze?address=&skin=off')
    await expect(screen.getByRole('button', 'Studio')).toBeVisible()
    await expect.poll(() => stored(browser)).toBe('none')
    expect(await skin(browser)).toBe('none')
  })

  test('a choice made with the switch replaces ?skin=, and the switch stays out of the page and off the phone nav', WEB, async ({ app, screen, browser }) => {
    await app.open('/dashboard/analyze?address=&skin=nds')
    await expect.poll(() => skin(browser)).toBe('nds')
    await screen.getByRole('button', 'Current').click()
    await expect.poll(() => skin(browser)).toBe('none')
    // The address no longer says nds, so a reload cannot bring the skin back
    expect((await browser.evaluate(() => location.search)) as string).not.toContain('skin')
    await app.open('/dashboard/analyze?address=')
    await expect(screen.getByRole('button', 'Studio')).toBeVisible()
    expect(await skin(browser), 'Current survived the reload').toBe('none')
    // On a phone it sits above the bottom nav, never on it
    await browser.setViewport({ width: 390, height: 844 })
    const phone = (await browser.evaluate(() => {
      const sw = document.querySelector('[aria-label="Skin prototype"]')!.getBoundingClientRect()
      const navTops = [...document.querySelectorAll('a')].map((a) => a.getBoundingClientRect()).filter((r) => r.height > 0 && r.top > innerHeight - 80).map((r) => r.top)
      return { switchBottom: Math.round(sw.bottom), navTop: navTops.length ? Math.round(Math.min(...navTops)) : -1 }
    })) as { switchBottom: number; navTop: number }
    expect(phone.navTop, 'the phone has a bottom nav').toBeGreaterThan(0)
    expect(phone.switchBottom, 'the switch ends above the nav').toBeLessThanOrEqual(phone.navTop)
    await browser.setViewport({ width: 1280, height: 720 })
    await clearChoice(browser)
  })

  /** Everything the skin promises, read from the live page. Throws if a thing it looks for is missing. */
  const readSkin = (browser: Page) => browser.evaluate(() => {
    const need = (sel: string, root: ParentNode = document) => { const e = root.querySelector(sel); if (!e) throw new Error(`nothing matches ${sel}`); return e }
    const css = (el: Element, prop: string) => getComputedStyle(el).getPropertyValue(prop)
    const all = (sel: string) => [...document.querySelectorAll(sel)]
    // A compiled rule that pairs the skin selector with the universal selector recolors the whole page
    const leaks: string[] = []
    const walk = (rules: CSSRuleList) => {
      for (const rule of Array.from(rules)) {
        const nested = (rule as CSSGroupingRule).cssRules
        if (nested) walk(nested)
        const text = (rule as CSSStyleRule).selectorText
        if (text && text.includes('data-skin') && text.split(',').some((part) => /(^|\s)\*$/.test(part.trim()))) leaks.push(text.slice(0, 80))
      }
    }
    for (const sheet of Array.from(document.styleSheets)) { try { walk(sheet.cssRules) } catch { /* cross-origin sheet */ } }
    const main = need('.playground-bg')
    let tightSmall = 0
    const fonts = new Set<string>()
    for (const el of Array.from(main.querySelectorAll('*'))) {
      if (el.closest('[data-testid="subject-map"]')) continue
      const c = getComputedStyle(el)
      if (el.childElementCount === 0 && (el.textContent ?? '').trim() && parseFloat(c.fontSize) < 14 && parseFloat(c.letterSpacing) < 0) tightSmall++
      if (el.classList.contains('uppercase')) fonts.add(c.fontFamily)
    }
    const cards = all('[data-card-key]')
    const out = all('[data-in-arv="false"]')
    const outPhoto = out.map((c) => c.querySelector('img')).find((img): img is HTMLImageElement => !!img)
    const emptyBox = out.map((c) => c.querySelector('button[aria-pressed="false"] > span > svg')).find(Boolean)
    const median = document.querySelector('[data-stamp="median"]')
    return JSON.stringify({
      leaks, tightSmall, labelFonts: [...fonts], bodyFont: css(document.body, 'font-family'),
      page: css(main, 'background-color'), pageImage: css(main, 'background-image'),
      cardFills: [...new Set(cards.map((c) => css(c, 'background-color')))],
      valuation: css(need('[data-surface="card"]:has(.hero-stats)'), 'background-color'),
      toolbar: css(need('[data-surface="card"]'), 'background-color'),
      hairline: css(need('[data-card-key]:not([data-card-key="subject"])'), 'border-top-color'),
      checkedBox: css(need('[data-card-key] button[aria-pressed="true"] > span'), 'border-top-color'),
      tabs: all('[data-comps-anchor] button[aria-pressed]').map((b) => css(b, 'background-color')),
      tabOn: css(need('[data-comps-anchor] button[aria-pressed="true"]'), 'background-color'),
      prep: css(need('[data-deal="prep"]'), 'background-color'),
      outline: css(need('[data-deal="decline"]'), 'border-top-color'),
      minControl: Math.min(...all('[data-deal], [data-comps-anchor] button').map((e) => Math.round(e.getBoundingClientRect().height))),
      radii: [...new Set(all('[data-deal], [data-comps-anchor] button').map((e) => css(e, 'border-top-left-radius')))],
      outCount: out.length, outCardOpacity: [...new Set(out.map((c) => css(c, 'opacity')))],
      outPhotoOpacity: outPhoto ? css(outPhoto, 'opacity') : 'no photo', ghostTick: emptyBox ? css(emptyBox, 'opacity') : 'no box',
      median: median ? `${css(median, 'background-color')} | ${css(median, 'color')}` : 'none',
      green: (() => { const e = document.querySelector('.text-emerald-600'); return e ? css(e, 'color') : 'none' })(),
      subjectChip: (() => { const e = document.querySelector('[data-card-key="subject"] [class~="bg-primary/90"] span'); return e ? css(e, 'color') : 'none' })(),
      figureWeight: css(need('.hero-stats .font-bold'), 'font-weight'),
      card: css(need('[data-card-key="subject"]'), 'background-color'), cardInk: css(need('[data-card-key="subject"]'), 'color'),
    })
  }).then((v) => JSON.parse(v as string))

  test('the Studio skin, light: data on white, borders keep their colors, one ink for filled things, nothing small is tightened', WEB, async (fx) => {
    const { browser, screen } = fx
    await openLoadedSearch(fx)
    const off = await readSkin(browser)
    await screen.getByRole('button', 'Studio').click()
    await expect.poll(async () => (await readSkin(browser)).card).not.toBe(off.card)
    await new Promise((resolve) => setTimeout(resolve, 700)) // let color transitions settle
    const on = await readSkin(browser)
    expect(on.leaks, 'no skin rule is merged into the universal rule').toEqual([])
    // Surfaces: every card, the valuation box and the top bar are one white; the page is flat gray with no gradient
    expect(on.cardFills, 'every subject and comp card has the same fill').toEqual(['rgb(255, 255, 255)'])
    expect(on.valuation).toBe('rgb(255, 255, 255)')
    expect(on.toolbar).toBe('rgb(255, 255, 255)')
    expect(on.page).toBe('rgb(242, 242, 242)')
    expect(on.pageImage).toBe('none')
    expect(off.cardFills, 'with the skin off a comp card has no fill of its own').toContain('rgba(0, 0, 0, 0)')
    // Borders: the hairline is the 10% ink value, and a colored border (the checked ARV box) is not flattened to it
    expect(on.hairline).toBe('rgb(218, 218, 218)')
    expect(on.checkedBox).toBe('rgb(4, 120, 87)')
    // Controls: the selected tab is the same ink as Prep offer, the other tabs are not filled, one radius, 24px minimum
    expect(on.tabOn).toBe(on.prep)
    expect(on.prep).toBe('rgb(28, 28, 28)')
    expect(on.tabs.filter((fill: string) => fill === on.tabOn).length, 'only the selected tab is filled').toBe(1)
    expect(on.outline, 'outlined buttons have an edge that can be seen').toBe('rgba(1, 1, 1, 0.45)')
    expect(on.radii).toEqual(['6px'])
    expect(on.minControl).toBeGreaterThanOrEqual(24)
    // Comps left out of the ARV: numbers at full strength, photo dimmed, and an empty box shows no ghost tick
    expect(on.outCount, 'this report has comps left out of the ARV').toBeGreaterThan(0)
    expect(on.outCardOpacity).toEqual(['1'])
    expect(off.outCardOpacity).toEqual(['0.7'])
    expect(Number(on.outPhotoOpacity)).toBeLessThan(1)
    expect(on.ghostTick).toBe('0')
    // Meaning colors: green text is the readable step; MEDIAN sits on the card's own surface
    expect(on.green).toBe('rgb(4, 120, 87)')
    if (on.median !== 'none') expect(on.median).toBe('rgb(255, 255, 255) | rgb(1, 1, 1)')
    // Type: nothing under 14px is tightened anywhere in the page, labels stay in the page's typeface, figures are 600
    expect(on.tightSmall).toBe(0)
    expect(on.labelFonts).toEqual([on.bodyFont])
    expect(on.figureWeight).toBe('600')
    // Back to Current: the cards lose their fill and the left-out cards dim as before
    await screen.getByRole('button', 'Current').click()
    await expect.poll(async () => (await readSkin(browser)).outCardOpacity).toEqual(['0.7'])
    expect((await readSkin(browser)).cardFills).toContain('rgba(0, 0, 0, 0)')
    await clearChoice(browser)
  })

  test('the Studio skin, dark: warm black, cream ink, and nothing left pure white or unreadable', WEB, async (fx) => {
    const { browser, app } = fx
    await openLoadedSearch(fx)
    // Remember the theme this browser had, switch to dark with the skin on, and put it back at the end
    const themeBefore = (await browser.evaluate(() => {
      const before = localStorage.getItem('fs-theme')
      localStorage.setItem('fs-theme', 'dark'); localStorage.setItem('flowstate:skin-preview', 'nds')
      return before ?? ''
    })) as string
    try {
      await app.open('/dashboard/analyze')
      await expect(browser.locator('[data-card-key="subject"]')).toBeVisible({ timeout: 30_000 })
      await expect.poll(() => skin(browser)).toBe('nds')
      expect((await browser.evaluate(() => document.documentElement.classList.contains('dark'))) as boolean, 'the page is in dark').toBe(true)
      await new Promise((resolve) => setTimeout(resolve, 700))
      const on = await readSkin(browser)
      expect(on.leaks).toEqual([])
      expect(on.page).toBe('rgb(13, 5, 5)')
      expect(on.cardFills).toEqual(['rgb(22, 13, 13)'])
      expect(on.cardInk, 'cream ink, not white').toBe('rgb(253, 251, 237)')
      // Filled things are cream with ink words; the selected tab matches Prep offer
      expect(on.prep).toBe('rgb(253, 251, 237)')
      expect(on.tabOn).toBe(on.prep)
      // MEDIAN takes the dark card's surface (it was the one pure-white thing on the page)
      if (on.median !== 'none') expect(on.median).toBe('rgb(22, 13, 13) | rgb(253, 251, 237)')
      // SUBJECT on the photo: ink words on the cream chip (white on cream could not be read)
      expect(on.subjectChip).not.toBe('rgb(255, 255, 255)')
      // Green text keeps the app's own lighter emerald in dark; only light is darkened
      expect(on.green).not.toBe('rgb(4, 120, 87)')
      expect(on.tightSmall).toBe(0)
    } finally {
      await browser.evaluate((before: string) => {
        if (before) localStorage.setItem('fs-theme', before); else localStorage.removeItem('fs-theme')
        localStorage.removeItem('flowstate:skin-preview')
        return true
      }, themeBefore)
    }
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

  test('the comp stats sit in the subject card foot, on the same row as Prep offer, and are not repeated above the comps', WEB, async (fx) => {
    const { browser, screen } = fx
    await openLoadedSearch(fx)
    const card = browser.locator('[data-card-key="subject"]')
    const stats = card.getByText(/^\d+ selected/)
    await expect(stats).toBeVisible()
    await expect(card.getByText('excluded', { exact: false })).toBeVisible()
    await expect(card.getByText('/sf avg', { exact: false })).toBeVisible()
    // Only one copy on the whole page
    await expect(screen.getByText(/^\d+ selected/)).toHaveCount(1)
    // Left of Prep offer, and on the same line when the card is wide enough
    const s = (await stats.boundingBox()) as Rect
    const prep = (await card.getByRole('button', 'Prep offer').boundingBox()) as Rect
    // The stats block is the first line's parent; read its box in the page
    const block = (await browser.evaluate(() => {
      const line = [...document.querySelectorAll('[data-card-key="subject"] div')].find((e) => /^\d+ selected/.test(e.textContent ?? '') && e.children.length === 0)
      const r = line?.parentElement?.getBoundingClientRect()
      const card = document.querySelector('[data-card-key="subject"]')!.getBoundingClientRect()
      return r ? { y: r.y, height: r.height, cardWidth: card.width } : null
    })) as { y: number; height: number; cardWidth: number } | null
    expect(block).not.toBeNull()
    if (block!.cardWidth >= 540) {
      expect(s.x, 'stats left of Prep offer').toBeLessThan(prep.x)
      expect(prep.y, 'beside the stats, not under them').toBeLessThan(block!.y + block!.height - 4)
    } else {
      // A narrow card puts the buttons under the stats, still inside the same foot strip
      expect(prep.y, 'under the stats').toBeGreaterThan(s.y)
    }
  })

  test('clicking the ARV number swaps in an edit box of the same size, in the same place', WEB, async (fx) => {
    const { browser } = fx
    await openLoadedSearch(fx)
    const read = (sel: string) => browser.evaluate((q: string) => {
      const el = document.querySelector(q) as HTMLElement | null
      if (!el) return null
      const r = el.getBoundingClientRect()
      const tile = el.closest('.border-r') as HTMLElement | null
      return { x: r.x, y: r.y, h: r.height, tileH: tile ? tile.getBoundingClientRect().height : 0, tileW: tile ? tile.getBoundingClientRect().width : 0 }
    }, sel) as Promise<{ x: number; y: number; h: number; tileH: number; tileW: number } | null>
    await expect.poll(() => read('button[title^="Click to set a manual ARV"]')).not.toBeNull()
    const before = (await read('button[title^="Click to set a manual ARV"]'))!
    await browser.evaluate(() => { (document.querySelector('button[title^="Click to set a manual ARV"]') as HTMLElement).click(); return true })
    await expect.poll(() => read('input[aria-label="Manual ARV"]')).not.toBeNull()
    // The box is the input's parent; its "$" starts where the number started
    const after = (await browser.evaluate(() => {
      const box = document.querySelector('input[aria-label="Manual ARV"]')!.parentElement as HTMLElement
      const dollar = box.querySelector('span') as HTMLElement
      const tile = box.closest('.border-r') as HTMLElement
      const r = box.getBoundingClientRect()
      return { boxY: r.y, boxH: r.height, textX: dollar.getBoundingClientRect().x, tileH: tile.getBoundingClientRect().height, tileW: tile.getBoundingClientRect().width }
    })) as { boxY: number; boxH: number; textX: number; tileH: number; tileW: number }
    expect(Math.abs(after.textX - before.x), 'text starts at the same left edge').toBeLessThan(1.5)
    expect(Math.abs(after.boxY - before.y), 'same top').toBeLessThan(1.5)
    expect(Math.abs(after.boxH - before.h), 'same height as the number').toBeLessThan(1.5)
    expect(Math.abs(after.tileH - before.tileH), 'the tile does not grow or shrink').toBeLessThan(1.5)
    expect(Math.abs(after.tileW - before.tileW), 'nor get wider').toBeLessThan(1.5)
    // Leave no trace: an emptied box commits nothing when it loses focus (a filled one would save a manual ARV on the report)
    await browser.evaluate(() => {
      const input = document.querySelector('input[aria-label="Manual ARV"]') as HTMLInputElement
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      set.call(input, '')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.blur()
      return true
    })
    await expect.poll(() => read('input[aria-label="Manual ARV"]')).toBeNull()
  })

  test('Re-run holds the screen steady: nothing moves, the results dim, and the step label floats', WEB, async (fx) => {
    const { browser } = fx
    await openLoadedSearch(fx)
    // The Re-run request never reaches the server: it stalls, then fails, after the measurements below
    await browser.route('**/dashboard/analyze', async (route) => {
      const request = route.request
      if (request.method === 'POST' && (request.postData ?? '').includes('skipCache')) {
        await new Promise((resolve) => setTimeout(resolve, 2500))
        return route.abort()
      }
      return route.continue()
    })
    const snapshot = () => browser.evaluate(() => {
      const r = (el: Element | null | undefined) => { if (!el) return null; const b = el.getBoundingClientRect(); return [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)] }
      const btn = (t: string) => [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').trim().startsWith(t))
      return JSON.stringify({
        prep: r(btn('Prep offer')), rerun: r(document.querySelector('button[title^="Re-run"]')), settings: r(btn('Evaluation')),
        subject: r(document.querySelector('[data-card-key="subject"]')), firstCard: r(document.querySelector('.comps-grid > *')),
        held: document.querySelectorAll('[aria-busy="true"]').length,
        dimmed: [...document.querySelectorAll('[aria-busy="true"]')].every((e) => Number(getComputedStyle(e).opacity) < 0.9),
      })
    })
    await expect.poll(() => browser.evaluate(() => !!document.querySelector('.comps-grid > *'))).toBe(true)
    const before = JSON.parse((await snapshot()) as string)
    await browser.evaluate(() => { (document.querySelector('button[title^="Re-run"]') as HTMLElement).click(); return true })
    await expect.poll(async () => JSON.parse((await snapshot()) as string).held).toBeGreaterThan(0)
    await new Promise((resolve) => setTimeout(resolve, 600)) // let the dim finish
    const during = JSON.parse((await snapshot()) as string)
    expect(during.dimmed, 'the held results are dimmed').toBe(true)
    // Nothing the person is looking at has moved or resized
    for (const key of ['prep', 'rerun', 'settings', 'subject', 'firstCard']) {
      expect(during[key], `${key} stays where it was`).toEqual(before[key])
    }
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

  test('the subject photo and the comp photos open Street View in a new tab', WEB, async (fx) => {
    const { browser } = fx
    await openLoadedSearch(fx)
    const subjectLink = browser.locator('[data-card-key="subject"] a[title="Open Street View"]')
    await expect(subjectLink).toBeVisible()
    await expect(subjectLink).toHaveAttribute('target', '_blank')
    expect(String(await subjectLink.getAttribute('href'))).toMatch(/^https:\/\/www\.google\.com\/maps\//)
    const compLink = browser.locator('[data-card-key]:not([data-card-key="subject"]) a[title="Open Street View"]').first()
    await expect(compLink).toBeVisible()
    expect(String(await compLink.getAttribute('href'))).toMatch(/^https:\/\/www\.google\.com\/maps\//)
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
    // Both photos in the panel, the comp's and the subject's, open Street View
    await expect(browser.locator('[role="dialog"][aria-label="Comp beside the subject property"] a[title="Open Street View"]')).toHaveCount(2)
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

  /** The centre of a comp marker's numbered dot, inside the visible map (some markers sit past its edge) */
  async function visibleMarkerPoint(browser: { evaluate: (fn: () => unknown) => Promise<unknown> }, poll: (fn: () => Promise<number>) => Promise<void>) {
    await poll(() => browser.evaluate(() => document.querySelectorAll('[data-testid="subject-map"] img[src^="data:image/svg+xml"]').length) as Promise<number>)
    const point = (await browser.evaluate(() => {
      const map = document.querySelector('[data-testid="subject-map"]') as HTMLElement
      const m = map.getBoundingClientRect()
      for (const marker of [...map.querySelectorAll('img[src^="data:image/svg+xml"]')] as HTMLElement[]) {
        const r = marker.getBoundingClientRect()
        const x = r.x + 12
        const y = r.y + r.height / 2
        if (x > m.left + 40 && x < m.right - 40 && y > m.top + 40 && y < m.bottom - 40) return { x, y }
      }
      return null
    })) as { x: number; y: number } | null
    expect(point, 'a comp marker is inside the visible map').not.toBeNull()
    return point as { x: number; y: number }
  }
  const PANEL = '[role="dialog"][aria-label="Comp beside the subject property"]'
  const panelCount = (browser: { evaluate: (fn: (sel: string) => unknown, arg: string) => Promise<unknown> }) =>
    browser.evaluate((sel: string) => document.querySelectorAll(sel).length, PANEL) as Promise<number>
  const waitMs = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
  const markersReady = (browser: { evaluate: (fn: () => unknown) => Promise<unknown> }) => () =>
    expect.poll(() => browser.evaluate(() => document.querySelectorAll('[data-testid="subject-map"] img[src^="data:image/svg+xml"]').length), { timeout: 30_000 }).toBeGreaterThan(0)

  test('a quick sweep across a marker opens nothing, and neither does a drag', WEB, async (fx) => {
    const { browser } = fx
    await openLoadedSearch(fx)
    const target = await visibleMarkerPoint(browser, async () => { await markersReady(browser)() })
    // Pass over the marker in well under the rest time
    await browser.mouse.move(target.x - 40, target.y)
    await browser.mouse.move(target.x, target.y)
    await browser.mouse.move(5, 5) // off the marker and its price tag
    await waitMs(700)
    expect(await panelCount(browser), 'a sweep is not a hover').toBe(0)
    // Press on the marker and drag: still not a hover, and not right after it either
    await browser.mouse.move(target.x, target.y)
    await browser.mouse.down()
    await browser.mouse.move(target.x + 30, target.y + 20)
    await browser.mouse.move(target.x + 60, target.y + 40)
    await waitMs(500)
    await browser.mouse.up()
    await browser.mouse.move(5, 5)
    await waitMs(200)
    expect(await panelCount(browser), 'a drag is not a hover').toBe(0)
  })

  test('clicking a marker pins its card; Escape, a click elsewhere, or leaving the card closes it', WEB, async (fx) => {
    const { browser, screen } = fx
    await openLoadedSearch(fx)
    const target = await visibleMarkerPoint(browser, async () => { await markersReady(browser)() })
    const panel = screen.getByRole('dialog', 'Comp beside the subject property')
    const open = async () => {
      await browser.mouse.move(target.x - 30, target.y - 30)
      await browser.mouse.move(target.x, target.y)
      await browser.mouse.down()
      await browser.mouse.up()
      await expect(panel).toBeVisible()
    }
    // 1. Pinned: still there after the pointer has sat still for a good while
    await open()
    await waitMs(900)
    expect(await panelCount(browser), 'the card stays after a click').toBe(1)
    // 2. Escape closes it
    await browser.keyboard.press('Escape')
    await expect(panel).toBeHidden({ timeout: 5000 })
    // 3. A click somewhere else on the page closes it
    await open()
    await waitMs(300)
    await browser.mouse.move(target.x, target.y - 4)
    await browser.evaluate(() => { (document.querySelector('[data-testid="subject-map"]')!.parentElement as HTMLElement).click(); return true })
    await expect(panel).toBeHidden({ timeout: 5000 })
    // 4. Moving onto the card and off it again closes it
    await open()
    const box = (await browser.evaluate((sel: string) => { const r = document.querySelector(sel)!.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } }, PANEL)) as Rect
    await browser.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await waitMs(250)
    expect(await panelCount(browser), 'still open while the pointer is on it').toBe(1)
    await browser.mouse.move(5, 5)
    await expect(panel).toBeHidden({ timeout: 5000 })
  })

  test('each comp marker tag shows the sale price and how it matches the subject', WEB, async (fx) => {
    const { browser } = fx
    await openLoadedSearch(fx)
    await markersReady(browser)()
    const tags = (await browser.evaluate(() => [...document.querySelectorAll('[data-testid="subject-map"] img[src^="data:image/svg+xml"]')]
      .map((img) => decodeURIComponent((img as HTMLImageElement).src.split(',')[1] ?? ''))
      .map((svg) => [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1])))) as string[][]
    expect(tags.length).toBeGreaterThan(0)
    const words = ['Group + Neighborhood', 'Block group', 'Neighborhood', 'Outside']
    for (const lines of tags) {
      // [number, price, match word, and the condition when it is known] · no bullet, no price class
      expect(lines.length === 3 || lines.length === 4, 'number, price, match, optional condition').toBe(true)
      expect(lines[1], 'the sale price').toMatch(/^\$[\d.]+[kM]$/)
      expect(words, 'a plain match word').toContain(lines[2])
    }
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

describe('Existing Reports dialog', () => {
  test('opens for an address that already has a report, and fades out when closed', WEB, async ({ app, screen, browser }) => {
    // Never write: block non-GET API calls (the run is never started, we only close the dialog)
    await browser.route('**/user/reports/**', async (route) => {
      if (route.request.method === 'GET') await route.continue()
      else await route.abort()
    })
    await app.open('/dashboard/reports')
    const firstRow = screen.getByRole('link', 'View').first()
    await expect(firstRow).toBeVisible({ timeout: 30_000 })
    // The address of the first saved report, read from its row
    const address = (await browser.evaluate(() => {
      const link = [...document.querySelectorAll('a')].find((a) => a.textContent?.trim() === 'View')
      const row = link?.closest('tr')
      return row?.querySelector('td')?.textContent?.trim() ?? ''
    })) as string
    expect(address.length, 'the first report row has an address').toBeGreaterThan(5)
    await app.open(`/dashboard/analyze?address=${encodeURIComponent(address)}`)
    const dialog = screen.getByRole('dialog', 'Existing Reports Found')
    await expect(dialog).toBeVisible({ timeout: 30_000 })
    await browser.evaluate(() => {
      const w = window as unknown as { __opacity: Array<number | null> }
      w.__opacity = []
      const id = setInterval(() => {
        const el = document.querySelector('[role="dialog"]')
        w.__opacity.push(el ? Number(getComputedStyle(el).opacity) : null)
      }, 16)
      setTimeout(() => clearInterval(id), 2500)
      return true
    })
    // Cancel, not Escape: Escape can land before the dialog has taken focus
    await screen.getByRole('button', 'Cancel').tap()
    await expect(dialog).toBeHidden({ timeout: 5000 })
    const opacity = (await browser.evaluate(() => (window as unknown as { __opacity: Array<number | null> }).__opacity)) as Array<number | null>
    expect(opacity.some((v) => v !== null && v > 0.05 && v < 0.95), 'it faded rather than cut out').toBe(true)
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
