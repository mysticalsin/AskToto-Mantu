/**
 * C32 — the loading state of every code-split surface, in a real Chromium layout. Centering, the delayed
 * appearance, the cross-fade, reduced motion and focus are layout and browser behaviour, so they are proven
 * against the production LazyPanel / preloadableLazy / surface-exit modules rather than a hook harness.
 *
 * HIG (Loading, Progress indicators, Motion): show the surface at once; only a noticeable wait gets an
 * indicator, centered where the content will be; the content replaces it without a pop; Reduce Motion swaps
 * instantly; focus lands in the content, never on the indicator.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import type { Browser, Page } from 'playwright'
import { build, type Rollup } from 'vite'
import react from '@vitejs/plugin-react'

const HARNESS_ID = '\0panel-loading-harness'
const rendererSrc = resolve(__dirname, '..')
const modulePath = (path: string): string => JSON.stringify(resolve(rendererSrc, path).replace(/\\/g, '/'))

const HARNESS = `
import { createElement as h, useState } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { LazyPanel, SettingsSheet, PANEL_LOADING_DELAY_MS } from ${modulePath('ui/PanelLoading.tsx')}
import { preloadableLazy } from ${modulePath('lib/lazy-views.ts')}
import { useSurfaceExitView } from ${modulePath('lib/surface-exit.ts')}
import ${modulePath('styles/overlay-motion.css')}
import ${modulePath('styles/panel-loading.css')}

const record = { loaderSeen: false, placeholderSeen: false, contentAnimated: false }
new MutationObserver(() => {
  if (document.querySelector('.lazy-panel__loader')) record.loaderSeen = true
  if (document.querySelector('.lazy-panel__placeholder')) record.placeholderSeen = true
  if (document.querySelector('.lazy-panel__content[data-content-enter]')) record.contentAnimated = true
}).observe(document.body, { subtree: true, childList: true, attributes: true })

let resolveChunk = null
function Content({ tall }) {
  return h('div', { 'data-content': '' },
    h('div', { role: 'tablist' },
      h('button', { type: 'button', role: 'tab', 'aria-selected': 'true', tabIndex: 0 }, 'General'),
      h('button', { type: 'button', role: 'tab', 'aria-selected': 'false', tabIndex: -1 }, 'Audio')),
    h('input', { 'aria-label': 'Search settings' }),
    h('div', { style: { height: tall ? 900 : 120 } }, 'Body'))
}
const view = preloadableLazy(() => new Promise((done) => { resolveChunk = () => done({ default: Content }) }))
const View = view.Component

function Frame({ frame, tall }) {
  const body = h(View, { tall })
  if (frame === 'sheet') {
    return h('div', { id: 'host', style: { display: 'flex', flexDirection: 'column', width: 480, height: 360 } },
      h(SettingsSheet, null, body))
  }
  if (frame === 'panel') {
    return h('div', { id: 'host', style: { width: 480, padding: '14px 16px' } },
      h(LazyPanel, { label: 'History', frame: 'panel', contentKey: 'history' }, body))
  }
  return h('div', { id: 'host', 'data-re-reader-scroll': '', style: { width: 360, height: 420, overflow: 'auto' } },
    h('div', { style: { padding: '12px 14px 20px' } },
      h(LazyPanel, { label: 'History', frame: 'reader', contentKey: 'history' }, body)))
}

let setOpen = null
let close = null
function App({ frame, tall }) {
  const [view, setViewNow] = useState('answer')
  const [setView] = useSurfaceExitView(view, setViewNow)
  setOpen = () => setViewNow('settings')
  close = () => setView('answer')
  return h('div', null,
    h('button', { type: 'button', id: 'invoker' }, 'Open'),
    view === 'settings' ? h(Frame, { frame, tall }) : null)
}

const root = createRoot(document.getElementById('root'))
window.__h = {
  delay: PANEL_LOADING_DELAY_MS,
  record,
  mount(frame, tall = false) { flushSync(() => root.render(h(App, { frame, tall }))) },
  open() { document.getElementById('invoker').focus(); flushSync(() => setOpen()) },
  resolveIn(ms) { setTimeout(() => resolveChunk(), ms) },
  resolveNow() { resolveChunk() },
  preload() { const p = view.preload(); resolveChunk(); return p },
  close() { close() }
}
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
        name: 'panel-loading-harness',
        enforce: 'pre',
        resolveId: (id: string) => (id === HARNESS_ID ? id : null),
        load: (id: string) => (id === HARNESS_ID ? HARNESS : null)
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

// The motion tokens Tailwind emits from tokens.css' @theme block (this harness runs without Tailwind).
const TOKENS = ':root{--duration-hover:150ms;--duration-panel:220ms;--ease-spring:cubic-bezier(0.22,1,0.36,1)}'

declare global {
  interface Window {
    __h: {
      delay: number
      record: { loaderSeen: boolean; placeholderSeen: boolean; contentAnimated: boolean }
      mount(frame: 'sheet' | 'panel' | 'reader', tall?: boolean): void
      open(): void
      resolveIn(ms: number): void
      resolveNow(): void
      preload(): Promise<void>
      close(): void
    }
  }
}

interface Box {
  x: number
  y: number
  width: number
  height: number
}
const center = (b: Box): { x: number; y: number } => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 })

describe('LazyPanel loading state (HIG Loading, Progress indicators)', () => {
  let browser: Browser
  let page: Page
  let bundle: { js: string; css: string }

  beforeAll(async () => {
    bundle = await bundleHarness()
    const { chromium } = await import('playwright')
    browser = await chromium.launch({ headless: true })
  }, 120_000)

  const openPage = async (options: { pauseClock?: boolean } = {}): Promise<void> => {
    await page?.close()
    page = await browser.newPage()
    let clockBase: Date | null = null
    if (options.pauseClock) {
      clockBase = new Date()
      await page.clock.install({ time: clockBase })
    }
    await page.setContent('<!doctype html><html><body style="margin:0"><div id="root"></div></body></html>')
    await page.addStyleTag({ content: TOKENS + bundle.css })
    await page.addScriptTag({ content: bundle.js })
    if (clockBase) await page.clock.pauseAt(new Date(clockBase.getTime() + 60 * 60 * 1000))
  }

  beforeEach(() => openPage())

  afterEach(async () => {
    await page?.close()
  })

  afterAll(async () => {
    await browser?.close()
  })

  const loader = (): ReturnType<Page['locator']> => page.locator('.lazy-panel__loader')
  const box = async (selector: string): Promise<Box> => {
    const b = await page.locator(selector).first().boundingBox()
    if (!b) throw new Error(`no box for ${selector}`)
    return b
  }

  it('a fast chunk shows no indicator, only the frame, then the content fades in', async () => {
    await page.evaluate(() => {
      window.__h.mount('sheet')
      window.__h.open()
      window.__h.resolveIn(40)
    })
    await page.locator('[data-content]').waitFor()
    await page.waitForTimeout(250)
    const record = await page.evaluate(() => window.__h.record)
    expect(record.placeholderSeen).toBe(true)
    expect(record.loaderSeen).toBe(false)
    expect(record.contentAnimated).toBe(true)
    expect(await loader().count()).toBe(0)
  })

  it('waits before showing the indicator, then centers it in the box the content will fill', async () => {
    for (const frame of ['sheet', 'panel', 'reader'] as const) {
      await openPage({ pauseClock: true })
      await page.evaluate((f) => {
        window.__h.mount(f)
        window.__h.open()
      }, frame)
      await expect
        .poll(() => page.locator('[data-lazy-panel]').getAttribute('data-lazy-phase'), { interval: 10, timeout: 1000 })
        .toBe('pending')
      const delay = await page.evaluate(() => window.__h.delay)
      await page.clock.runFor(delay - 1)
      expect(await loader().count(), `${frame}: no indicator inside the delay`).toBe(0)
      await page.clock.runFor(1)
      await expect
        .poll(() => page.locator('[data-lazy-panel]').getAttribute('data-lazy-phase'), { interval: 10, timeout: 1000 })
        .toBe('loading')
      await expect.poll(() => loader().count(), { interval: 10, timeout: 1000 }).toBe(1)
      await page.clock.resume()
      await loader().waitFor({ state: 'visible' })
      const placeholder = await box('.lazy-panel__placeholder')
      const orb = center(await box('.lazy-panel__loader .agent-status__orb'))
      expect(Math.abs(orb.x - center(placeholder).x), `${frame} x`).toBeLessThanOrEqual(1)
      expect(Math.abs(orb.y - center(placeholder).y), `${frame} y`).toBeLessThanOrEqual(1)
      expect(placeholder.height, `${frame} reserves the content's box`).toBeGreaterThan(200)
      if (frame === 'sheet') {
        const host = await box('#host')
        expect(Math.abs(center(placeholder).x - center(host).x)).toBeLessThanOrEqual(1)
        expect(Math.abs(center(placeholder).y - center(host).y)).toBeLessThanOrEqual(1)
      }
      if (frame === 'reader') {
        // The placeholder fills the visible scroll area (420 high, less the 12/20 padding).
        expect(Math.abs(placeholder.height - (420 - 12 - 20))).toBeLessThanOrEqual(1)
      }
      await expect
        .poll(() => page.locator('[role="status"]').first().textContent())
        .toMatch(/^Loading (Settings|History)$/)
      expect(await loader().getAttribute('aria-hidden')).toBe('true')
    }
  })

  it('cross-fades the loader out where it stood while the content fades in, then removes it', async () => {
    await page.evaluate(() => {
      window.__h.mount('panel', true)
      window.__h.open()
    })
    await loader().waitFor()
    await page.waitForTimeout(260) // the loader's own fade-in has finished
    const before = await box('.lazy-panel__loader')
    await page.evaluate(() => window.__h.resolveNow())
    await page.locator('[data-content]').waitFor()
    expect(await loader().getAttribute('data-state')).toBe('out')
    const during = await box('.lazy-panel__loader')
    expect(Math.abs(during.y - before.y)).toBeLessThanOrEqual(1)
    expect(Math.abs(during.height - before.height)).toBeLessThanOrEqual(1)
    expect(await page.locator('.lazy-panel__content').getAttribute('data-content-enter')).toBe('')
    await loader().waitFor({ state: 'detached', timeout: 1000 })
    await expect
      .poll(() => page.locator('.lazy-panel__content').evaluate((el) => getComputedStyle(el).opacity))
      .toBe('1')
    expect(await page.locator('[role="status"]').first().textContent()).toBe('')
  })

  it('Reduce Motion: the indicator appears without a fade and the content swaps in instantly', async () => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.evaluate(() => {
      window.__h.mount('sheet')
      window.__h.open()
    })
    await loader().waitFor()
    expect(await loader().evaluate((el) => el.getAnimations().length)).toBe(0)
    await page.evaluate(() => window.__h.resolveNow())
    await page.locator('[data-content]').waitFor()
    expect(await loader().count()).toBe(0)
    expect(await page.evaluate(() => window.__h.record.contentAnimated)).toBe(false)
  })

  it('moves focus to the content (selected tab, never a text field or the loader) and back to the opener', async () => {
    await page.evaluate(() => {
      window.__h.mount('sheet')
      window.__h.open()
    })
    await loader().waitFor()
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('invoker')
    await page.evaluate(() => window.__h.resolveNow())
    await expect.poll(() => page.evaluate(() => document.activeElement?.textContent)).toBe('General')
    await page.evaluate(() => window.__h.close())
    await page.locator('[data-content]').waitFor({ state: 'detached' })
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('invoker')
  })

  it('a chunk preloaded on intent renders with the click: no placeholder, no loader', async () => {
    await page.evaluate(async () => {
      await window.__h.preload()
      window.__h.mount('sheet')
      window.__h.open()
    })
    expect(await page.locator('[data-content]').count()).toBe(1)
    const record = await page.evaluate(() => window.__h.record)
    expect(record.placeholderSeen).toBe(false)
    expect(record.loaderSeen).toBe(false)
  })

  it('closing plays the open in reverse before the surface unmounts; Reduce Motion closes at once', async () => {
    await page.evaluate(async () => {
      await window.__h.preload()
      window.__h.mount('sheet')
      window.__h.open()
    })
    await page.waitForTimeout(300)
    // Read the exiting frame in the same task as the close, so a loaded machine cannot finish the short leg first.
    const exiting = await page.evaluate(
      () =>
        new Promise<{ flag: string | null; pointerEvents: string; animations: string[] } | null>((resolve) => {
          const el = document.querySelector<HTMLElement>('.lazy-panel--sheet')
          if (!el) return resolve(null)
          const read = (): void =>
            resolve({
              flag: el.getAttribute('data-surface-exiting'),
              pointerEvents: getComputedStyle(el).pointerEvents,
              animations: el.getAnimations().map((a) => (a as CSSAnimation).animationName)
            })
          // React commits the exiting flag asynchronously: read the frame the moment the flag lands.
          const watch = new MutationObserver(() => {
            if (!el.hasAttribute('data-surface-exiting')) return
            watch.disconnect()
            read()
          })
          watch.observe(el, { attributes: true, attributeFilter: ['data-surface-exiting'] })
          window.__h.close()
        })
    )
    expect(exiting).toEqual({ flag: '', pointerEvents: 'none', animations: ['lazy-panel-sheet-out'] })
    await page.locator('.lazy-panel--sheet').waitFor({ state: 'detached', timeout: 5000 })

    // Reduce Motion: the close runs no animation at all, so the surface leaves without an exit leg.
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.evaluate(() => window.__h.open())
    const reduced = await page.evaluate(() => {
      window.__h.close()
      const el = document.querySelector<HTMLElement>('.lazy-panel--sheet')
      return el ? el.getAnimations().filter((a) => a.playState === 'running').length : 0
    })
    expect(reduced).toBe(0)
    await page.locator('.lazy-panel--sheet').waitFor({ state: 'detached', timeout: 5000 })
  })
})
