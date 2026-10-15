import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import type { Browser, Page } from 'playwright'
import { build, type Rollup } from 'vite'
import react from '@vitejs/plugin-react'

const HARNESS_ID = '\0import-queue-actions-harness'
const rendererSrc = resolve(__dirname, '..')
const modulePath = (path: string): string => JSON.stringify(resolve(rendererSrc, path).replace(/\\/g, '/'))
const HARNESS = `
import { createElement, useCallback } from 'react'
import { createRoot } from 'react-dom/client'
import { useImportQueue } from ${modulePath('components/useImportQueue.ts')}

let policyBlocked = false
const settingsListeners = new Set()
const state = { picked: 0, dropped: [], started: [] }
window.toto = {
  importJobsList: async () => ({
    jobs: [], policyBlocked, policyState: policyBlocked ? 'summary-only' : 'allowed',
    capabilityState: 'available', persistenceState: 'configured', heldJobIds: [], policyHeldJobIds: [],
    inventoryOverflow: false, policyHoldOverflow: false
  }),
  importAudioPick: async () => {
    state.picked++
    return { token: 'picker-fallback', name: 'fallback.wav', files: [
      { token: 'pick-a', name: 'standup.m4a', sizeBytes: 1, mtimeMs: 1 },
      { token: 'pick-b', name: 'demo.mp3', sizeBytes: 2, mtimeMs: 2 }
    ] }
  },
  importAudioDrop: async (files) => {
    state.dropped = files.map((file) => ({ name: file.name, type: file.type, hasPath: 'path' in file }))
    return { files: [{ token: 'drop-a', name: files[0].name, sizeBytes: files[0].size, mtimeMs: 1 }] }
  },
  importAudioStartBatch: async (tokens) => { state.started.push(tokens); return [] },
  onSettingsChanged: (listener) => { settingsListeners.add(listener); return () => settingsListeners.delete(listener) },
  onImportAudioProgress: () => () => {},
  onImportAssetsProgress: () => () => {}
}
function Probe() {
  const queue = useImportQueue(useCallback(() => {}, []))
  return createElement('div', { id: 'drop-target', onDrop: queue.onDrop, 'data-policy-blocked': String(queue.policyBlocked) },
    createElement('button', { type: 'button', onClick: queue.importAudio }, 'Import recordings'),
    queue.error && createElement('p', { role: 'alert' }, queue.error)
  )
}
const root = createRoot(document.getElementById('root'))
root.render(createElement(Probe))
window.__importQueueActions = {
  inspect: () => ({ picked: state.picked, dropped: state.dropped, started: state.started }),
  blockPolicy() {
    policyBlocked = true
    for (const listener of settingsListeners) listener()
  },
  unmount() { root.unmount() }
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
        name: 'import-queue-actions-harness',
        resolveId: (id) => (id === HARNESS_ID ? id : null),
        load: (id) => (id === HARNESS_ID ? HARNESS : null)
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

type QueueActionStats = {
  picked: number
  dropped: Array<{ name: string; type: string; hasPath: boolean }>
  started: string[][]
}

declare global {
  interface Window {
    __importQueueActions: {
      inspect(): QueueActionStats
      blockPolicy(): void
      unmount(): void
    }
  }
}

describe('import picker and drop use native-safe tokens', () => {
  let browser: Browser
  let page: Page

  beforeAll(async () => {
    const js = await bundleHarness()
    const { chromium } = await import('playwright')
    browser = await chromium.launch({ headless: true })
    page = await browser.newPage()
    await page.setContent('<!doctype html><html><body><div id="root"></div></body></html>')
    await page.addScriptTag({ content: js })
    await page.getByRole('button', { name: 'Import recordings' }).waitFor()
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
  })

  it('sends only tokens for picker and drop, and blocks both routes under summary-only policy', async () => {
    await page.getByRole('button', { name: 'Import recordings' }).click()
    await page.waitForFunction(() => window.__importQueueActions.inspect().started.length === 1)
    expect(await page.evaluate(() => window.__importQueueActions.inspect())).toMatchObject({
      picked: 1,
      started: [['pick-a', 'pick-b']]
    })

    await page.locator('#drop-target').evaluate((target) => {
      const transfer = new DataTransfer()
      transfer.items.add(new File(['audio'], 'field-recording.m4a', { type: 'audio/mp4' }))
      transfer.items.add(new File(['notes'], 'notes.pdf', { type: 'application/pdf' }))
      target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }))
    })
    await page.waitForFunction(() => window.__importQueueActions.inspect().started.length === 2)
    expect(await page.evaluate(() => window.__importQueueActions.inspect())).toMatchObject({
      dropped: [{ name: 'field-recording.m4a', type: 'audio/mp4', hasPath: false }],
      started: [['pick-a', 'pick-b'], ['drop-a']]
    })

    await page.evaluate(() => window.__importQueueActions.blockPolicy())
    await page.locator('#drop-target').waitFor({ state: 'visible' })
    await page.waitForFunction(
      () => document.querySelector('#drop-target')?.getAttribute('data-policy-blocked') === 'true'
    )
    await page.getByRole('button', { name: 'Import recordings' }).click()
    await page.getByRole('alert').getByText('summary-only policy prevents import').waitFor({ state: 'visible' })
    await page.locator('#drop-target').evaluate((target) => {
      const transfer = new DataTransfer()
      transfer.items.add(new File(['audio'], 'blocked-recording.m4a', { type: 'audio/mp4' }))
      target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }))
    })
    expect(await page.evaluate(() => window.__importQueueActions.inspect())).toMatchObject({
      picked: 1,
      dropped: [{ name: 'field-recording.m4a', type: 'audio/mp4', hasPath: false }],
      started: [['pick-a', 'pick-b'], ['drop-a']]
    })
  })
})
