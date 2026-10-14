import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import type { Browser, Page } from 'playwright'
import { build, type Rollup } from 'vite'
import react from '@vitejs/plugin-react'

const HARNESS_ID = '\0onboarding-welcome-harness'
const rendererRoot = resolve(__dirname, '../..')
const HARNESS = `
import { createElement, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { HeroWelcome, OnboardingHeroVideo } from '@/components/OnboardingWelcomeScene'

let root
let loadCalls = 0
let playCalls = 0
let pauseCalls = 0
let releaseVideoStart
let releaseReadyFallback
let videoStartDelay = null
let fallbackDelay = null
function Harness() {
  const videoRef = useRef(null)
  const [begins, setBegins] = useState(0)
  return createElement(
    'div',
    { className: 'onboard-stage' },
    createElement(OnboardingHeroVideo, { videoRef }),
    createElement(HeroWelcome, { onBegin: () => setBegins((value) => value + 1) }),
    createElement('output', { id: 'begin-count' }, String(begins))
  )
}

HTMLMediaElement.prototype.load = function () { loadCalls++ }
HTMLMediaElement.prototype.play = function () { playCalls++; return Promise.resolve() }
HTMLMediaElement.prototype.pause = function () { pauseCalls++ }
const nativeSetAttribute = Element.prototype.setAttribute
Element.prototype.setAttribute = function (name, value) {
  if (this instanceof HTMLMediaElement && name === 'src') {
    nativeSetAttribute.call(this, 'data-test-src', value)
    return
  }
  nativeSetAttribute.call(this, name, value)
}

window.__onboardingWelcome = {
  mount() {
    window.setTimeout = ((original) => (callback, delay, ...args) => {
      if (delay === 480 || delay === 800) {
        if (delay === 480) {
          videoStartDelay = delay
          releaseVideoStart = () => callback(...args)
        } else {
          fallbackDelay = delay
          releaseReadyFallback = () => callback(...args)
        }
        return -1
      }
      return original(callback, delay, ...args)
    })(window.setTimeout.bind(window))
    root = createRoot(document.getElementById('root'))
    flushSync(() => root.render(createElement(Harness)))
  },
  unmount() {
    if (root) flushSync(() => root.unmount())
    root = null
  },
  counts() { return { loadCalls, playCalls, pauseCalls, videoStartDelay, fallbackDelay } },
  startVideo() { releaseVideoStart?.(); releaseVideoStart = null },
  triggerReadyFallback() { flushSync(() => releaseReadyFallback?.()); releaseReadyFallback = null },
  dispatchNext() { flushSync(() => window.dispatchEvent(new Event('act1-boot-next'))) }
}
`

async function bundleHarness(): Promise<string> {
  const output = (await build({
    root: rendererRoot,
    configFile: false,
    logLevel: 'silent',
    resolve: { alias: { '@': resolve(rendererRoot, 'src'), '@shared': resolve(rendererRoot, '../shared') } },
    plugins: [
      react(),
      {
        name: 'onboarding-welcome-assets',
        enforce: 'pre' as const,
        resolveId(id: string) {
          if (id.endsWith('onboarding-hero-lady-planet.mp4')) return '\0onboarding-test-video'
          if (id.endsWith('onboarding-hero-poster.jpg')) return '\0onboarding-test-poster'
          if (id === HARNESS_ID) return HARNESS_ID
          return null
        },
        load(id: string) {
          if (id === '\0onboarding-test-video')
            return `export default 'file:///Applications/Metis.app/Contents/Resources/app.asar/out/renderer/assets/onboarding-hero-lady-planet.mp4'`
          if (id === '\0onboarding-test-poster')
            return `export default 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs='`
          if (id === HARNESS_ID) return HARNESS
          return null
        }
      }
    ],
    build: {
      write: false,
      minify: false,
      rollupOptions: { input: HARNESS_ID, output: { format: 'iife', inlineDynamicImports: true } }
    }
  })) as Rollup.RollupOutput | Rollup.RollupOutput[]
  return (Array.isArray(output) ? output : [output])
    .flatMap((result) => result.output)
    .filter((file): file is Rollup.OutputChunk => file.type === 'chunk')
    .map((chunk) => chunk.code)
    .join('\n')
}

