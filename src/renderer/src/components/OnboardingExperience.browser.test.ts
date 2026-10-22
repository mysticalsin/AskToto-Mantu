import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { chromium, type Browser } from 'playwright'
import { createServer, type ViteDevServer } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Opt-in installed-browser check: run with ASKTOTO_BROWSER_QA=1 on a machine with Playwright Chromium.
// This mounts the real onboarding component without launching Electron or touching a user profile.
// MQA-338: source-level demo navigation and media-failure regressions; installed QA remains open.
describe.skipIf(process.env.ASKTOTO_BROWSER_QA !== '1')('onboarding demo browser interaction', () => {
  let server: ViteDevServer
  let browser: Browser
  let url: string

  beforeAll(async () => {
    const rendererRoot = resolve(__dirname, '../..')
    const indexHtml = readFileSync(resolve(rendererRoot, 'index.html'), 'utf8')
    const bootChrome = indexHtml.match(/<div id="act1-boot-chrome">[\s\S]*?<\/div>/)?.[0]
    if (!bootChrome) throw new Error('Onboarding browser fixture cannot find the real static boot chrome')
    server = await createServer({
      root: rendererRoot,
      configFile: false,
      server: { host: '127.0.0.1', port: 0 },
      plugins: [
        {
          name: 'onboarding-browser-test-entry',
          configureServer(vite) {
            vite.middlewares.use('/__onboarding_browser_test', async (_req, res) => {
              const html = `<!doctype html><html class="exclusive-onboarding-boot"><head><meta charset="utf-8"></head><body>
                ${bootChrome}<div id="root"></div><script src="/act1-boot.js" defer></script><script type="module">
                import React from 'react'
                import { createRoot } from 'react-dom/client'
                import { OnboardingExperience } from '/src/components/OnboardingExperience.tsx'
                import '/src/styles.css'
                window.__mountOnboardingBrowserTest = () => createRoot(document.getElementById('root')).render(
                  React.createElement(OnboardingExperience, { onDone: () => {}, authReady: true, ...(window.__onboardingTestProps || {}) }))
                if (!new URLSearchParams(location.search).has('manualMount')) window.__mountOnboardingBrowserTest()
                </script></body></html>`
              res.setHeader('content-type', 'text/html; charset=utf-8')
              res.end(await vite.transformIndexHtml('/__onboarding_browser_test', html))
            })
          }
        },
        react(),
        tailwindcss()
      ],
      resolve: { alias: { '@shared': resolve(__dirname, '../../../shared') } }
    })
    await server.listen()
    const address = server.httpServer?.address()
    if (!address || typeof address === 'string') throw new Error('Vite browser test did not bind a port')
    url = `http://127.0.0.1:${address.port}/__onboarding_browser_test`
    browser = await chromium.launch({ headless: true })
  }, 30_000)

  afterAll(async () => {
    await browser?.close()
    await server?.close()
  }, 30_000)

  it('removes the static Next when React mounts, so it cannot be clicked behind the real Next', async () => {
    const page = await browser.newPage()
    try {
      await page.addInitScript(() => {
        const ready = { status: 'ready', ready: true, progress: 100, label: 'Ready' }
        ;(window as unknown as { toto: unknown }).toto = {
          asrAssetsEnsure: async () => ready,
          asrAssetsStatus: async () => ready,
          onImportAssetsProgress: () => () => {}
        }
      })
      await page.goto(url)
      await page.getByRole('button', { name: 'Next', exact: true }).waitFor({ state: 'visible' })
      expect(await page.locator('#act1-boot-next').count()).toBe(0)
      expect(await page.locator('button.onboard-cta').count()).toBe(1)
      await page.getByRole('button', { name: 'Next', exact: true }).click()
      await page.getByText("You're in the meeting.").waitFor({ state: 'visible' })
    } finally {
      await page.close()
    }
  }, 30_000)

  it('removes the static Next on a pre-React click and carries that click into the story', async () => {
    const page = await browser.newPage()
    try {
      await page.addInitScript(() => {
        const ready = { status: 'ready', ready: true, progress: 100, label: 'Ready' }
        ;(window as unknown as { toto: unknown }).toto = {
          asrAssetsEnsure: async () => ready,
          asrAssetsStatus: async () => ready,
          onImportAssetsProgress: () => () => {}
        }
      })
      await page.goto(`${url}?manualMount`)
      await page.locator('#act1-boot-next').click()
      expect(await page.locator('#act1-boot-next').count()).toBe(0)
      await page.evaluate(() =>
        (window as unknown as { __mountOnboardingBrowserTest: () => void }).__mountOnboardingBrowserTest()
      )
      await page.getByText("You're in the meeting.").waitFor({ state: 'visible' })
      expect(await page.locator('button.onboard-cta').count()).toBe(1)
    } finally {
      await page.close()
    }
  }, 30_000)

  it('opens the real demo after Continue without exposing a loading fallback while its module is slow', async () => {
    const page = await browser.newPage()
    let delayedDemoRequest = false
    try {
      await page.route('**/OnboardingDemoScene.tsx*', async (route) => {
        delayedDemoRequest = true
        await new Promise((resolve) => setTimeout(resolve, 2_000))
        await route.continue()
      })
      await page.addInitScript(() => {
        const ready = { status: 'ready', ready: true, progress: 100, label: 'Ready' }
        ;(window as unknown as { toto: unknown }).toto = {
          asrAssetsEnsure: async () => ready,
          asrAssetsStatus: async () => ready,
          onImportAssetsProgress: () => () => {}
        }
      })
      await page.goto(url)
      await page.getByRole('button', { name: 'Next', exact: true }).click()
      await page.getByRole('button', { name: 'Continue' }).click()
      await page
        .getByRole('heading', { name: 'Here’s what that looks like.' })
        .waitFor({ state: 'visible', timeout: 500 })
      expect(await page.getByText('See Métis in action').count()).toBe(0)
      expect(delayedDemoRequest).toBe(true)
    } finally {
      await page.close()
    }
  }, 30_000)

  for (const { label, height, reducedMotion } of [
    { label: 'reduced motion', height: 768, reducedMotion: 'reduce' },
    { label: 'normal motion on a compact laptop', height: 640, reducedMotion: 'no-preference' }
  ] as const) {
    it(`Continue opens the real demo and Next reaches Appearance with ${label}`, async () => {
      const page = await browser.newPage({ viewport: { width: 1100, height }, reducedMotion })
      try {
        await page.addInitScript(() => {
          const ready = { status: 'ready', ready: true, progress: 100, label: 'Ready' }
          ;(window as unknown as { toto: unknown }).toto = {
            asrAssetsEnsure: async () => ready,
            asrAssetsStatus: async () => ready,
            onImportAssetsProgress: () => () => {}
          }
        })
        await page.goto(url)
        await page.getByRole('button', { name: 'Next', exact: true }).click()
        await page.getByText("You're in the meeting.").waitFor({ state: 'visible' })
        await page.getByRole('button', { name: 'Continue' }).click()
        await page
          .getByRole('heading', { name: 'Here’s what that looks like.' })
          .waitFor({ state: 'visible', timeout: 5_000 })

        // Both motion preferences retain the same four user-controlled stages.
        for (let i = 0; i < 3; i++) {
          await page.getByRole('button', { name: 'Next', exact: true }).click()
          expect(await page.getByRole('heading', { name: 'Here’s what that looks like.' }).count()).toBe(1)
        }
        await page.getByRole('button', { name: 'Next', exact: true }).click()
        await page
          .getByRole('heading', { name: 'Where should Métis sit?' })
          .waitFor({ state: 'visible', timeout: 5_000 })
      } finally {
        await page.close()
      }
    }, 30_000)
  }

  it('C26: landing on Setup raises no permission prompt; a row asks only from its Continue and re-checks on focus', async () => {
    const page = await browser.newPage()
    try {
      await page.addInitScript(() => {
        // Resume straight into Setup (the same marker a grant relaunch leaves) as a macOS build.
        localStorage.setItem('metis.onboarding.resumeSetup', '1')
        Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' })
        const ready = { status: 'ready', ready: true, progress: 100, label: 'Ready' }
        const calls = { requests: [] as (string | null)[], reads: 0, micOpens: 0 }
        const perms = () => ({
          microphone: 'unknown',
          screenRecording: 'unknown',
          screenDiagnosis: {
            state: 'not-asked',
            reasons: [],
            action: 'none',
            duplicates: [],
            grantedFor: null,
            repairFailed: false
          }
        })
        const base: Record<string, unknown> = {
          asrAssetsEnsure: async () => ready,
          asrAssetsStatus: async () => ready,
          onImportAssetsProgress: () => () => {},
          localModelsList: async () => [],
          getPermissions: async () => {
            calls.reads += 1
            return perms()
          },
          requestPermissionsUpfront: async (kind?: string) => {
            calls.requests.push(kind ?? null)
            return perms()
          },
          // Every renderer microphone open goes through main's input-session admission first.
          getInputSessionContext: async () => {
            calls.micOpens += 1
            return null
          }
        }
        // Anything else the scene touches answers "nothing" (a callable promise covers both shapes).
        const nothing = () => {
          const done = Promise.resolve(undefined)
          return Object.assign(() => {}, {
            then: done.then.bind(done),
            catch: done.catch.bind(done),
            finally: done.finally.bind(done)
          })
        }
        ;(window as unknown as { __c26: typeof calls }).__c26 = calls
        ;(window as unknown as { toto: unknown }).toto = new Proxy(base, {
          get: (t, k: string) => (k in t ? t[k] : nothing)
        })
      })
      type Calls = { requests: (string | null)[]; reads: number; micOpens: number }
      const calls = (): Promise<Calls> => page.evaluate(() => (window as unknown as { __c26: Calls }).__c26)
      await page.goto(url)
      const rowContinue = page.getByRole('button', { name: 'Continue', exact: true })
      // Microphone, then Meeting audio & screen (the rows land staggered).
      await rowContinue.nth(1).waitFor({ state: 'visible', timeout: 10_000 })
      expect(await rowContinue.count()).toBe(2)
      await page.waitForTimeout(2_500) // past the staged reveal and a couple of live polls
      expect(await calls()).toMatchObject({ requests: [], micOpens: 0 })
      await rowContinue.first().click()
      await page.waitForFunction(() => (window as unknown as { __c26: Calls }).__c26.requests.length === 1)
      expect((await calls()).requests).toEqual(['microphone'])
      const before = (await calls()).reads
      await page.evaluate(() => window.dispatchEvent(new Event('focus')))
      await page.waitForFunction((n) => (window as unknown as { __c26: Calls }).__c26.reads > n, before, {
        timeout: 500
      })
    } finally {
      await page.close()
    }
  }, 30_000)

  it('a media playback exception cannot trap the demo Next button', async () => {
    const page = await browser.newPage({ viewport: { width: 1100, height: 768 }, reducedMotion: 'reduce' })
    try {
      await page.addInitScript(() => {
        const ready = { status: 'ready', ready: true, progress: 100, label: 'Ready' }
        ;(window as unknown as { toto: unknown }).toto = {
          asrAssetsEnsure: async () => ready,
          asrAssetsStatus: async () => ready,
          onImportAssetsProgress: () => () => {}
        }
      })
      await page.goto(url)
      await page.getByRole('button', { name: 'Next', exact: true }).click()
      await page.getByRole('button', { name: 'Continue' }).click()
      await page.getByRole('heading', { name: 'Here’s what that looks like.' }).waitFor({ state: 'visible' })
      await page.evaluate(() => {
        HTMLMediaElement.prototype.play = () => {
          throw new Error('media decoder unavailable')
        }
      })

      for (let i = 0; i < 4; i++) await page.getByRole('button', { name: 'Next', exact: true }).click()
      await page.getByRole('heading', { name: 'Where should Métis sit?' }).waitFor({ state: 'visible', timeout: 5_000 })
    } finally {
      await page.close()
    }
  }, 30_000)

  /** The Setup scene resumes straight from the marker a grant relaunch leaves, with every IPC answering "nothing". */
  const SETUP_INIT = (settings: Record<string, unknown> | null): void => {
    localStorage.setItem('metis.onboarding.resumeSetup', '1')
    Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' })
    const ready = { status: 'ready', ready: true, progress: 100, label: 'Ready' }
    const perms = {
      microphone: 'granted',
      screenRecording: 'granted',
      screenDiagnosis: {
        state: 'granted',
        reasons: [],
        action: 'none',
        duplicates: [],
        grantedFor: null,
        repairFailed: false
      }
    }
    const patches: Record<string, unknown>[] = []
    const base: Record<string, unknown> = {
      asrAssetsEnsure: async () => ready,
      asrAssetsStatus: async () => ready,
      onImportAssetsProgress: () => () => {},
      localModelsList: async () => [],
      getPermissions: async () => perms,
      requestPermissionsUpfront: async () => perms
    }
    const nothing = () => {
      const done = Promise.resolve(undefined)
      return Object.assign(() => {}, {
        then: done.then.bind(done),
        catch: done.catch.bind(done),
        finally: done.finally.bind(done)
      })
    }
    ;(window as unknown as { __patches: typeof patches }).__patches = patches
    ;(window as unknown as { toto: unknown }).toto = new Proxy(base, {
      get: (t, k: string) => (k in t ? t[k] : nothing)
    })
    if (settings) {
      ;(window as unknown as { __onboardingTestProps: unknown }).__onboardingTestProps = {
        settings,
        patch: async (p: Record<string, unknown>) => {
          patches.push(p)
          return settings
        }
      }
    }
  }
  const SETTINGS = {
    screenAsk: true,
    managedKeys: [] as string[],
    mode: 'general',
    providerReady: true,
    provider: 'cloudflare',
    asrEngine: 'auto',
    localSpeechPack: 'offered',
    localLlm: { enabled: false, modelId: 'x' },
    brokerSpeech: { engine: 'auto', transport: 'auto' },
    enterpriseLive: { managed: false, inferenceMode: 'cloud', summaryOnly: false },
    overlayLayout: 'bar',
    overlayPlacement: 'top-center'
  }

  it('Q09 D1-7: moves focus to the new scene heading on Next', async () => {
    const page = await browser.newPage({ viewport: { width: 1100, height: 768 }, reducedMotion: 'reduce' })
    try {
      await page.addInitScript(SETUP_INIT, null)
      await page.addInitScript(() => localStorage.removeItem('metis.onboarding.resumeSetup'))
      await page.goto(url)
      await page.getByRole('button', { name: 'Next', exact: true }).click()
      await page.getByText("You're in the meeting.").waitFor({ state: 'visible' })
      await page.waitForFunction(() => document.activeElement?.closest('.onboard-tour-slot') != null)
      expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe('BODY')
      await page.getByRole('button', { name: 'Continue' }).click()
      const heading = page.getByRole('heading', { name: 'Here’s what that looks like.' })
      await heading.waitFor({ state: 'visible' })
      await page.waitForFunction(() => document.activeElement?.tagName === 'H2')
      expect(await page.evaluate(() => document.activeElement?.textContent)).toBe('Here’s what that looks like.')
    } finally {
      await page.close()
    }
  }, 30_000)

  it('Q09 D1-8: setup scene scrolls at 720px height', async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 400 }, reducedMotion: 'reduce' })
    try {
      await page.addInitScript(SETUP_INIT, SETTINGS)
      await page.goto(url)
      const cont = page.getByRole('button', { name: /^Continue( anyway)?$/ }).last()
      await cont.waitFor({ state: 'attached', timeout: 10_000 })
      await page.waitForTimeout(1_500)
      const slot = await page.evaluate(() => {
        const el = document.querySelector('.onboard-tour-slot') as HTMLElement
        return { overflowY: getComputedStyle(el).overflowY, scrolls: el.scrollHeight > el.clientHeight }
      })
      expect(slot.overflowY).toBe('auto')
      expect(slot.scrolls).toBe(true)
      await cont.scrollIntoViewIfNeeded()
      const hit = await cont.evaluate((el) => {
        const r = el.getBoundingClientRect()
        const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
        return top === el || el.contains(top)
      })
      expect(hit).toBe(true)
      // The heading stays reachable from the top, too (centred overflow must not clip it).
      const headingTop = await page.getByRole('heading', { name: 'Your setup' }).evaluate((el) => {
        const slotEl = document.querySelector('.onboard-tour-slot') as HTMLElement
        slotEl.scrollTop = 0
        return el.getBoundingClientRect().top >= slotEl.getBoundingClientRect().top - 1
      })
      expect(headingTop).toBe(true)
    } finally {
      await page.close()
    }
  }, 30_000)

  it('Q09 D1-4: locks the screen-ask toggle when managed', async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' })
    try {
      await page.addInitScript(SETUP_INIT, { ...SETTINGS, managedKeys: ['screenAsk'] })
      await page.goto(url)
      const toggle = page.getByRole('switch', { name: 'Let Métis see your screen when you ask' })
      await toggle.waitFor({ state: 'visible', timeout: 10_000 })
      expect(await toggle.isDisabled()).toBe(true)
      await page.getByText('Managed by your organization.').first().waitFor({ state: 'visible' })
      await toggle.click({ force: true })
      expect(await page.evaluate(() => (window as unknown as { __patches: unknown[] }).__patches.length)).toBe(0)
    } finally {
      await page.close()
    }
  }, 30_000)
})
