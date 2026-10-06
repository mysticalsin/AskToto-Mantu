import { resolve } from 'node:path'
import type { Browser, Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  bestNonTextContrastCandidate,
  compositeColors,
  contrastRatio,
  detectedFailureKinds,
  hasClippedTextBox,
  isLargeText,
  missingFailureKinds,
  pageHasHorizontalScroll,
  boxExtendsHorizontallyOutsideViewport,
  summarizeAudits,
  textContrastRequirement
} from './capture-audit.mjs'

describe('WCAG contrast helpers', () => {
  it('computes the black-on-white maximum contrast ratio', () => {
    expect(contrastRatio('#000', '#fff')).toBeCloseTo(21, 4)
  })

  it('keeps the AA body-text boundary honest for adjacent grays on white', () => {
    expect(contrastRatio('#767676', '#fff')).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio('#777777', '#fff')).toBeLessThan(4.5)
  })

  it('alpha-composites text before measuring contrast', () => {
    const composited = compositeColors('rgba(0, 0, 0, 0.5)', '#fff')
    expect(composited).toMatchObject({ r: 127.5, g: 127.5, b: 127.5, a: 1 })
    expect(contrastRatio(composited, '#fff')).toBeCloseTo(3.98, 2)
  })

  it('uses the WCAG large-text boundary exactly', () => {
    expect(isLargeText({ fontSizePx: 23.99, fontWeight: 400 })).toBe(false)
    expect(isLargeText({ fontSizePx: 24, fontWeight: 400 })).toBe(true)
    expect(isLargeText({ fontSizePx: 18.65, fontWeight: 700 })).toBe(false)
    expect(isLargeText({ fontSizePx: 18.66, fontWeight: 700 })).toBe(true)
    expect(textContrastRequirement({ fontSizePx: 18.66, fontWeight: 700 })).toBe(3)
    expect(textContrastRequirement({ fontSizePx: 18.65, fontWeight: 700 })).toBe(4.5)
  })

  it('uses the strongest border-or-fill candidate for non-text control contrast', () => {
    expect(
      bestNonTextContrastCandidate([
        { source: 'fill', ratio: 1.15 },
        { source: 'border', ratio: 4.2 }
      ])
    ).toEqual({ source: 'border', ratio: 4.2 })
  })
})

describe('clipping predicates', () => {
  it('fails visible text-bearing boxes clipped by hidden overflow or ellipsis', () => {
    expect(
      hasClippedTextBox({
        visible: true,
        textBearing: true,
        overflowX: 'hidden',
        overflowY: 'visible',
        textOverflow: 'clip',
        scrollWidth: 112,
        clientWidth: 100,
        scrollHeight: 20,
        clientHeight: 20
      })
    ).toBe(true)
    expect(
      hasClippedTextBox({
        visible: true,
        textBearing: true,
        overflowX: 'visible',
        overflowY: 'visible',
        textOverflow: 'ellipsis',
        scrollWidth: 100,
        clientWidth: 100,
        scrollHeight: 24,
        clientHeight: 20
      })
    ).toBe(true)
  })

  it('does not fail invisible, non-text or unclipped boxes', () => {
    const base = {
      visible: true,
      textBearing: true,
      overflowX: 'visible',
      overflowY: 'visible',
      textOverflow: 'clip',
      scrollWidth: 112,
      clientWidth: 100,
      scrollHeight: 20,
      clientHeight: 20
    }
    expect(hasClippedTextBox(base)).toBe(false)
    expect(hasClippedTextBox({ ...base, visible: false, overflowX: 'hidden' })).toBe(false)
    expect(hasClippedTextBox({ ...base, textBearing: false, overflowX: 'hidden' })).toBe(false)
  })

  it('detects page and element horizontal overflow with a one-pixel tolerance', () => {
    expect(pageHasHorizontalScroll({ documentWidth: 962, viewportWidth: 960 })).toBe(true)
    expect(pageHasHorizontalScroll({ documentWidth: 961, viewportWidth: 960 })).toBe(false)
    expect(boxExtendsHorizontallyOutsideViewport({ visible: true, left: -2, right: 100 }, 960)).toBe(true)
    expect(boxExtendsHorizontallyOutsideViewport({ visible: true, left: 0, right: 962 }, 960)).toBe(true)
    expect(boxExtendsHorizontallyOutsideViewport({ visible: true, left: -1, right: 961 }, 960)).toBe(false)
  })
})

