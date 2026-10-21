import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import type { Browser, Page } from 'playwright'
import { build, type Rollup } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * C26 (HIG P1/P5) — Settings → Audio must not open the microphone just because the tab mounted. The meter opens
 * on mount only when access is already granted; a not-determined mic shows "Test Microphone" (the moment of
 * need), which asks, then meters; a denied mic shows the System Settings deep link and never asks.
 */
const HARNESS_ID = '\0mic-level-meter-harness'
const ADMISSION_ID = '\0mic-level-meter-admission'
const rendererSrc = resolve(__dirname, '../..')
const modulePath = (path: string): string => JSON.stringify(resolve(rendererSrc, path).replace(/\\/g, '/'))

const HARNESS = `
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { MicLevelMeter } from ${modulePath('features/settings/MicLevelMeter.tsx')}

const state = window.__micState
window.toto = {
  getPermissions: async () => {
    state.reads += 1
    return { microphone: state.microphone, screenRecording: 'granted' }
  },
  requestPermissionsUpfront: async (kind) => {
    state.requests.push(kind ?? null)
    if (state.microphone === 'unknown') state.microphone = state.answer
    return { microphone: state.microphone, screenRecording: 'granted' }
  },
  openPermissionSettings: async (kind) => {
    state.opened.push(kind)
  }
}
const root = createRoot(document.getElementById('root'))
root.render(createElement(MicLevelMeter, { deviceId: '', onPermissionGranted: () => { state.granted += 1 } }))
window.__unmountMeter = () => root.unmount()
`

// The real admission asks main for a lease before getUserMedia; here every open is recorded and served by a
// silent WebAudio stream, so the test sees exactly when the meter opens the microphone.
const ADMISSION_MODULE = `
export async function acquireInteractiveMic(constraints, purpose, source) {
  window.__micState.opens.push(source)
  const ctx = new AudioContext()
  const stream = ctx.createMediaStreamDestination().stream
  return {
    stream,
    admission: { sessionId: 'test', revoked: false, onRevoke: () => () => {}, release: async () => { window.__micState.releases += 1 } },
    stopMedia: () => stream.getTracks().forEach((t) => t.stop())
  }
}
`

async function bundleHarness(): Promise<string> {
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
        name: 'mic-level-meter-harness',
        enforce: 'pre',
        resolveId: (id: string, importer?: string) => {
          if (id === HARNESS_ID || id === ADMISSION_ID) return id
          if (id === '../../lib/input-mic-admission' && importer?.endsWith('/MicLevelMeter.tsx')) return ADMISSION_ID
          return null
        },
        load: (id: string) => (id === HARNESS_ID ? HARNESS : id === ADMISSION_ID ? ADMISSION_MODULE : null)
      }
    ],
    build: {
      write: false,
      minify: false,
      cssCodeSplit: false,
      rollupOptions: { input: HARNESS_ID, output: { format: 'iife', inlineDynamicImports: true } }
    }
  })) as Rollup.RollupOutput | Rollup.RollupOutput[]
  return (Array.isArray(output) ? output : [output])
    .flatMap((result) => result.output)
    .filter((file): file is Rollup.OutputChunk => file.type === 'chunk')
    .map((chunk) => chunk.code)
    .join('\n')
}

type MicStatus = 'granted' | 'denied' | 'unknown'
type MicState = {
  microphone: MicStatus
  answer: MicStatus
  reads: number
  requests: (string | null)[]
  opened: string[]
  opens: string[]
  releases: number
  granted: number
}

declare global {
  interface Window {
    __micState: MicState
    __unmountMeter?: () => void
  }
}

describe('C26 — MicLevelMeter opens the microphone only at the moment of need', () => {
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
  })

  afterEach(async () => {
    await page?.evaluate(() => window.__unmountMeter?.()).catch(() => undefined)
    await page?.close()
  })

  afterAll(async () => {
    await browser?.close()
  })

  async function mount(microphone: MicStatus, answer: MicStatus = 'granted'): Promise<void> {
    await page.setContent('<!doctype html><html><body><div id="root"></div></body></html>')
    // Pin a non-Windows platform: the Windows branch is covered by the pure micMeterMode table.
    await page.evaluate(
      ({ mic, ans }) => {
        Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' })
        window.__micState = { microphone: mic, answer: ans, reads: 0, requests: [], opened: [], opens: [], releases: 0, granted: 0 }
      },
      { mic: microphone, ans: answer }
    )
    await page.addScriptTag({ content: bundle })
    await page.waitForFunction(() => window.__micState.reads > 0)
  }

  // No stylesheet in this harness, so the meter has no height: wait for it to be attached, never visible.
  const state = (): Promise<MicState> => page.evaluate(() => structuredClone(window.__micState))

  it('not determined: shows Test Microphone and never opens or asks on mount', async () => {
    await mount('unknown')
    await page.getByRole('button', { name: 'Test Microphone' }).waitFor()
    // Several permission polls later, still nothing opened and nothing asked.
    await page.waitForFunction(() => window.__micState.reads >= 2, undefined, { timeout: 5_000 })
    expect(await state()).toMatchObject({ opens: [], requests: [], opened: [] })
    expect(await page.getByRole('meter').count()).toBe(0)
  })

  it('Test Microphone asks exactly once for the microphone, then the meter opens', async () => {
    await mount('unknown', 'granted')
    await page.getByRole('button', { name: 'Test Microphone' }).click()
    await page.getByRole('meter', { name: 'Microphone input level' }).waitFor({ state: 'attached' })
    await page.waitForFunction(() => window.__micState.opens.length === 1)
    const s = await state()
    expect(s.requests).toEqual(['microphone'])
    expect(s.opens).toEqual(['application-probe'])
    expect(s.granted).toBe(1)
    expect(await page.getByRole('button', { name: 'Test Microphone' }).count()).toBe(0)
  })

  it('a test the person declines opens nothing and turns into the System Settings deep link', async () => {
    await mount('unknown', 'denied')
    await page.getByRole('button', { name: 'Test Microphone' }).click()
    await page.getByRole('button', { name: 'Open System Settings' }).waitFor()
    const s = await state()
    expect(s.requests).toEqual(['microphone'])
    expect(s.opens).toEqual([])
    expect(s.granted).toBe(0)
  })

  it('granted: the meter opens on mount without asking', async () => {
    await mount('granted')
    await page.getByRole('meter', { name: 'Microphone input level' }).waitFor({ state: 'attached' })
    await page.waitForFunction(() => window.__micState.opens.length === 1)
    expect((await state()).requests).toEqual([])
    expect(await page.getByRole('button', { name: 'Test Microphone' }).count()).toBe(0)
  })

  it('denied: no open, no prompt, and the deep link opens the Microphone privacy pane', async () => {
    await mount('denied')
    await page.getByRole('button', { name: 'Open System Settings' }).click()
    await page.waitForFunction(() => window.__micState.opened.length === 1)
    expect(await state()).toMatchObject({ opens: [], requests: [], opened: ['microphone'] })
  })

  it('a grant made in System Settings is picked up when Métis becomes active again', async () => {
    await mount('denied')
    await page.getByRole('button', { name: 'Open System Settings' }).waitFor()
    await page.evaluate(() => {
      window.__micState.microphone = 'granted'
      window.dispatchEvent(new Event('focus'))
    })
    await page.getByRole('meter', { name: 'Microphone input level' }).waitFor({ state: 'attached' })
    await page.waitForFunction(() => window.__micState.opens.length === 1)
    expect((await state()).requests).toEqual([])
  })
})
