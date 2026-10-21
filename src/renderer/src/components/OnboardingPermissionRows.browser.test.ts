import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import type { Browser, Page } from 'playwright'
import { build, type Rollup } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * C26 (HIG P1/P3/P5) — the onboarding Setup rows for the microphone and for meeting audio & screen. Each row
 * explains why, then offers ONE "Continue" that raises only its own system prompt; nothing asks when the rows
 * appear; a denied row offers the Privacy pane and never asks; a grant made in System Settings shows up when
 * Métis becomes active again. The rows are the production components wired the way OnboardingExperience wires
 * them (row verdicts from micRowStatus, re-checks through onAppActive).
 */
const HARNESS_ID = '\0onboarding-permission-rows-harness'
const SELF_TEST_ID = '\0onboarding-permission-rows-self-test'
const rendererSrc = resolve(__dirname, '..')
const modulePath = (path: string): string => JSON.stringify(resolve(rendererSrc, path).replace(/\\/g, '/'))

const HARNESS = `
import { createElement as h, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { MicSetupActions, requestSetupMic } from ${modulePath('components/OnboardingMicSetup.tsx')}
import { ScreenSetupActions, useScreenSetup } from ${modulePath('components/OnboardingScreenSetup.tsx')}
import { micRowStatus } from ${modulePath('lib/onboarding-setup-rows.ts')}
import { onAppActive } from ${modulePath('lib/permission-ask.ts')}

const state = window.__rowsState
const snapshot = () => ({
  microphone: state.microphone,
  screenRecording: state.screen === 'granted' ? 'granted' : state.screen === 'denied' ? 'denied' : 'unknown',
  screenDiagnosis: { state: state.screen, reasons: [], action: 'none', duplicates: [], grantedFor: null, repairFailed: false }
})
window.toto = {
  getPermissions: async () => {
    state.reads += 1
    return snapshot()
  },
  requestPermissionsUpfront: async (kind) => {
    state.requests.push(kind ?? null)
    return snapshot()
  },
  openPermissionSettings: async (kind) => {
    state.opened.push(kind)
  },
  // C32 Part D: denied rows and the Screen Recording Continue open the pane plus the guided helper.
  openPermissionHelper: async (kind) => {
    state.opened.push(kind)
    return kind === 'screenRecording'
  },
  attestScreenPermission: async () => {},
  revealAppCopy: async () => {}
}

function Rows() {
  const screen = useScreenSetup(true)
  const [mic, setMic] = useState('checking')
  const micRequest = useRef(null)
  useEffect(() => {
    const recheck = async () => {
      const perms = await window.toto.getPermissions()
      setMic(micRowStatus(perms.microphone).state)
      screen.setPerms(perms)
    }
    void recheck()
    return onAppActive(() => void recheck())
  }, [])
  return h('div', null,
    h('section', { 'aria-label': 'Microphone' },
      h(MicSetupActions, {
        state: mic,
        onContinue: async () => {
          const perms = await requestSetupMic(micRequest)
          setMic(micRowStatus(perms?.microphone).state)
        }
      })),
    h('section', { 'aria-label': 'Meeting audio & screen' },
      h(ScreenSetupActions, { perms: screen.perms, check: screen.check, onRequest: () => void screen.request(), onRecheck: screen.recheck })))
}
const root = createRoot(document.getElementById('root'))
root.render(h(Rows))
window.__unmountRows = () => root.unmount()
`

// Not under test here, and it would open real loopback audio: the self-test only runs once screen is granted.
const SELF_TEST_MODULE = `export async function runLoopbackSelfTest() { return true }`

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
        name: 'onboarding-permission-rows-harness',
        enforce: 'pre',
        resolveId: (id: string, importer?: string) => {
          if (id === HARNESS_ID || id === SELF_TEST_ID) return id
          if (id === '../lib/loopback-self-test' && importer?.endsWith('/OnboardingScreenSetup.tsx'))
            return SELF_TEST_ID
          return null
        },
        load: (id: string) => (id === HARNESS_ID ? HARNESS : id === SELF_TEST_ID ? SELF_TEST_MODULE : null)
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

type RowsState = {
  microphone: 'granted' | 'denied' | 'unknown'
  screen: 'not-asked' | 'denied' | 'needs-relaunch' | 'granted'
  reads: number
  requests: (string | null)[]
  opened: string[]
}

declare global {
  interface Window {
    __rowsState: RowsState
    __unmountRows?: () => void
  }
}