describe('audit summaries', () => {
  it('summarizes per-kind checks, failures, unverifiable rows and the negative control', () => {
    const negativeControl = { detected: true, kinds: ['clipping', 'nonText', 'text'] }
    const summary = summarizeAudits(
      [
        {
          audit: {
            pass: false,
            text: { checked: 2, failures: [{ kind: 'contrast' }] },
            nonText: { checked: 1, failures: [] },
            clipping: { checked: 3, failures: [{ kind: 'text-clipped' }] },
            unverifiable: [{ kind: 'text', reason: 'background-image' }]
          }
        }
      ],
      negativeControl
    )
    expect(summary).toMatchObject({
      failures: 2,
      text: { checked: 2, failures: 1 },
      nonText: { checked: 1, failures: 0 },
      clipping: { checked: 3, failures: 1 },
      unverifiable: 1,
      negativeControl
    })
  })

  it('reports detected negative-control failure kinds without text content', () => {
    expect(
      detectedFailureKinds({
        text: { failures: [{ selector: 'p.low' }] },
        nonText: { failures: [{ selector: 'button.low' }] },
        clipping: { failures: [{ selector: 'span.clip' }] }
      })
    ).toEqual(['clipping', 'nonText', 'text'])
  })

  it('reports the negative-control kinds still missing from an audit', () => {
    expect(
      missingFailureKinds({
        text: { failures: [{ selector: 'p.low' }] },
        nonText: { failures: [] },
        clipping: { failures: [] }
      })
    ).toEqual(['clipping', 'nonText'])
  })
})

describe('in-page collector', () => {
  const auditScript = resolve(__dirname, 'capture-audit.mjs')
  let browser: Browser

  beforeAll(async () => {
    const { chromium } = await import('playwright')
    browser = await chromium.launch({ headless: true })
  })

  afterAll(async () => {
    await browser?.close()
  })

  /** Load `body` in a fresh page and install the collector the way capture-states.mjs does. */
  async function withCollector(body: string, run: (page: Page) => Promise<void>): Promise<void> {
    const page = await browser.newPage({ viewport: { width: 960, height: 640 } })
    try {
      await page.setContent(`<!doctype html><html><head></head><body>${body}</body></html>`, {
        waitUntil: 'domcontentloaded'
      })
      await page.addScriptTag({ path: auditScript, type: 'module' })
      await page.waitForFunction(() => typeof (globalThis as any).__DESIGN_CAPTURE_AUDIT__?.collect === 'function')
      await run(page)
    } finally {
      await page.close()
    }
  }

  // The tests tsconfig has no DOM lib: reach the page's globals through globalThis, which is window there.
  const collect = (page: Page): Promise<any> =>
    page.evaluate(() => (globalThis as any).__DESIGN_CAPTURE_AUDIT__.collect())

  /** The active element as `body` or `tag#id`. */
  const activeElement = (page: Page): Promise<string> =>
    page.evaluate(() => {
      const active = (globalThis as any).document.activeElement
      if (!active) return 'none'
      const tag = active.tagName.toLowerCase()
      return active.id ? `${tag}#${active.id}` : tag
    })

  it('fails an empty page as a vacuous audit instead of passing it', async () => {
    await withCollector('', async (page) => {
      const audit = await collect(page)
      expect(audit.text.checked).toBe(0)
      expect(audit.clipping.checked).toBe(0)
      expect(audit.text.failures).toContainEqual(expect.objectContaining({ kind: 'vacuous-audit' }))
      expect(audit.clipping.failures).toContainEqual(expect.objectContaining({ kind: 'vacuous-audit' }))
      expect(audit.pass).toBe(false)
    })
  })

  it('lists text over a gradient as unverifiable and never as a pass', async () => {
    await withCollector(
      '<p style="color:#000;background:#fff">Plain sample</p>' +
        '<div style="background-image:linear-gradient(#ffffff, #000000)"><p style="color:#000">Gradient sample</p></div>',
      async (page) => {
        const audit = await collect(page)
        // The plain text is measured, so the vacuity guard is not what fails this state.
        expect(audit.text.checked).toBe(1)
        expect(audit.text.failures).toEqual([])
        expect(audit.clipping.failures).toEqual([])
        expect(audit.unverifiable).toEqual([
          expect.objectContaining({ tag: 'p', kind: 'text', reason: 'background-image' })
        ])
        expect(audit.pass).toBe(false)
      }
    )
  })

  it('leaves nothing focused after measuring focus indicators on a freshly loaded page', async () => {
    await withCollector(
      '<p style="color:#000">Label</p>' +
        '<button id="first" style="border:1px solid #000;color:#000;background:#fff">One</button>' +
        '<button id="last" style="border:1px solid #000;color:#000;background:#fff">Two</button>',
      async (page) => {
        expect(await activeElement(page)).toBe('body')
        const audit = await collect(page)
        expect(audit.nonText.checked).toBeGreaterThan(0)
        expect(await activeElement(page)).toBe('body')
      }
    )
  })

  it('gives focus back to the control that had it before the audit', async () => {
    await withCollector(
      '<p style="color:#000">Label</p>' +
        '<input id="field" style="border:1px solid #000;color:#000;background:#fff" />' +
        '<button id="last" style="border:1px solid #000;color:#000;background:#fff">Two</button>',
      async (page) => {
        await page.focus('#field')
        await collect(page)
        expect(await activeElement(page)).toBe('input#field')
      }
    )
  })
})
