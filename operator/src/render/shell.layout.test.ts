import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright'
import { NAV_IDS, type NavId } from '../nav'
import { SPA_CSS, SPA_CSS_PATH } from '../spa/manifest'
import { renderConsole } from '../ui'
import { fixtureDashboard } from './fixture'
import { shoot } from './test-shots'

// Operator UX Rock 1 shell regression (PLAN.md "Shell regression S"): every console page, at the
// desktop and phone viewports, with the real SPA_CSS and the full renderConsole() document.
// No client JS runs here; each page is activated the way operator/client/router.ts route() does
// it (only the matching [data-page] section loses `hidden`, the matching [data-nav] link gets
// `.on`), directly in the page.

const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 }
] as const

let browser: Browser
let html = ''

beforeAll(async () => {
  browser = await chromium.launch({ headless: true })
  const data = await fixtureDashboard()
  html = renderConsole(data, { theme: 'light' })
    // Inline the stylesheet; drop the client bundle (layout only, no JS).
    .replace(new RegExp(`<link rel="stylesheet" href="${SPA_CSS_PATH.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*>`), `<style>${SPA_CSS}</style>`)
    .replace(/<script [^>]*><\/script>/g, '')
})
afterAll(async () => {
  await browser?.close()
}, 30_000)

async function activate(page: Page, id: NavId): Promise<void> {
  await page.evaluate((target) => {
    document.querySelectorAll<HTMLElement>('[data-page]').forEach((section) => {
      section.hidden = section.getAttribute('data-page') !== target
    })
    document.querySelectorAll<HTMLElement>('[data-nav]').forEach((link) => {
      link.classList.toggle('on', link.getAttribute('data-nav') === target)
    })
  }, id)
}

describe('console shell layout (every NAV_IDS page, desktop + phone)', () => {
  it('inlines the real stylesheet (guards the harness itself)', () => {
    expect(html).toContain('<style>')
    expect(html).not.toContain(`href="${SPA_CSS_PATH}"`)
  })

  for (const vp of VIEWPORTS) {
    it(`${vp.width}x${vp.height}: no horizontal page overflow, one visible h1 per page${vp.width >= 1024 ? ', 288px sidebar' : ''}`, async () => {
      const page = await browser.newPage({ viewport: vp })
      await page.setContent(html)
      for (const id of NAV_IDS) {
        await activate(page, id)
        const m = await page.evaluate((target) => {
          const section = document.querySelector<HTMLElement>(`[data-page="${target}"]`)
          const visibleH1 = section
            ? [...section.querySelectorAll('h1')].filter((h) => {
                const r = h.getBoundingClientRect()
                return r.width > 0 && r.height > 0 && getComputedStyle(h).visibility !== 'hidden'
              }).length
            : -1
          const rail = document.getElementById('rail')
          return {
            scrollWidth: document.documentElement.scrollWidth,
            innerWidth,
            visibleH1,
            railWidth: rail ? Math.round(rail.getBoundingClientRect().width) : -1,
            railVisible: rail ? getComputedStyle(rail).visibility !== 'hidden' && rail.getBoundingClientRect().left >= 0 : false
          }
        }, id)
        expect(m.scrollWidth, `${id} @${vp.width}: page scrollWidth ${m.scrollWidth} > innerWidth ${m.innerWidth}`).toBeLessThanOrEqual(m.innerWidth)
        expect(m.visibleH1, `${id} @${vp.width}: visible h1 count`).toBe(1)
        if (vp.width >= 1024) {
          expect(m.railWidth, `${id}: sidebar width`).toBe(288)
          expect(m.railVisible, `${id}: sidebar visible`).toBe(true)
        }
        await shoot(page, `shell-${id}`)
      }
      await page.close()
    }, 120_000)
  }
})
