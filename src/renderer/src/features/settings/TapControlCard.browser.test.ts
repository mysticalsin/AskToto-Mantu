import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import type { Browser, Page } from 'playwright'
import { build, type Rollup } from 'vite'
import react from '@vitejs/plugin-react'

const HARNESS_ID = '\0tap-control-card-harness'
const CAPTURE_ID = '\0tap-control-card-capture-boundary'
const rendererSrc = resolve(__dirname, '../..')
const modulePath = (path: string): string => JSON.stringify(resolve(rendererSrc, path).replace(/\\/g, '/'))

const HARNESS = `
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { TapControlCard } from ${modulePath('features/settings/TapControlCard.tsx')}
import { PRE_MS, WIN_MS, POST_MS } from ${modulePath('lib/tap/gates.ts')}
import { embed, synthKeyClick, synthTap, synthTapB } from ${modulePath('lib/tap/__fixtures__/synth.ts')}

const config = window.__tapCardConfig
const state = {
  patches: [],
  captures: [],
  controls: []
}
const root = createRoot(document.getElementById('root'))
let mounted = true
const render = () => flushSync(() => root.render(createElement(TapControlCard, {
  settings: config.settings,
  patch: (patch) => state.patches.push(patch)
})))
const candidate = (kind, seed) => {
  const wave = kind === 'B'
    ? synthTapB({ seed, gain: 0.5 })
    : kind === 'weak'
      ? synthTap({ seed, gain: 0.003 })
      : kind === 'key'
        ? synthKeyClick({ seed })
        : synthTap({ seed, gain: 0.5 })
  return {
    pcm: embed(wave, {
      sampleRate: 48000,
      noiseRms: 0.001,
      totalMs: PRE_MS + WIN_MS + POST_MS,
      atMs: PRE_MS,
      seed: seed + 100
    }),
    floorRms: 0.001,
    sampleRate: 48000
  }
}

window.__tapHarness = {
  startCapture: (options) => new Promise((resolve) => {
    state.captures.push({ options, resolve, stopCalls: 0 })
  }),
  startControl: (options) => new Promise((resolve) => {
    state.controls.push({ options, resolve, stopCalls: 0 })
  }),
  resolveCapture: (index) => {
    const request = state.captures[index]
    request.resolve({
      sampleRate: 48000,
      onRevoke: () => () => {},
      setSensitivity: () => {},
      stop: () => { request.stopCalls++ }
    })
  },
  resolveControl: (index) => {
    const request = state.controls[index]
    request.resolve({ stop: () => { request.stopCalls++ }, setSensitivity: () => {} })
  },
  emitTap: (index, kind, seed) => {
    const request = state.captures[index]
    flushSync(() => request.options.onCandidate(candidate(kind, seed)))
  },
  emitControl: (index, event) => {
    const request = state.controls[index]
    flushSync(() => request.options.onEvent(event))
  },
  inspect: () => ({
    patches: state.patches.map((patch) => structuredClone(patch)),
    captures: state.captures.map((request) => ({
      hasSignal: request.options.signal instanceof AbortSignal,
      signalAborted: request.options.signal?.aborted ?? null,
      stopCalls: request.stopCalls
    })),
    controls: state.controls.map((request) => ({
      hasSignal: request.options.signal instanceof AbortSignal,
      signalAborted: request.options.signal?.aborted ?? null,
      stopCalls: request.stopCalls
    }))
  }),
  unmount: () => {
    if (!mounted) return
    mounted = false
    flushSync(() => root.unmount())
  }
}
render()
`

