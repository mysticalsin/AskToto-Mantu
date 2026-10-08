import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import type { Browser, JSHandle, Page } from 'playwright'
import { build, type Rollup } from 'vite'
import react from '@vitejs/plugin-react'

// M2-0431: the right-edge dock is one element. Opening and parking it flips `open` on the same mounted dock;
// it never re-mounts the drawer or the answer inside it, so a reveal cannot replay the answer's entrance
// (`.develop-in`) animation. This mounts the real RightEdgeSidecar with its real stylesheet in Chromium, the
// same browser CI already installs for the Bar toolbar layout test. The answer body is shaped like Answer's
// own root (a `.develop-in` element), which keeps Answer's markdown and highlighter bundle out of the page.

const HARNESS_ID = '\0right-edge-dock-harness'
const rendererSrc = resolve(__dirname, '..')
const modulePath = (path: string): string => JSON.stringify(resolve(rendererSrc, path).replace(/\\/g, '/'))
const HARNESS = `
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { RightEdgeSidecar } from ${modulePath('components/RightEdgeSidecar.tsx')}
import ${modulePath('styles/right-edge-sidecar.css')}

const AnswerBody = () => createElement('div', { className: 'develop-in' }, 'Synthetic dock answer.')
const root = createRoot(document.getElementById('root'))
let state = { open: false, answer: false, liveNotice: null }
const render = () => flushSync(() => root.render(createElement(RightEdgeSidecar, {
  open: state.open,
  onOpen: () => {},
  onClose: () => {},
  value: '',
  onChange: () => {},
  onSubmit: () => {},
  body: state.answer ? createElement(AnswerBody) : null,
  liveNotice: state.liveNotice
})))
window.__dock = { set: (patch) => { state = { ...state, ...patch }; render() } }
render()
`

async function bundleHarness(): Promise<{ js: string; css: string }> {
  const rendererRoot = resolve(rendererSrc, '..')
  const output = (await build({
    root: rendererRoot,
    configFile: false,
    logLevel: 'silent',
    define: { __METIS_FEEDBACK_EMAIL__: '""', __METIS_QA_IDENTITY__: 'false' },
    resolve: { alias: { '@': rendererSrc, '@shared': resolve(rendererRoot, '../shared') } },
    plugins: [
      react(),
      {
        name: 'right-edge-dock-harness',
        resolveId: (id) => (id === HARNESS_ID ? id : null),
        load: (id) => (id === HARNESS_ID ? HARNESS : null)
      }
    ],
    build: {
      write: false,
      minify: false,
      cssCodeSplit: false,
      rollupOptions: { input: HARNESS_ID, output: { format: 'iife', inlineDynamicImports: true } }
    }
  })) as Rollup.RollupOutput | Rollup.RollupOutput[]
  const files = (Array.isArray(output) ? output : [output]).flatMap((result) => result.output)
  const js = files
    .filter((file): file is Rollup.OutputChunk => file.type === 'chunk')
    .map((chunk) => chunk.code)
    .join('\n')
  const css = files
    .filter((file): file is Rollup.OutputAsset => file.type === 'asset' && file.fileName.endsWith('.css'))
    .map((asset) => String(asset.source))
    .join('\n')
  return { js, css }
}

type DockProbe = {
  sameRoot: boolean
  sameDrawer: boolean
  sameAnswer: boolean
  answerMounts: number
  open: boolean
  drawerVisibility: string
  drawerAriaHidden: string | null
}

