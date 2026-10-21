/**
 * C32 Part D — the guided grant helper's window content in real Chromium: the draggable app item and its
 * keyboard alternative, the per-platform copy, Cancel and Escape, the success and Relaunch states, and the hint
 * arrow's finite, Reduce Motion-aware nudge.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import type { Browser, Page } from 'playwright'
import { build, type Rollup } from 'vite'
import react from '@vitejs/plugin-react'

const HARNESS_ID = '\0permission-helper-harness'
const rendererSrc = resolve(__dirname, '..')
const modulePath = (path: string): string => JSON.stringify(resolve(rendererSrc, path).replace(/\\/g, '/'))

const HARNESS = `
import { createElement as h } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { PermissionHelperApp } from ${modulePath('permission-helper/PermissionHelper.tsx')}
import { helperReducer } from ${modulePath('../../shared/permission-helper.ts')}
import ${modulePath('permission-helper/permission-helper.css')}

const calls = []
let push = null
const api = {
  getState: async () => window.__first,
  onState: (listener) => { push = listener; return () => { push = null } },
  startDrag: () => calls.push('startDrag'),
  reveal: async () => { calls.push('reveal') },
  cancel: async () => { calls.push('cancel') },
  relaunch: async () => { calls.push('relaunch') }
}
const root = createRoot(document.getElementById('root'))
window.__helper = {
  calls,
  show(kind, platform) {
    window.__first = { ...helperReducer(null, { type: 'open', kind, platform, towards: 'left' }), appName: 'Métis', icon: null }
    flushSync(() => root.render(h(PermissionHelperApp, { api })))
  },
  push(phase) { push({ ...window.__first, phase }) }
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
        name: 'permission-helper-harness',
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
  return {
    js: files
      .filter((f): f is Rollup.OutputChunk => f.type === 'chunk')
      .map((c) => c.code)
      .join('\n'),
    css: files
      .filter((f): f is Rollup.OutputAsset => f.type === 'asset' && f.fileName.endsWith('.css'))
      .map((a) => String(a.source))
      .join('\n')
  }
}

declare global {
  interface Window {
    __helper: { calls: string[]; show(kind: string, platform: string): void; push(phase: string): void }
  }
}

describe('permission helper window (HIG Privacy, Accessibility, Motion)', () => {
  let browser: Browser
  let page: Page
  let bundle: { js: string; css: string }

  beforeAll(async () => {
    bundle = await bundleHarness()
    const { chromium } = await import('playwright')
    browser = await chromium.launch({ headless: true })
  }, 120_000)

  beforeEach(async () => {
    page = await browser.newPage({ viewport: { width: 360, height: 148 } })
    await page.setContent('<!doctype html><html><body><div id="root"></div></body></html>')
    await page.addStyleTag({ content: bundle.css })
    await page.addScriptTag({ content: bundle.js })
  })

  afterEach(async () => {
    await page?.close()
  })

  afterAll(async () => {
    await browser?.close()
  })

  const calls = (): Promise<string[]> => page.evaluate(() => [...window.__helper.calls])

  it('macOS: one instruction, Métis as a labelled drag source, Show in Finder as the keyboard path, Cancel', async () => {
    await page.evaluate(() => window.__helper.show('screenRecording', 'darwin'))
    await page.getByRole('status').filter({ hasText: 'Drag Métis into the list, then turn it on.' }).waitFor()
    const app = page.getByRole('img', {
      name: /Métis\. Drag it into the list in System Settings › Screen & System Audio Recording\./
    })
    expect(await app.getAttribute('draggable')).toBe('true')
    await app.dispatchEvent('dragstart')
    expect(await calls()).toEqual(['startDrag'])
    expect(await page.getByRole('button').allTextContents()).toEqual(['Show Métis in Finder', 'Cancel'])
    expect(await page.getByText(/allow/i).count()).toBe(0)
    await page.getByRole('button', { name: 'Show Métis in Finder' }).click()
    await page.getByRole('button', { name: 'Cancel' }).click()
    expect(await calls()).toEqual(['startDrag', 'reveal', 'cancel'])
  })

  it('Windows: no drag (there is no app list), the exact toggle named, Cancel only', async () => {
    await page.evaluate(() => window.__helper.show('microphone', 'win32'))
    await page.getByText('Turn on “Let desktop apps access your microphone”.').waitFor()
    expect(await page.locator('[draggable="true"]').count()).toBe(0)
    expect(await page.locator('.ph__arrow').count()).toBe(0)
    expect(await page.getByRole('button').allTextContents()).toEqual(['Cancel'])
    await page.keyboard.press('Escape')
    expect(await calls()).toEqual(['cancel'])
  })

  it('a grant shows the checkmark state; macOS Screen Recording offers one default Relaunch', async () => {
    await page.evaluate(() => window.__helper.show('screenRecording', 'darwin'))
    await page.evaluate(() => window.__helper.push('granted'))
    await page.getByRole('status').filter({ hasText: 'Screen & System Audio Recording is on for Métis.' }).waitFor()
    await page.evaluate(() => window.__helper.push('relaunch'))
    const relaunch = page.getByRole('button', { name: 'Relaunch Métis' })
    await relaunch.waitFor()
    expect(await page.evaluate(() => document.activeElement?.textContent)).toBe('Relaunch Métis')
    expect(await page.getByRole('button').allTextContents()).toEqual(['Cancel', 'Relaunch Métis'])
    await page.keyboard.press('Enter')
    expect(await calls()).toEqual(['relaunch'])
    await page.evaluate(() => window.__helper.push('closed'))
    expect(await page.locator('main').count()).toBe(0)
  })

  it('the hint arrow nudges three times then rests; Reduce Motion: no motion at all', async () => {
    await page.evaluate(() => window.__helper.show('screenRecording', 'darwin'))
    const iterations = await page
      .locator('.ph__arrow')
      .evaluate((el) => el.getAnimations().map((a) => a.effect?.getTiming().iterations))
    expect(iterations).toEqual([3])
    await page.emulateMedia({ reducedMotion: 'reduce' })
    expect(await page.locator('.ph__arrow').evaluate((el) => el.getAnimations().length)).toBe(0)
    expect(await page.locator('main.ph').evaluate((el) => el.getAnimations().length)).toBe(0)
  })
})