const CAPTURE_MODULE = `
export const startTapCapture = (options) => window.__tapHarness.startCapture(options)
export const startTapControl = (options) => window.__tapHarness.startControl(options)
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
        name: 'tap-control-card-harness',
        enforce: 'pre',
        resolveId: (id: string, importer?: string) => {
          if (id === HARNESS_ID || id === CAPTURE_ID) return id
          if (id === '../../lib/tap/tap-control' && importer?.endsWith('/TapControlCard.tsx')) return CAPTURE_ID
          return null
        },
        load: (id: string) => (id === HARNESS_ID ? HARNESS : id === CAPTURE_ID ? CAPTURE_MODULE : null)
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

type TapProfile = {
  version: 1
  sampleRate: number
  micDeviceId: string
  mean: number[]
  std: number[]
  zones: { name: string; centroid: number[] }[]
  negatives: number[][]
  dAccept: number
  levelRange: { min: number; max: number }
  createdAt: number
}

type CardSettings = {
  micDeviceId: string
  managedKeys: string[]
  tapControl: {
    enabled: boolean
    armOnlyWhileListening: boolean
    sensitivity: number
    zoneActions: string[]
    profile: TapProfile | null
  }
}

type HarnessStats = {
  patches: { tapControl?: CardSettings['tapControl'] }[]
  captures: { hasSignal: boolean; signalAborted: boolean | null; stopCalls: number }[]
  controls: { hasSignal: boolean; signalAborted: boolean | null; stopCalls: number }[]
}

declare global {
  interface Window {
    __tapCardConfig: { settings: CardSettings }
    __tapHarness: {
      resolveCapture(index: number): void
      resolveControl(index: number): void
      emitTap(index: number, kind: 'A' | 'B' | 'weak' | 'key', seed: number): void
      emitControl(index: number, event: { kind: 'tap'; zone: number }): void
      inspect(): HarnessStats
      unmount(): void
    }
  }
}

function profile(): TapProfile {
  return {
    version: 1,
    sampleRate: 48000,
    micDeviceId: 'default',
    mean: new Array(16).fill(0),
    std: new Array(16).fill(1),
    zones: [
      { name: 'Near', centroid: new Array(16).fill(0) },
      { name: 'Far', centroid: new Array(16).fill(1) }
    ],
    negatives: [],
    dAccept: 3,
    levelRange: { min: -4, max: -1 },
    createdAt: 1_700_000_000_000
  }
}

function settings(options: { enabled?: boolean; withProfile?: boolean; managed?: boolean } = {}): CardSettings {
  return {
    micDeviceId: 'default',
    managedKeys: options.managed ? ['tapControl'] : [],
    tapControl: {
      enabled: options.enabled ?? false,
      armOnlyWhileListening: true,
      sensitivity: 0.5,
      zoneActions: options.withProfile ? ['', ''] : [],
      profile: options.withProfile ? profile() : null
    }
  }
}

describe('TapControlCard browser behavior', () => {
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
    await page?.evaluate(() => window.__tapHarness?.unmount()).catch(() => undefined)
    await page?.close()
  })

  afterAll(async () => {
    await browser?.close()
  })

  async function mount(cardSettings: CardSettings): Promise<void> {
    await page.setContent('<!doctype html><html><body><div id="root"></div></body></html>')
    await page.evaluate((value) => {
      window.__tapCardConfig = { settings: value }
    }, cardSettings)
    await page.addScriptTag({ content: bundle })
    await page.getByText('Desk Tap Control', { exact: true }).waitFor()
  }

  const inspect = (): Promise<HarnessStats> => page.evaluate(() => window.__tapHarness.inspect())

  async function feedZone(kind: 'A' | 'B', target: string, startSeed: number): Promise<void> {
    for (let index = 0; index < 12; index += 1) {
      await page.evaluate(({ kind: candidateKind, seed }) => window.__tapHarness.emitTap(0, candidateKind, seed), {
        kind,
        seed: startSeed + index
      })
      if ((await page.locator('#root').innerText()).includes(target)) return
    }
    throw new Error(`Calibration did not reach ${target}`)
  }

  it('keeps disabled, enabled, and rapid settings edits coherent', async () => {
    await mount(settings({ withProfile: true }))
    const enable = page.getByRole('switch', { name: 'Enable tap control' })
    expect(await enable.getAttribute('aria-checked')).toBe('false')
    expect(await page.getByRole('switch', { name: 'Only while listening' }).count()).toBe(0)
    expect(await page.getByRole('button', { name: 'Calibrate', exact: true }).count()).toBe(0)

    await enable.click()
    const arm = page.getByRole('switch', { name: 'Only while listening' })
    await arm.click()
    const sensitivity = page.locator('input[type="range"]')
    await sensitivity.focus()
    await sensitivity.press('ArrowRight')
    await page.getByLabel('Near action').selectOption('summarize')
    await page.getByLabel('Far action').selectOption('factcheck')

    const patches = (await inspect()).patches.map((patch) => patch.tapControl)
    expect(patches).toHaveLength(5)
    expect(patches[0]).toMatchObject({ enabled: true, armOnlyWhileListening: true, sensitivity: 0.5 })
    expect(patches[1]).toMatchObject({ enabled: true, armOnlyWhileListening: false, sensitivity: 0.5 })
    expect(patches[2]).toMatchObject({ enabled: true, armOnlyWhileListening: false, sensitivity: 0.55 })
    expect(patches[3]?.zoneActions).toEqual(['summarize', ''])
    expect(patches[4]).toMatchObject({
      enabled: true,
      armOnlyWhileListening: false,
      sensitivity: 0.55,
      zoneActions: ['summarize', 'factcheck']
    })
    expect((await inspect()).captures).toEqual([])
    expect((await inspect()).controls).toEqual([])
  })

  it('keeps organization-managed controls disabled without dispatching edits or capture requests', async () => {
    await mount(settings({ enabled: true, withProfile: true, managed: true }))
    for (const label of ['Enable tap control', 'Only while listening']) {
      expect(await page.getByRole('switch', { name: label }).isDisabled()).toBe(true)
    }
    expect(await page.locator('input[type="range"]').isDisabled()).toBe(true)
    expect(await page.getByLabel('Near action').isDisabled()).toBe(true)
    expect(await page.getByLabel('Far action').isDisabled()).toBe(true)
    expect(await page.getByRole('button', { name: 'Recalibrate' }).isDisabled()).toBe(true)
    expect(await page.getByRole('button', { name: 'Test' }).isDisabled()).toBe(true)
    expect(await page.getByRole('button', { name: 'Calibrate', exact: true }).count()).toBe(0)
    expect(await inspect()).toMatchObject({ patches: [], captures: [], controls: [] })
  })

  it('drives calibration hints, progress, negatives, separability, save, and recalibration', async () => {
    await mount(settings({ enabled: true }))
    await page.getByRole('button', { name: 'Calibrate' }).click()
    expect((await inspect()).captures[0]).toMatchObject({ hasSignal: true, signalAborted: false })
    await page.evaluate(() => window.__tapHarness.resolveCapture(0))
    await page.getByText(/Zone 1 of 2/).waitFor()
    expect(await page.getByRole('button', { name: 'Cancel' }).count()).toBe(1)

    await page.evaluate(() => window.__tapHarness.emitTap(0, 'weak', 1))
    await page.getByText('Tap a bit harder.').waitFor()
    await page.evaluate(() => window.__tapHarness.emitTap(0, 'A', 10))
    await page.getByText(/1\/8/).waitFor()
    await feedZone('A', 'Zone 2 of 2', 11)
    await feedZone('B', 'Continue', 40)
    await page.getByRole('button', { name: 'Continue' }).click()
    await page.getByText('Teach it what to ignore · 0 captured').waitFor()
    await page.evaluate(() => window.__tapHarness.emitTap(0, 'key', 60))
    await page.getByText('Teach it what to ignore · 1 captured').waitFor()
    await page.getByRole('button', { name: 'Done' }).click()
    await page.getByText('Calibration looks good. Zones are clearly distinguishable.').waitFor()
    await page.getByRole('button', { name: 'Save' }).click()

    const saved = await inspect()
    expect(saved.patches).toHaveLength(1)
    expect(saved.patches[0]?.tapControl?.profile?.zones.map((zone) => zone.name)).toEqual(['Zone 1', 'Zone 2'])
    expect(saved.captures[0]?.stopCalls).toBe(1)
    expect(await page.getByRole('button', { name: 'Test' }).count()).toBe(1)
  }, 30_000)

  it('refuses same-sound zones, offers recalibration, and shows Cancel after capture is established', async () => {
    await mount(settings({ enabled: true }))
    await page.getByRole('button', { name: 'Calibrate' }).click()
    await page.evaluate(() => window.__tapHarness.resolveCapture(0))
    await page.getByText(/Zone 1 of 2/).waitFor()
    await feedZone('A', 'Zone 2 of 2', 100)
    await feedZone('A', 'Continue', 120)
    await page.getByRole('button', { name: 'Continue' }).click()
    await page.getByRole('button', { name: 'Done' }).click()
    await page.getByText('Those spots sound too similar to the mic.').waitFor()
    expect(await page.getByRole('button', { name: 'Save' }).count()).toBe(0)
    expect((await inspect()).patches).toEqual([])

    await page.getByRole('button', { name: 'Recalibrate' }).click()
    expect((await inspect()).captures[1]).toMatchObject({ hasSignal: true, signalAborted: false })
    await page.evaluate(() => window.__tapHarness.resolveCapture(1))
    await page.getByText(/Zone 1 of 2/).waitFor()
    await page.getByRole('button', { name: 'Cancel' }).click()
    expect(await page.getByRole('button', { name: 'Calibrate', exact: true }).count()).toBe(1)
    expect((await inspect()).captures.map((request) => request.stopCalls)).toEqual([1, 1])
    expect((await inspect()).patches).toEqual([])
  }, 30_000)

  it('aborts replaced and unmounted pending calibration, disposing each late session once', async () => {
    await mount(settings({ enabled: true }))
    await page.getByRole('button', { name: 'Calibrate' }).click()
    await page.getByRole('button', { name: 'Calibrate' }).click()
    expect((await inspect()).captures).toMatchObject([
      { hasSignal: true, signalAborted: true, stopCalls: 0 },
      { hasSignal: true, signalAborted: false, stopCalls: 0 }
    ])

    await page.evaluate(() => window.__tapHarness.resolveCapture(0))
    await page.getByRole('button', { name: 'Calibrate' }).waitFor()
    expect((await inspect()).captures[0]?.stopCalls).toBe(1)
    expect((await inspect()).captures[1]?.signalAborted).toBe(false)

    await page.evaluate(() => window.__tapHarness.unmount())
    expect((await inspect()).captures[1]?.signalAborted).toBe(true)
    await page.evaluate(() => window.__tapHarness.resolveCapture(1))
    await page.waitForTimeout(0)
    expect((await inspect()).captures.map((request) => request.stopCalls)).toEqual([1, 1])
    expect((await inspect()).patches).toEqual([])
  })

  it('displays a received test zone and Stop releases an established test session', async () => {
    await mount(settings({ enabled: true, withProfile: true }))
    await page.getByRole('button', { name: 'Test' }).click()
    await page.getByText('Test mode: tap your zones').waitFor()
    expect((await inspect()).controls[0]).toMatchObject({ hasSignal: true, signalAborted: false })
    await page.evaluate(() => window.__tapHarness.resolveControl(0))
    await page.evaluate(() => window.__tapHarness.emitControl(0, { kind: 'tap', zone: 1 }))
    await page.getByText('Recognized: Far').waitFor()
    await page.getByRole('button', { name: 'Stop' }).click()
    await page.getByRole('button', { name: 'Test' }).waitFor()
    expect((await inspect()).controls[0]?.stopCalls).toBe(1)
    expect((await inspect()).patches).toEqual([])
  })

  it.each([
    'Stop',
    'unmount'
  ] as const)('aborts a pending test request on %s and disposes its late session once', async (cleanup) => {
    await mount(settings({ enabled: true, withProfile: true }))
    await page.getByRole('button', { name: 'Test' }).click()
    await page.getByText('Test mode: tap your zones').waitFor()
    expect((await inspect()).controls[0]).toMatchObject({ hasSignal: true, signalAborted: false })

    if (cleanup === 'Stop') await page.getByRole('button', { name: 'Stop' }).click()
    else await page.evaluate(() => window.__tapHarness.unmount())
    expect((await inspect()).controls[0]?.signalAborted).toBe(true)
    await page.evaluate(() => window.__tapHarness.resolveControl(0))
    await page.waitForTimeout(0)
    expect((await inspect()).controls[0]?.stopCalls).toBe(1)
    expect((await inspect()).patches).toEqual([])
    if (cleanup === 'Stop') await page.getByRole('button', { name: 'Test' }).waitFor()
  })
})
