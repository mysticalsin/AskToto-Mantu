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
                  React.createElement(OnboardingExperience, { onDone: () => {}, authReady: true }))
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
      await page.evaluate(() => (window as unknown as { __mountOnboardingBrowserTest: () => void }).__mountOnboardingBrowserTest())
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
      await page.getByRole('heading', { name: 'Here’s what that looks like.' }).waitFor({ state: 'visible', timeout: 500 })
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
        await page.getByRole('heading', { name: 'Here’s what that looks like.' }).waitFor({ state: 'visible', timeout: 5_000 })

        // Both motion preferences retain the same four user-controlled stages.
        for (let i = 0; i < 3; i++) {
          await page.getByRole('button', { name: 'Next', exact: true }).click()
          expect(await page.getByRole('heading', { name: 'Here’s what that looks like.' }).count()).toBe(1)
        }
        await page.getByRole('button', { name: 'Next', exact: true }).click()
        await page.getByRole('heading', { name: 'Where should Métis sit?' }).waitFor({ state: 'visible', timeout: 5_000 })
      } finally {
        await page.close()
      }
    }, 30_000)
  }

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
        HTMLMediaElement.prototype.play = () => { throw new Error('media decoder unavailable') }
      })

      for (let i = 0; i < 4; i++) await page.getByRole('button', { name: 'Next', exact: true }).click()
      await page.getByRole('heading', { name: 'Where should Métis sit?' }).waitFor({ state: 'visible', timeout: 5_000 })
    } finally {
      await page.close()
    }
  }, 30_000)
})