type MediaCalls = {
  loadCalls: number
  playCalls: number
  pauseCalls: number
  videoStartDelay: number | null
  fallbackDelay: number | null
}

declare global {
  interface Window {
    __act1BootNextQueued?: boolean
    __onboardingWelcome: {
      mount(): void
      unmount(): void
      startVideo(): void
      triggerReadyFallback(): void
      dispatchNext(): void
      counts(): MediaCalls
    }
  }
}

describe('Act 1 welcome rendered behavior', () => {
  let browser: Browser
  let page: Page
  let bundle: string

  beforeAll(async () => {
    bundle = await bundleHarness()
    const { chromium } = await import('playwright')
    browser = await chromium.launch({ headless: true })
  }, 120_000)

  beforeEach(async () => {
    page = await browser.newPage()
    await page.setContent(
      '<!doctype html><html><head></head><body><div id="act1-boot-chrome"></div><div id="root"></div></body></html>'
    )
    await page.addScriptTag({ content: bundle })
  })

  afterEach(async () => {
    await page?.close()
  })

  afterAll(async () => {
    await browser?.close()
  })

  it('shows the poster and Next first, opens the portal, and consumes queued Next once', async () => {
    await page.evaluate(() => {
      window.__act1BootNextQueued = true
      window.__onboardingWelcome.mount()
    })
    const next = page.getByRole('button', { name: 'Next' })
    await next.waitFor({ state: 'visible' })
    expect(await next.getAttribute('class')).toBe('onboard-cta no-drag focus-ring')
    expect(await page.getByText('Skip the tour').count()).toBe(0)
    expect(await page.locator('.onboard-hero-poster').count()).toBe(1)
    expect(await page.locator('.onboard-hero-poster').getAttribute('decoding')).toBe('sync')
    expect(await page.locator('video').count()).toBe(0)
    expect((await page.evaluate(() => window.__onboardingWelcome.counts())).videoStartDelay).toBe(480)
    expect(await page.locator('.onboard-stage').getAttribute('class')).toContain('onboard-stage--portal-open')
    expect(await page.locator('#begin-count').textContent()).toBe('1')
    expect(await page.evaluate(() => window.__act1BootNextQueued)).toBe(false)
    expect(await page.locator('#act1-boot-chrome').count()).toBe(0)
    expect(await page.locator('.hero-mark img').evaluate((image) => getComputedStyle(image).width)).toBe('96px')
    expect(await page.locator('.hero-wordmark').getAttribute('aria-label')).toBe('Métis')
    expect(await page.locator('.hero-wordmark').textContent()).toBe('Métis')
    expect(await page.locator('.hero-byline').getAttribute('class')).toContain('onboard-glass onboard-glass-chip')

    await page.getByRole('button', { name: 'Next' }).click()
    expect(await page.locator('#begin-count').textContent()).toBe('2')
    await page.evaluate(() => window.__onboardingWelcome.dispatchNext())
    expect(await page.locator('#begin-count').textContent()).toBe('3')
    const hero = await page.locator('.hero-welcome').innerHTML()
    expect(hero).toContain('Metis Maintainers')
    expect(hero).toContain('Métis')
  })

  it('starts muted looped video after the poster and promotes, then removes it on media error', async () => {
    await page.evaluate(() => window.__onboardingWelcome.mount())
    await page.evaluate(() => window.__onboardingWelcome.startVideo())
    await page.locator('video').waitFor({ state: 'attached' })
    const video = page.locator('video')
    expect(await video.evaluate((element) => element.muted)).toBe(true)
    expect(await video.getAttribute('loop')).not.toBeNull()
    expect(await video.getAttribute('autoplay')).not.toBeNull()
    expect(await video.getAttribute('preload')).toBe('auto')
    expect(await video.getAttribute('poster')).toBe(await page.locator('.onboard-hero-poster').getAttribute('src'))
    expect(await video.getAttribute('data-test-src')).toContain('app.asar.unpacked')
    expect(await page.locator('link[data-onboarding-hero-preload]').getAttribute('as')).toBe('video')
    expect((await page.evaluate(() => window.__onboardingWelcome.counts())).loadCalls).toBe(1)
    expect((await page.evaluate(() => window.__onboardingWelcome.counts())).playCalls).toBe(1)

    await video.evaluate((element) => element.dispatchEvent(new Event('loadeddata', { bubbles: true })))
    await expectVideoClass(page, 'onboard-hero-video--ready')
    await video.evaluate((element) => element.dispatchEvent(new Event('error')))
    expect(await page.locator('video').count()).toBe(0)
    expect(await page.locator('.onboard-hero-poster').count()).toBe(1)
  })

  it.each(['canplay', 'playing', 'timeupdate'])('promotes when the video emits %s', async (event) => {
    await page.evaluate(() => window.__onboardingWelcome.mount())
    await page.evaluate(() => window.__onboardingWelcome.startVideo())
    const video = page.locator('video')
    await video.waitFor({ state: 'attached' })
    expect(await video.getAttribute('class')).toBe('onboard-hero-video--pending')
    await video.evaluate((element, name) => element.dispatchEvent(new Event(name)), event)
    await expectVideoClass(page, 'onboard-hero-video--ready')
  })

  it.each([
    { readyState: 0, currentTime: 0, promotes: false },
    { readyState: 1, currentTime: 0, promotes: false },
    { readyState: 2, currentTime: 0, promotes: true },
    { readyState: 0, currentTime: 0.01, promotes: true }
  ])('bounds readiness fallback at media state $readyState and playback $currentTime', async (state) => {
    await page.evaluate(() => window.__onboardingWelcome.mount())
    await page.evaluate(() => window.__onboardingWelcome.startVideo())
    const video = page.locator('video')
    await video.waitFor({ state: 'attached' })
    expect((await page.evaluate(() => window.__onboardingWelcome.counts())).fallbackDelay).toBe(800)
    expect(await video.getAttribute('class')).toBe('onboard-hero-video--pending')
    await video.evaluate((element, values) => {
      Object.defineProperty(element, 'readyState', { value: values.readyState, configurable: true })
      Object.defineProperty(element, 'currentTime', { value: values.currentTime, configurable: true })
    }, state)
    await page.evaluate(() => window.__onboardingWelcome.triggerReadyFallback())
    if (state.promotes) await expectVideoClass(page, 'onboard-hero-video--ready')
    else expect(await video.getAttribute('class')).toBe('onboard-hero-video--pending')
  })

  it('pauses the mounted video on unmount', async () => {
    await page.evaluate(() => window.__onboardingWelcome.mount())
    await page.evaluate(() => window.__onboardingWelcome.startVideo())
    await page.locator('video').waitFor({ state: 'attached' })
    await page.evaluate(() => window.__onboardingWelcome.unmount())
    expect((await page.evaluate(() => window.__onboardingWelcome.counts())).pauseCalls).toBeGreaterThan(0)
  })

  it('does not start the optional video when reduced motion is enabled', async () => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.evaluate(() => window.__onboardingWelcome.mount())
    await page.evaluate(() => window.__onboardingWelcome.startVideo())
    expect(await page.locator('video').count()).toBe(0)
    expect(await page.locator('.onboard-hero-poster').count()).toBe(1)
  })
})

async function expectVideoClass(page: Page, className: string): Promise<void> {
  await page.waitForFunction((name) => document.querySelector('video')?.classList.contains(name), className)
}
