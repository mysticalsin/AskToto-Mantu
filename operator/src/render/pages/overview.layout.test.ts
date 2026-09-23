import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser } from 'playwright'
import { fixtureDashboard } from '../fixture'
import { SPA_CSS } from '../../spa/manifest'
import { renderOverview } from './overview'
import { renderRealtime } from './realtime'
import { shoot } from '../test-shots'

// MQA-340: keep the fifth KPI, map and fleet rows usable without narrow-view overflow.

const CTX = { now: 1_725_000_000_000, theme: 'light' as const }
let browser: Browser

beforeAll(async () => { browser = await chromium.launch({ headless: true }) })
afterAll(async () => { await browser?.close() }, 30_000)

describe('Overview responsive layout', () => {
  it('keeps spend cards and device rows aligned on desktop and narrow screens', async () => {
    const data = await fixtureDashboard()
    data.roi.portalDirect = '21991 tok · ≈$0.01 · estimate, list price'
    const page = await browser.newPage({ viewport: { width: 1000, height: 900 } })
    await page.setContent(`<style>${SPA_CSS}</style><main class="wrap">${renderOverview(data, CTX)}</main>`)

    const desktop = await page.evaluate(() => {
      const kpis = document.querySelector('[data-overview-kpis]')!
      const cards = [...kpis.querySelectorAll('.kpi')]
      const row = document.querySelector('[data-toplist-device]')!
      const card = document.querySelector('[data-device-card]')!
      const label = row.querySelector('span')!
      const works = document.querySelector('.works-path')!
      const map = document.querySelector('.geo-map-card .corner-map-svg')!
      return {
        cardRows: new Set(cards.map((el) => Math.round(el.getBoundingClientRect().top))).size,
        barPosition: getComputedStyle(row.querySelector('.vol-bar')!).position,
        labelInset: label.getBoundingClientRect().left - card.getBoundingClientRect().left,
        headerDisplay: getComputedStyle(document.querySelector('.vol-head')!).display,
        pairDisplay: getComputedStyle(document.querySelector('.ov-pair')!).display,
        worksDisplay: getComputedStyle(works).display,
        worksColumns: getComputedStyle(works).gridTemplateColumns.split(' ').length,
        mapHeight: map.getBoundingClientRect().height,
        overflow: document.documentElement.scrollWidth > innerWidth
      }
    })
    expect(desktop.cardRows).toBe(2)
    expect(desktop.barPosition).toBe('absolute')
    expect(desktop.labelInset).toBeLessThan(60)
    expect(desktop.headerDisplay).toBe('grid')
    expect(desktop.pairDisplay).toBe('grid')
    expect(desktop.worksDisplay).toBe('grid')
    expect(desktop.worksColumns).toBe(3)
    expect(desktop.mapHeight).toBeGreaterThan(180)
    expect(desktop.overflow).toBe(false)
    await shoot(page, 'overview-light', { legacyEnv: 'METIS_OVERVIEW_SCREENSHOT' })

    const mapLand = () => page.evaluate(() => {
      const neutral = [...document.querySelectorAll('.corner-map-svg path')]
        .find((path) => path.getAttribute('fill') === 'var(--map-land)')!
      return getComputedStyle(neutral).fill
    })
    const lightLand = await mapLand()
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
    expect(await mapLand()).not.toBe(lightLand)
    await shoot(page, 'overview-dark', { legacyEnv: 'METIS_OVERVIEW_SCREENSHOT_DARK' })

    await page.setViewportSize({ width: 390, height: 844 })
    const narrow = await page.evaluate(() => ({
      columns: getComputedStyle(document.querySelector('[data-overview-kpis]')!).gridTemplateColumns.split(' ').length,
      worksColumns: getComputedStyle(document.querySelector('.works-path')!).gridTemplateColumns.split(' ').length,
      overflow: document.documentElement.scrollWidth > innerWidth
    }))
    expect(narrow.columns).toBe(1)
    expect(narrow.worksColumns).toBe(1)
    expect(narrow.overflow).toBe(false)
    await shoot(page, 'overview-narrow', { legacyEnv: 'METIS_OVERVIEW_SCREENSHOT_NARROW' })
    await page.close()
  }, 30_000)

  it('does not impose Overview people-grid width on Realtime', async () => {
    const data = await fixtureDashboard()
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
    await page.setContent(`<style>${SPA_CSS}</style><main class="wrap">${renderRealtime(data, CTX)}</main>`)
    const layout = await page.evaluate(() => ({
      minWidth: getComputedStyle(document.querySelector('[data-live-presence] .rt-seat')!).minWidth,
      viewportOverflow: document.documentElement.scrollWidth > innerWidth
    }))
    expect(layout.minWidth).not.toBe('720px')
    expect(layout.viewportOverflow).toBe(false)
    await page.close()
  }, 30_000)
})