describe('C26 — onboarding permission rows ask only from their own Continue', () => {
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
    await page?.evaluate(() => window.__unmountRows?.()).catch(() => undefined)
    await page?.close()
  })

  afterAll(async () => {
    await browser?.close()
  })

  async function mount(
    microphone: RowsState['microphone'],
    screen: RowsState['screen'],
    platform: 'MacIntel' | 'Win32' = 'MacIntel'
  ): Promise<void> {
    await page.setContent('<!doctype html><html><body><div id="root"></div></body></html>')
    // Pin the platform before the bundle evaluates lib/keys' isWindows, so both run on any host.
    await page.evaluate(
      ({ mic, scr, plat }) => {
        Object.defineProperty(navigator, 'platform', { get: () => plat })
        window.__rowsState = { microphone: mic, screen: scr, reads: 0, requests: [], opened: [] }
      },
      { mic: microphone, scr: screen, plat: platform }
    )
    await page.addScriptTag({ content: bundle })
    await page.waitForFunction(() => window.__rowsState.reads > 0)
  }

  const state = (): Promise<RowsState> => page.evaluate(() => structuredClone(window.__rowsState))
  const row = (name: string) => page.getByRole('region', { name, exact: true })

  it('showing the rows raises no prompt; each row offers one Continue and no Allow', async () => {
    await mount('unknown', 'not-asked')
    await row('Microphone').getByRole('button', { name: 'Continue', exact: true }).waitFor()
    await row('Meeting audio & screen').getByRole('button', { name: 'Continue', exact: true }).waitFor()
    expect(await row('Microphone').getByRole('button').count()).toBe(1)
    expect(await row('Meeting audio & screen').getByRole('button').count()).toBe(1)
    expect(await page.getByRole('button', { name: /allow/i }).count()).toBe(0)
    expect((await state()).requests).toEqual([])
  })

  it('the microphone Continue raises exactly one prompt, for the microphone only', async () => {
    await mount('unknown', 'not-asked')
    await row('Microphone').getByRole('button', { name: 'Continue', exact: true }).click()
    await page.waitForFunction(() => window.__rowsState.requests.length === 1)
    expect((await state()).requests).toEqual(['microphone'])
  })

  it('the meeting audio & screen Continue opens the pane and the guided helper, never a prompt (C32 Part D)', async () => {
    await mount('granted', 'not-asked')
    await row('Meeting audio & screen').getByRole('button', { name: 'Continue', exact: true }).click()
    await page.waitForFunction(() => window.__rowsState.opened.length === 1)
    expect(await state()).toMatchObject({ requests: [], opened: ['screenRecording'] })
  })

  it('denied rows never ask: they say macOS won’t ask again and open the matching Privacy pane', async () => {
    await mount('denied', 'denied')
    await row('Microphone').getByText("macOS won't ask again once you've said no.", { exact: false }).waitFor()
    expect(await page.getByRole('button', { name: 'Continue', exact: true }).count()).toBe(0)
    await row('Microphone')
      .getByText('Turn on Métis in System Settings › Privacy & Security › Microphone.', { exact: false })
      .waitFor()
    await row('Microphone').getByRole('button', { name: 'Open System Settings', exact: true }).click()
    await row('Meeting audio & screen').getByRole('button', { name: 'Open System Settings', exact: true }).click()
    await page.waitForFunction(() => window.__rowsState.opened.length === 2)
    expect(await state()).toMatchObject({ requests: [], opened: ['microphone', 'screenRecording'] })
  })

  it('C32 Windows: denied rows say where to click and offer one "Open Settings" to the exact page', async () => {
    await mount('denied', 'denied', 'Win32')
    await row('Microphone').getByText('Settings › Privacy & security › Microphone', { exact: false }).waitFor()
    expect(await page.getByText(/macOS/).count()).toBe(0)
    expect(await row('Microphone').getByRole('button').count()).toBe(1)
    expect(await row('Meeting audio & screen').getByRole('button').count()).toBe(1)
    await row('Microphone').getByRole('button', { name: 'Open Settings', exact: true }).click()
    await row('Meeting audio & screen').getByRole('button', { name: 'Open Settings', exact: true }).click()
    await page.waitForFunction(() => window.__rowsState.opened.length === 2)
    expect(await state()).toMatchObject({ requests: [], opened: ['microphone', 'screenRecording'] })
    const before = (await state()).reads
    await page.evaluate(() => {
      window.__rowsState.microphone = 'granted'
      window.__rowsState.screen = 'granted'
      document.dispatchEvent(new Event('visibilitychange'))
      window.dispatchEvent(new Event('focus'))
    })
    await page.waitForFunction((n) => window.__rowsState.reads > n, before)
    await row('Microphone').getByRole('button').waitFor({ state: 'detached' })
    await row('Meeting audio & screen').getByRole('button').waitFor({ state: 'detached' })
  })

  it('a grant made in System Settings shows when Métis becomes active again', async () => {
    await mount('denied', 'not-asked')
    await row('Microphone').getByRole('button', { name: 'Open System Settings', exact: true }).waitFor()
    const before = (await state()).reads
    await page.evaluate(() => {
      window.__rowsState.microphone = 'granted'
      window.dispatchEvent(new Event('focus'))
    })
    await page.waitForFunction((n) => window.__rowsState.reads > n, before)
    await row('Microphone').getByRole('button').waitFor({ state: 'detached' })
    expect((await state()).requests).toEqual([])
  })
})