describe('right-edge dock renders as one element (M2-0431)', () => {
  let browser: Browser
  let page: Page

  beforeAll(async () => {
    const { js, css } = await bundleHarness()
    const { chromium } = await import('playwright')
    browser = await chromium.launch({ headless: true })
    page = await browser.newPage({ viewport: { width: 360, height: 560 } })
    await page.setContent(
      `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body><div id="root" style="position:relative;width:360px;height:560px"></div></body></html>`
    )
    await page.addScriptTag({ content: `window.toto = {};\n${js}` })
    await page.waitForSelector('.right-edge-sidecar')
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
  })

  const setDock = (patch: { open?: boolean; answer?: boolean; liveNotice?: string | null }): Promise<void> =>
    page.evaluate((next) => (window as unknown as { __dock: { set(p: object): void } }).__dock.set(next), patch)

  const probe = (): Promise<DockProbe> =>
    page.evaluate(() => {
      const w = window as unknown as { __first: Record<string, Element | null>; __answerMounts: number }
      const root = document.querySelector('.right-edge-sidecar')
      const drawer = document.querySelector('.right-edge-sidecar__drawer')
      const answer = document.querySelector('.right-edge-sidecar__answer .develop-in')
      return {
        sameRoot: root !== null && root === w.__first.root,
        sameDrawer: drawer !== null && drawer === w.__first.drawer,
        sameAnswer: answer !== null && answer === w.__first.answer,
        answerMounts: w.__answerMounts,
        open: root?.classList.contains('right-edge-sidecar--open') === true,
        drawerVisibility: drawer ? getComputedStyle(drawer).visibility : 'missing',
        drawerAriaHidden: drawer?.getAttribute('aria-hidden') ?? null
      }
    })

  it('keeps the same root, drawer and answer nodes across three reveal/park cycles with one answer mount', async () => {
    // Parked first, exactly as a right-edge dock boots; record the nodes and count every answer mount.
    await page.evaluate(() => {
      const w = window as unknown as { __first: Record<string, Element | null>; __answerMounts: number }
      w.__first = {
        root: document.querySelector('.right-edge-sidecar'),
        drawer: document.querySelector('.right-edge-sidecar__drawer'),
        answer: null
      }
      w.__answerMounts = 0
      new MutationObserver((records) => {
        for (const record of records) {
          for (const node of record.addedNodes) {
            if (!(node instanceof Element)) continue
            const answer = node.matches('.develop-in') ? node : node.querySelector('.develop-in')
            if (!answer) continue
            w.__answerMounts += 1
            w.__first.answer ??= answer
          }
        }
      }).observe(document.getElementById('root')!, { childList: true, subtree: true })
    })

    const parked = await probe()
    expect(parked).toMatchObject({
      sameRoot: true,
      sameDrawer: true,
      open: false,
      drawerVisibility: 'hidden',
      drawerAriaHidden: 'true'
    })

    await setDock({ open: true })
    await setDock({ answer: true })
    const answered = await probe()
    expect(answered).toMatchObject({
      sameRoot: true,
      sameDrawer: true,
      sameAnswer: true,
      answerMounts: 1,
      open: true,
      drawerVisibility: 'visible',
      drawerAriaHidden: null
    })

    for (let cycle = 1; cycle <= 3; cycle++) {
      await setDock({ open: false })
      const whileParked = await probe()
      expect(whileParked, `park ${cycle}`).toMatchObject({
        sameRoot: true,
        sameDrawer: true,
        sameAnswer: true,
        answerMounts: 1,
        open: false,
        drawerVisibility: 'hidden'
      })
      await setDock({ open: true })
      const revealed = await probe()
      expect(revealed, `reveal ${cycle}`).toMatchObject({
        sameRoot: true,
        sameDrawer: true,
        sameAnswer: true,
        answerMounts: 1,
        open: true,
        drawerVisibility: 'visible'
      })
    }
  })

  it('keeps the parked drawer out of the accessibility tree and the tab order', async () => {
    await setDock({ open: false })
    expect(await page.getByRole('complementary', { name: 'Métis' }).count()).toBe(0)
    expect(await page.getByRole('button', { name: 'Open Métis' }).count()).toBe(1)
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await page.keyboard.press('Tab')
    expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? null)).toBe('Open Métis')
    await setDock({ open: true })
    expect(await page.getByRole('complementary', { name: 'Métis' }).count()).toBe(1)
  })

  it('keeps a live microphone notice hidden on the parked rail and ellipsized in the open drawer', async () => {
    const exactNotice = 'Mic silent · check input'
    const longNotice =
      'The selected microphone input remains unavailable after reconnecting, so review device access and choose a working source before continuing.'
    const originalViewport = page.viewportSize()
    if (!originalViewport) throw new Error('Expected the synthetic page to have a viewport.')
    const originalStyles = await page.evaluate(() => {
      const root = document.getElementById('root')
      if (!(root instanceof HTMLElement)) throw new Error('Missing synthetic root.')
      return {
        html: document.documentElement.getAttribute('style'),
        body: document.body.getAttribute('style'),
        root: root.getAttribute('style')
      }
    })
    const fixtureMarginStyleMarker = 'right-edge-sidecar-notice-margin-fixture'
    let fixtureMarginStyle: JSHandle<HTMLStyleElement> | null = null
    let bodyFailed = false
    let bodyFailure: unknown = undefined
    const failures: unknown[] = []
    const attemptCleanup = async (cleanup: () => Promise<void>): Promise<void> => {
      try {
        await cleanup()
      } catch (error) {
        failures.push(error)
      }
    }
    const setFixtureGeometry = async (width: number, height: number): Promise<void> => {
      await page.setViewportSize({ width, height })
      await page.evaluate(
        ({ width, height }) => {
          const root = document.getElementById('root')
          if (!(root instanceof HTMLElement)) throw new Error('Missing synthetic root.')
          root.style.position = 'fixed'
          root.style.left = '0'
          root.style.top = '0'
          root.style.width = `${width}px`
          root.style.height = `${height}px`
        },
        { width, height }
      )
    }
    const inspectNotice = () =>
      page.evaluate(() => {
        const root = document.querySelector('.right-edge-sidecar')
        const drawer = document.querySelector('.right-edge-sidecar__drawer')
        const notice = document.querySelector('.right-edge-sidecar__status-notice')
        if (!(root instanceof HTMLElement)) throw new Error('Missing sidecar root.')
        if (!(drawer instanceof HTMLElement)) throw new Error('Missing sidecar drawer.')
        if (!(notice instanceof HTMLElement)) throw new Error('Missing sidecar notice.')
        const rect = (element: HTMLElement) => {
          const box = element.getBoundingClientRect()
          return {
            left: box.left,
            top: box.top,
            right: box.right,
            bottom: box.bottom,
            width: box.width,
            height: box.height
          }
        }
        const style = getComputedStyle(notice)
        return {
          surface: root.getAttribute('data-re-surface'),
          root: rect(root),
          drawer: rect(drawer),
          notice: rect(notice),
          drawerVisibility: getComputedStyle(drawer).visibility,
          drawerAriaHidden: drawer.getAttribute('aria-hidden'),
          noticeInsideDrawer: drawer.contains(notice),
          noticeVisibility: style.visibility,
          noticeAriaLabel: notice.getAttribute('aria-label'),
          noticeText: notice.textContent,
          noticeWhiteSpace: style.whiteSpace,
          noticeOverflow: style.overflow,
          noticeTextOverflow: style.textOverflow,
          noticeClientWidth: notice.clientWidth,
          noticeScrollWidth: notice.scrollWidth,
          noticeExpectedHeight:
            Number.parseFloat(style.lineHeight) +
            Number.parseFloat(style.paddingTop) +
            Number.parseFloat(style.paddingBottom) +
            Number.parseFloat(style.borderTopWidth) +
            Number.parseFloat(style.borderBottomWidth)
        }
      })

    try {
      fixtureMarginStyle = await page.evaluateHandle((marker) => {
        if (document.getElementById(marker) !== null) throw new Error('Fixture margin style marker already exists.')
        const style = document.createElement('style')
        style.id = marker
        style.textContent = 'html, body { margin: 0; }'
        document.head.append(style)
        return style
      }, fixtureMarginStyleMarker)
      await setFixtureGeometry(52, 52)
      await setDock({ open: false, answer: false, liveNotice: exactNotice })
      const parked = await inspectNotice()
      expect(parked).toMatchObject({
        surface: 'rest',
        root: { left: 0, top: 0, width: 52, height: 52 },
        drawerVisibility: 'hidden',
        drawerAriaHidden: 'true',
        noticeInsideDrawer: true,
        noticeVisibility: 'hidden',
        noticeAriaLabel: exactNotice,
        noticeText: exactNotice
      })
      expect(parked.drawer.left).toBeGreaterThanOrEqual(parked.root.left)
      expect(parked.drawer.right).toBeLessThanOrEqual(parked.root.right)
      expect(await page.locator('.right-edge-sidecar__status-notice').isVisible()).toBe(false)
      expect(await page.getByRole('status').count()).toBe(0)
      expect(await page.getByRole('button', { name: 'Open Métis' }).count()).toBe(1)

      await setFixtureGeometry(360, 560)
      await setDock({ open: true, liveNotice: exactNotice })
      const open = await inspectNotice()
      expect(open).toMatchObject({
        surface: 'island',
        drawerVisibility: 'visible',
        drawerAriaHidden: null,
        noticeInsideDrawer: true,
        noticeVisibility: 'visible',
        noticeAriaLabel: exactNotice,
        noticeText: exactNotice,
        noticeWhiteSpace: 'nowrap',
        noticeOverflow: 'hidden',
        noticeTextOverflow: 'ellipsis'
      })
      expect(open.notice.left).toBeGreaterThanOrEqual(open.drawer.left)
      expect(open.notice.right).toBeLessThanOrEqual(open.drawer.right)
      expect(open.notice.top).toBeGreaterThanOrEqual(open.drawer.top)
      expect(open.notice.bottom).toBeLessThanOrEqual(open.drawer.bottom)
      expect(Math.abs(open.notice.height - open.noticeExpectedHeight)).toBeLessThanOrEqual(1)
      expect(await page.getByRole('status', { name: exactNotice }).count()).toBe(1)

      await setDock({ liveNotice: longNotice })
      const long = await inspectNotice()
      expect(long).toMatchObject({
        surface: 'island',
        drawerVisibility: 'visible',
        noticeInsideDrawer: true,
        noticeVisibility: 'visible',
        noticeAriaLabel: longNotice,
        noticeText: longNotice,
        noticeWhiteSpace: 'nowrap',
        noticeOverflow: 'hidden',
        noticeTextOverflow: 'ellipsis'
      })
      expect(long.notice.left).toBeGreaterThanOrEqual(long.drawer.left)
      expect(long.notice.right).toBeLessThanOrEqual(long.drawer.right)
      expect(long.notice.top).toBeGreaterThanOrEqual(long.drawer.top)
      expect(long.notice.bottom).toBeLessThanOrEqual(long.drawer.bottom)
      expect(Math.abs(long.notice.height - long.noticeExpectedHeight)).toBeLessThanOrEqual(1)
      expect(long.noticeScrollWidth).toBeGreaterThan(long.noticeClientWidth)
      expect(await page.getByRole('status', { name: longNotice }).count()).toBe(1)

      await setDock({ open: false })
      const parkedAgain = await inspectNotice()
      expect(parkedAgain).toMatchObject({
        surface: 'rest',
        drawerVisibility: 'hidden',
        drawerAriaHidden: 'true',
        noticeInsideDrawer: true,
        noticeVisibility: 'hidden',
        noticeAriaLabel: longNotice,
        noticeText: longNotice
      })
      expect(await page.locator('.right-edge-sidecar__status-notice').isVisible()).toBe(false)
      expect(await page.getByRole('status').count()).toBe(0)
    } catch (error) {
      bodyFailed = true
      bodyFailure = error
    } finally {
      if (bodyFailed) failures.push(bodyFailure)
      await attemptCleanup(async () => {
        await setDock({ open: false, answer: false, liveNotice: null })
      })
      await attemptCleanup(async () => {
        await page.setViewportSize(originalViewport)
      })
      await attemptCleanup(async () => {
        if (fixtureMarginStyle === null) return
        await fixtureMarginStyle.evaluate((style, marker) => {
          if (
            style.id !== marker ||
            style.textContent !== 'html, body { margin: 0; }' ||
            style.parentElement !== document.head
          ) {
            throw new Error('Owned fixture margin style was replaced or detached.')
          }
          style.remove()
        }, fixtureMarginStyleMarker)
      })
      await attemptCleanup(async () => {
        if (fixtureMarginStyle === null) return
        await fixtureMarginStyle.dispose()
      })
      await attemptCleanup(async () => {
        await page.evaluate((style) => {
          const root = document.getElementById('root')
          if (!(root instanceof HTMLElement)) throw new Error('Missing synthetic root.')
          if (style === null) root.removeAttribute('style')
          else root.setAttribute('style', style)
        }, originalStyles.root)
      })
      await attemptCleanup(async () => {
        const restoredStyles = await page.evaluate(() => {
          const root = document.getElementById('root')
          if (!(root instanceof HTMLElement)) throw new Error('Missing synthetic root.')
          return {
            html: document.documentElement.getAttribute('style'),
            body: document.body.getAttribute('style'),
            root: root.getAttribute('style')
          }
        })
        expect(restoredStyles).toEqual(originalStyles)
      })
      await attemptCleanup(async () => {
        expect(page.viewportSize()).toEqual(originalViewport)
      })
      await attemptCleanup(async () => {
        const markerRemains = await page.evaluate(
          (marker) => document.getElementById(marker) !== null,
          fixtureMarginStyleMarker
        )
        expect(markerRemains).toBe(false)
      })
    }
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) {
      throw new AggregateError(failures, 'Right-edge notice check collected multiple failures.')
    }
  })
})
