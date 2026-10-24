import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import type { Browser, Page } from 'playwright'
import { build, type Rollup } from 'vite'
import react from '@vitejs/plugin-react'

const HARNESS_ID = '\0optional-components-section-harness'
const rendererSrc = resolve(__dirname, '../..')
const modulePath = (path: string): string => JSON.stringify(resolve(rendererSrc, path).replace(/\\/g, '/'))

// The bridge lives in the page so the test drives the real component through real clicks.
const HARNESS = `
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { OptionalComponentsSection } from ${modulePath('features/settings/OptionalComponentsSection.tsx')}

const config = window.__offloadConfig
const calls = { previews: [], confirms: [], states: 0 }
const bridge = {
  speechPackState: () => {
    calls.states++
    return Promise.resolve({ optionalComponents: config.components() })
  },
  componentOffloadPreview: (componentId) => {
    calls.previews.push(componentId)
    return Promise.resolve(config.previewResult(componentId))
  },
  componentOffloadConfirm: (planId) => {
    calls.confirms.push(planId)
    return Promise.resolve(config.confirmResult(planId))
  },
  componentOffloadReceipts: () => Promise.resolve(config.receipts())
}
window.__offload = { inspect: () => ({ previews: [...calls.previews], confirms: [...calls.confirms], states: calls.states }) }
flushSync(() => createRoot(document.getElementById('root')).render(createElement(OptionalComponentsSection, { bridge })))
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
        name: 'optional-components-section-harness',
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

declare global {
  interface Window {
    __offloadConfig: Record<string, unknown>
    __offload: { inspect(): { previews: string[]; confirms: string[]; states: number } }
  }
}

// The config functions are serialised into the page, so they are built from source text.
const CONFIG_SOURCE = `({
  removed: false,
  components() {
    const base = (id, label, presence, removable) => ({
      id, label, provider: 'Provider of ' + id, sourceHost: 'huggingface.co', privacy: 'on-device',
      privacyNote: 'Privacy note of ' + id, downloadBytes: 157286400, installedBytes: 209715200,
      presence, blockedBy: null, failure: null, installable: false, removable, removableBytes: removable ? 209715200 : 0,
      offer: { surface: 'settings', consent: 'required' }
    })
    return [
      base('local-llm', 'Métis Local', 'bundled', false),
      base('whisper', 'Whisper (offline speech)', this.removed ? 'absent' : 'installed', !this.removed),
      base('parakeet', 'Parakeet (fast offline speech)', 'bundled', false)
    ]
  },
  previewResult(componentId) {
    return { ok: true, plan: { planId: '11111111-1111-4111-8111-111111111111', componentId, label: 'Whisper (offline speech)', removableBytes: 209715200, degradesTo: 'cloud-speech', expiresAt: new Date(Date.now() + 120000).toISOString() } }
  },
  confirmResult() {
    this.removed = true
    return { ok: true, receipt: { receiptId: '22222222-2222-4222-8222-222222222222', componentId: 'whisper', label: 'Whisper (offline speech)', removedAt: new Date().toISOString(), bytesFreed: 209715200, freeBytesBefore: 1073741824, freeBytesAfter: 1283457024, verifiedAbsent: true, sessionDataTouched: false } }
  },
  receipts() { return [] }
})`

describe('OptionalComponentsSection browser behavior (G87)', () => {
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
    await page.evaluate((source) => {
      window.__offloadConfig = (0, eval)(source)
    }, CONFIG_SOURCE)
    await page.addScriptTag({ content: bundle })
    await page.getByRole('heading', { name: 'Optional components' }).waitFor()
  }

  const inspect = () => page.evaluate(() => window.__offload.inspect())

  it('shows size, provider, source host and privacy for each component, with no Remove on bundled rows', async () => {
    await mount()
    const text = (await page.locator('section').innerText()).replace(/\s+/g, ' ')
    expect(text).toContain('Provider of whisper')
    expect(text).toContain('huggingface.co')
    expect(text).toContain('150 MB download')
    expect(text).toContain('Privacy note of parakeet')
    expect(await page.getByRole('button', { name: /^Remove / }).count()).toBe(1)
    expect(await page.locator('[data-component="local-llm"] button').count()).toBe(0)
    expect(await page.locator('[data-component="parakeet"] button').count()).toBe(0)
  })

  it('Remove requires the confirm card and then shows the receipt with freed bytes', async () => {
    await mount()
    await page.getByRole('button', { name: 'Remove Whisper (offline speech)' }).click()
    await page.getByRole('group', { name: 'Confirm removal' }).waitFor()
    // Previewing removed nothing.
    expect(await inspect()).toMatchObject({ previews: ['whisper'], confirms: [] })
    expect((await page.getByRole('group', { name: 'Confirm removal' }).innerText()).replace(/\s+/g, ' ')).toContain(
      'frees about 200 MB'
    )
    await page.getByRole('button', { name: 'Confirm remove' }).click()
    await page.getByRole('status', { name: 'Removal receipt' }).waitFor()
    expect(await inspect()).toMatchObject({ confirms: ['11111111-1111-4111-8111-111111111111'] })
    const receipt = (await page.getByRole('status', { name: 'Removal receipt' }).innerText()).replace(/\s+/g, ' ')
    expect(receipt).toContain('Freed 200 MB (measured)')
    expect(receipt).toContain('Files confirmed gone.')
    // The row now reads as not downloaded and offers no Remove.
    expect(await page.getByRole('button', { name: /^Remove / }).count()).toBe(0)
  })

  it('Keep it dismisses the confirm card without removing anything', async () => {
    await mount()
    await page.getByRole('button', { name: 'Remove Whisper (offline speech)' }).click()
    await page.getByRole('button', { name: 'Keep it' }).click()
    expect(await page.getByRole('group', { name: 'Confirm removal' }).count()).toBe(0)
    expect((await inspect()).confirms).toEqual([])
  })
})
