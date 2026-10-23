/** The real Settings component in Chromium: OFF can still select and preview, and Stop survives state changes. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import type { Browser, Page } from 'playwright'
import { build, type Rollup } from 'vite'
import react from '@vitejs/plugin-react'

const HARNESS_ID = '\0spoken-replies-section-harness'
const rendererSrc = resolve(__dirname, '../..')
const modulePath = (path: string): string => JSON.stringify(resolve(rendererSrc, path).replace(/\\/g, '/'))
const VOICE = { id: 'com.apple.ttsbundle.Samantha-compact', name: 'Samantha', language: 'en-US' }

const HARNESS = `
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { SpokenRepliesSection } from ${modulePath('features/settings/SpokenRepliesSection.tsx')}
import { DEFAULT_SETTINGS, PublicSettingsSchema } from ${modulePath('../../shared/ipc.ts')}

const config = window.__spokenConfig
const calls = []
const listeners = new Set()
let state = config.state
let settings = PublicSettingsSchema.parse({
  ...DEFAULT_SETTINGS, hasApiKey: false, providerReady: false, visionReady: false, hasKeys: {}, hasEncryption: true,
  resolvedMeetingsFolder: '', ...config.settings
})
const patches = []
const emit = () => listeners.forEach((listener) => listener(state))
const bridge = {
  getState: async () => state,
  onState: (callback) => { listeners.add(callback); return () => listeners.delete(callback) },
  voices: async () => config.voices,
  preview: async (request) => {
    calls.push({ name: 'preview', args: [request] })
    state = { ...state, revision: state.revision + 1, playback: 'preview' }
    emit()
    return { ok: true }
  },
  stop: async () => {
    calls.push({ name: 'stop', args: [] })
    state = { ...state, revision: state.revision + 1, playback: 'idle' }
    emit()
    return { ok: true }
  }
}
window.toto = { spokenReplies: bridge }
const root = createRoot(document.getElementById('root'))
const render = () => flushSync(() => root.render(createElement(SpokenRepliesSection, { settings, patch })))
function patch(next) {
  patches.push(next)
  settings = { ...settings, ...next }
  render()
  return Promise.resolve(settings)
}
window.__spoken = {
  inspect: () => ({ calls, patches, settings, state }),
  updateState: (next) => { state = next; emit() },
  updateSettings: (next) => { settings = { ...settings, ...next }; render() },
  unmount: () => flushSync(() => root.unmount())
}
render()
`

declare global {
  interface Window {
    __spokenConfig: Record<string, unknown>
    __spoken: {
      inspect(): Promise<{
        calls: Array<{ name: string; args: unknown[] }>
        patches: Array<{ spokenReplies?: { speakReplies?: boolean; voiceId?: string | null; rate?: number } }>
        settings: Record<string, unknown> & {
          spokenReplies: { speakReplies: boolean; voiceId: string | null; rate: number }
        }
        state: {
          revision: number
          available: boolean
          playback: 'idle' | 'reply' | 'preview'
          muted: string | null
          generation: number
        }
      }>
      updateState(state: {
        revision: number
        available: boolean
        playback: 'idle' | 'reply' | 'preview'
        muted: string | null
        generation: number
      }): void
      updateSettings(settings: Record<string, unknown>): void
      unmount(): void
    }
  }
}

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
        name: 'spoken-replies-section-harness',
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
  return (Array.isArray(output) ? output : [output])
    .flatMap((result) => result.output)
    .filter((file): file is Rollup.OutputChunk => file.type === 'chunk')
    .map((chunk) => chunk.code)
    .join('\n')
}

describe('Settings › Speech › Spoken replies (G27)', () => {
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

  async function mount(): Promise<void> {
    await page.setContent('<!doctype html><html><body><div id="root"></div></body></html>')
    await page.evaluate(
      ({ voice, state }) => {
        window.__spokenConfig = {
          voices: [voice],
          state,
          settings: { spokenReplies: { speakReplies: false, voiceId: null, rate: 1 } }
        }
      },
      {
        voice: VOICE,
        state: { revision: 1, available: true, playback: 'idle', muted: 'off', generation: 0 }
      }
    )
    await page.addScriptTag({ content: bundle })
  }

  const inspect = () => page.evaluate(() => window.__spoken.inspect())

  it('explains unavailability even while automatic replies are OFF', async () => {
    await page.setContent('<!doctype html><html><body><div id="root"></div></body></html>')
    await page.evaluate(
      ({ voice }) => {
        window.__spokenConfig = {
          voices: [voice],
          state: { revision: 2, available: false, playback: 'idle', muted: 'unavailable', generation: 0 },
          settings: { spokenReplies: { speakReplies: false, voiceId: null, rate: 1 } }
        }
      },
      { voice: VOICE }
    )
    await page.addScriptTag({ content: bundle })

    const notice = page.getByText("Spoken replies aren't available on this computer. Answers stay on screen.", {
      exact: true
    })
    await notice.waitFor()
    const preview = page.getByRole('button', { name: 'Preview voice', exact: true })
    expect(await preview.isDisabled()).toBe(true)
    expect((await inspect()).settings.spokenReplies.speakReplies).toBe(false)
  })

  it('selects and previews while automatic replies are OFF, then keeps Stop live through managed and unavailable updates', async () => {
    await mount()
    const voice = page.getByRole('combobox', { name: 'Voice', exact: true })
    await voice.waitFor()
    await expect.poll(async () => voice.locator('option').count()).toBe(2)
    await voice.selectOption(VOICE.id)
    const rate = page.getByRole('slider', { name: 'Speed', exact: true })
    await rate.focus()
    for (let step = 0; step < 5; step++) await rate.press('ArrowRight')
    await page.getByRole('button', { name: 'Preview voice', exact: true }).click()

    await expect
      .poll(async () => (await inspect()).calls)
      .toEqual([{ name: 'preview', args: [{ voiceId: VOICE.id, rate: 1.25 }] }])
    let state = await inspect()
    expect(state.settings.spokenReplies.speakReplies).toBe(false)
    expect(state.patches.every((patch) => patch.spokenReplies?.speakReplies !== true)).toBe(true)
    await page.evaluate(() => window.__spoken.updateSettings({ managedKeys: ['spokenReplies'] }))
    const stop = page.getByRole('button', { name: 'Stop preview', exact: true })
    expect(await stop.isEnabled()).toBe(true)
    await stop.click()

    await page.evaluate(() => window.__spoken.updateSettings({ managedKeys: [] }))
    await page.getByRole('button', { name: 'Preview voice', exact: true }).click()
    await page.evaluate(() =>
      window.__spoken.updateState({
        revision: 40,
        available: false,
        playback: 'preview',
        muted: 'unavailable',
        generation: 3
      })
    )
    const unavailableStop = page.getByRole('button', { name: 'Stop preview', exact: true })
    expect(await unavailableStop.isEnabled()).toBe(true)
    await unavailableStop.click()

    state = await inspect()
    expect(state.calls.map((call) => call.name)).toEqual(['preview', 'stop', 'preview', 'stop'])
    expect(state.settings.spokenReplies).toMatchObject({ speakReplies: false, voiceId: VOICE.id, rate: 1.25 })
  })
})
