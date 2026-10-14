import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import type { Browser, Page } from 'playwright'
import { build, type Rollup } from 'vite'
import react from '@vitejs/plugin-react'

const HARNESS_ID = '\0summary-only-import-harness'
const rendererSrc = resolve(__dirname, '..')
const modulePath = (path: string): string => JSON.stringify(resolve(rendererSrc, path).replace(/\\/g, '/'))
const HARNESS = `
import { createElement, useCallback } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { ImportQueueSection } from ${modulePath('components/ImportQueueSection.tsx')}
import { useImportQueue } from ${modulePath('components/useImportQueue.ts')}

let policyState = 'summary-only'
let capabilityState = 'available'
const settingsListeners = new Set()
const heldJob = {
  jobId: 'held-job', title: 'Saved import', state: 'policy-held', cursor: 0,
  totalChunks: 0, pct: null, createdAt: 0, updatedAt: 0
}
window.toto = {
  importJobsList: async () => ({
    jobs: [], policyBlocked: policyState !== 'allowed', policyState, capabilityState, persistenceState: 'configured',
    heldJobIds: ['held-job'], policyHeldJobIds: ['held-job'],
    inventoryOverflow: false, policyHoldOverflow: false
  }),
  onSettingsChanged: (listener) => { settingsListeners.add(listener); return () => settingsListeners.delete(listener) },
  onImportAudioProgress: () => () => {},
  onImportAssetsProgress: () => () => {}
}
function Probe() {
  const refreshList = useCallback(() => {}, [])
  const queue = useImportQueue(refreshList)
  return createElement(ImportQueueSection, {
    jobs: [heldJob], policyState: queue.policyState, capabilityState: queue.capabilityState,
    persistenceState: queue.persistenceState,
    policyHeldJobIds: queue.policyHeldJobIds,
    inventoryOverflow: queue.inventoryOverflow, policyHoldOverflow: queue.policyHoldOverflow,
    error: queue.error, assets: queue.assets, dragOver: queue.dragOver,
    onCancel: queue.cancel, onResume: queue.resume, onDismiss: queue.dismiss, onOpenMeeting: () => {}
  })
}
const root = createRoot(document.getElementById('root'))
flushSync(() => root.render(createElement(Probe)))
window.__summaryOnly = {
  restorePolicy() {
    policyState = 'allowed'
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
        name: 'summary-only-import-harness',
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

describe('summary-only import UI follows trusted settings changes', () => {
  let browser: Browser
  let page: Page

  beforeAll(async () => {
    const js = await bundleHarness()
    const { chromium } = await import('playwright')
    browser = await chromium.launch({ headless: true })
    page = await browser.newPage()
    await page.setContent('<!doctype html><html><body><div id="root"></div></body></html>')
    await page.addScriptTag({ content: js })
    await page.waitForSelector('button')
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
  })

  it('refreshes the held import and enables Resume after settings report policy restoration', async () => {
    const resumeDisabled = (): Promise<boolean> => page.locator('button').filter({ hasText: 'Resume' }).isDisabled()

    await expect.poll(resumeDisabled).toBe(true)
    await page.evaluate(() =>
      (window as unknown as { __summaryOnly: { restorePolicy(): void } }).__summaryOnly.restorePolicy()
    )
    await expect.poll(resumeDisabled).toBe(false)
    await expect
      .poll(() =>
        page.getByText('Saved imports paused while your organization’s summary-only policy was active').isVisible()
      )
      .toBe(true)
  })
})
