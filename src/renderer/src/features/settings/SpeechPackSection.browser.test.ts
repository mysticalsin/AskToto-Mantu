import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import type { Browser, Page } from 'playwright'
import { build, type Rollup } from 'vite'
import react from '@vitejs/plugin-react'
import type {
  SpeechPackActionRequest,
  SpeechPackActionResult,
  SpeechPackComponentSnapshot,
  SpeechPackProgress,
  SpeechPackSnapshot
} from '@shared/speech-pack'

const HARNESS_ID = '\0speech-pack-section-harness'
const rendererSrc = resolve(__dirname, '../..')
const modulePath = (path: string): string => JSON.stringify(resolve(rendererSrc, path).replace(/\\/g, '/'))
const HARNESS = `
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { SpeechPackSection } from ${modulePath('features/settings/SpeechPackSection.tsx')}

const config = window.__speechPackConfig
const listeners = new Set()
const state = {
  snapshot: config.snapshot,
  selectedEngine: config.selectedEngine,
  statusFailure: config.statusFailure,
  actionResult: config.actionResult || { ok: true },
  statusCalls: 0,
  actionRequests: [],
  unsubscribeCalls: 0
}
const bridge = {
  speechPackState: () => {
    state.statusCalls++
    return state.statusFailure ? Promise.reject(new Error(state.statusFailure)) : Promise.resolve(state.snapshot)
  },
  speechPackAction: (request) => {
    state.actionRequests.push(request)
    return Promise.resolve(state.actionResult)
  },
  onSpeechPackProgress: (callback) => {
    listeners.add(callback)
    return () => {
      state.unsubscribeCalls++
      listeners.delete(callback)
    }
  }
}
const root = createRoot(document.getElementById('root'))
const render = () => flushSync(() => root.render(createElement(SpeechPackSection, {
  bridge,
  selectedEngine: state.selectedEngine
})))
window.__speechPack = {
  inspect: () => ({
    statusCalls: state.statusCalls,
    actionRequests: [...state.actionRequests],
    listenerCount: listeners.size,
    unsubscribeCalls: state.unsubscribeCalls
  }),
  update: (snapshot, selectedEngine) => {
    state.snapshot = snapshot
    state.selectedEngine = selectedEngine
    render()
  },
  emit: (progress) => listeners.forEach((listener) => listener(progress)),
  unmount: () => flushSync(() => root.unmount())
}
render()
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
        name: 'speech-pack-section-harness',
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
  return (Array.isArray(output) ? output : [output])
    .flatMap((result) => result.output)
    .filter((file): file is Rollup.OutputChunk => file.type === 'chunk')
    .map((chunk) => chunk.code)
    .join('\n')
}

const WHISPER = 'asr.whisper-base-q8'
const PARAKEET = 'asr.parakeet-tdt-0.6b-v3-int8'
const WHISPER_ID = 'a'.repeat(64)
const PARAKEET_ID = 'b'.repeat(64)

function component(
  componentId: SpeechPackComponentSnapshot['componentId'],
  manifestIdentity: string,
  state: SpeechPackComponentSnapshot['state']
): SpeechPackComponentSnapshot {
  const unavailable = state === 'not-configured'
  return {
    componentId,
    manifestIdentity,
    version: 'test-v1',
    state,
    downloadBytes: 2_000_000,
    installedBytes: 1_000_000,
    sourceHost: unavailable ? null : 'models.example.test',
    integrity: state === 'ready' ? 'freshly-hash-verified-and-self-tested' : 'not-verified'
  }
}

function snapshot(
  options: {
    engine?: SpeechPackSnapshot['selectedEngine']
    whisperState?: SpeechPackComponentSnapshot['state']
    parakeetState?: SpeechPackComponentSnapshot['state']
    featureEnabled?: boolean
  } = {}
): SpeechPackSnapshot {
  const engine = options.engine ?? 'whisper'
  return {
    featureEnabled: options.featureEnabled ?? true,
    profile: 'full',
    profileError: null,
    selectedEngine: engine,
    selectedComponent: engine === 'whisper' ? WHISPER : engine === 'parakeet' ? PARAKEET : null,
    components: [
      component(WHISPER, WHISPER_ID, options.whisperState ?? 'not-installed'),
      component(PARAKEET, PARAKEET_ID, options.parakeetState ?? 'not-installed')
    ],
    progress: null
  }
}

type HarnessConfig = {
  snapshot: SpeechPackSnapshot
  selectedEngine: SpeechPackSnapshot['selectedEngine']
  statusFailure?: string
  actionResult?: SpeechPackActionResult
}

type HarnessStats = {
  statusCalls: number
  actionRequests: SpeechPackActionRequest[]
  listenerCount: number
  unsubscribeCalls: number
}

declare global {
  interface Window {
    __speechPackConfig: HarnessConfig
    __speechPack: {
      inspect(): HarnessStats
      update(snapshot: SpeechPackSnapshot, selectedEngine: SpeechPackSnapshot['selectedEngine']): void
      emit(progress: SpeechPackProgress): void
      unmount(): void
    }
  }
}

describe('SpeechPackSection browser behavior', () => {
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
    await page?.close()
  })

  afterAll(async () => {
    await browser?.close()
  })

  async function mount(config: HarnessConfig): Promise<void> {
    await page.setContent('<!doctype html><html><body><div id="root"></div></body></html>')
    await page.evaluate((value) => {
      window.__speechPackConfig = value
    }, config)
    await page.addScriptTag({ content: bundle })
    await page.getByRole('heading', { name: 'On-device speech model' }).waitFor()
  }

  const inspect = (): Promise<HarnessStats> => page.evaluate(() => window.__speechPack.inspect())

  it('reads and subscribes without starting a download, follows selected progress, and acts only on click', async () => {
    await mount({ snapshot: snapshot(), selectedEngine: 'whisper' })
    await page.getByText('Whisper base · Not downloaded').waitFor({ state: 'visible' })
    expect(await inspect()).toMatchObject({ statusCalls: 1, listenerCount: 1, actionRequests: [] })

    await page.evaluate(() =>
      window.__speechPack.emit({
        componentId: 'asr.whisper-base-q8',
        manifestIdentity: 'a'.repeat(64),
        bytesDone: 400_000,
        bytesTotal: 2_000_000,
        state: 'downloading'
      })
    )
    await page.getByText('Whisper base · Downloading').waitFor({ state: 'visible' })
    const progressValue = await page
      .getByRole('progressbar', { name: 'Speech model download progress' })
      .getAttribute('value')
    expect(progressValue).toBe('400000')
    expect((await inspect()).actionRequests).toEqual([])

    await page.evaluate((next) => window.__speechPack.update(next, 'parakeet'), snapshot({ engine: 'parakeet' }))
    await page.getByText('Parakeet · Not downloaded').waitFor({ state: 'visible' })
    expect(await inspect()).toMatchObject({ statusCalls: 2, listenerCount: 1, unsubscribeCalls: 1, actionRequests: [] })
    await page.getByRole('button', { name: 'Download' }).click()
    await page.waitForFunction(() => window.__speechPack.inspect().actionRequests.length === 1)
    expect((await inspect()).actionRequests).toEqual([
      { componentId: PARAKEET, action: 'download', manifestIdentity: PARAKEET_ID }
    ])
  })

  it('keeps unavailable, disabled, and ready controls consistent with the live snapshot', async () => {
    await mount({
      snapshot: snapshot({ whisperState: 'not-configured', featureEnabled: false }),
      selectedEngine: 'whisper'
    })
    await page.getByText('A trusted download source is not configured for this pack yet.').waitFor({ state: 'visible' })
    expect(await page.getByRole('button', { name: 'Download' }).count()).toBe(0)
    expect((await inspect()).actionRequests).toEqual([])

    await page.evaluate((next) => window.__speechPack.update(next, 'whisper'), snapshot({ featureEnabled: false }))
    expect(await page.getByRole('button', { name: 'Download' }).isDisabled()).toBe(true)
    expect((await inspect()).actionRequests).toEqual([])

    await page.evaluate((next) => window.__speechPack.update(next, 'whisper'), snapshot({ whisperState: 'ready' }))
    await page.getByText('Files and model test passed.').waitFor({ state: 'visible' })
    expect(await page.getByRole('button', { name: 'Repair' }).isEnabled()).toBe(true)
    await page.getByRole('button', { name: 'Repair' }).click()
    await page.waitForFunction(() => window.__speechPack.inspect().actionRequests.length === 1)
    expect((await inspect()).actionRequests).toEqual([
      { componentId: WHISPER, action: 'repair', manifestIdentity: WHISPER_ID }
    ])
  })

  it('shows safe status on bridge failure and a fixed message when the server refuses an explicit action', async () => {
    await mount({ snapshot: snapshot(), selectedEngine: 'whisper', statusFailure: 'private bridge details' })
    await page.getByText('Speech-pack status is unavailable right now.').waitFor({ state: 'visible' })
    expect(await page.getByText('private bridge details').count()).toBe(0)
    expect(await inspect()).toMatchObject({ statusCalls: 1, actionRequests: [] })

    await page.evaluate(() => window.__speechPack.unmount())
    await mount({
      snapshot: snapshot(),
      selectedEngine: 'whisper',
      actionResult: { ok: false, reason: 'policy-blocked' }
    })
    await page.getByRole('button', { name: 'Download' }).click()
    await page.getByRole('status').filter({ hasText: 'Downloads are disabled by your organization.' }).waitFor()
    expect(await page.getByRole('status').textContent()).toBe('Downloads are disabled by your organization.')
    await page.waitForFunction(() => window.__speechPack.inspect().actionRequests.length === 1)
    expect((await inspect()).actionRequests).toEqual([
      { componentId: WHISPER, action: 'download', manifestIdentity: WHISPER_ID }
    ])
  })

  it('unsubscribes progress listeners on unmount and renders invalid package profiles as repair-required', async () => {
    await mount({
      snapshot: { ...snapshot(), profile: null, profileError: 'invalid-profile' },
      selectedEngine: 'whisper'
    })
    await page
      .getByRole('alert')
      .filter({ hasText: 'Speech-pack settings need repair. Reinstall the official Métis package.' })
      .waitFor()
    expect(await page.getByRole('alert').textContent()).toBe(
      'Speech-pack settings need repair. Reinstall the official Métis package.'
    )
    await page.evaluate(() => window.__speechPack.unmount())
    expect(await inspect()).toMatchObject({ listenerCount: 0, unsubscribeCalls: 1, actionRequests: [] })
  })
})
