/** TaskCardsHost's subscription/list race in a real, isolated Chromium DOM. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import type { Browser, BrowserContext, Page } from 'playwright'
import { build, type Rollup } from 'vite'
import react from '@vitejs/plugin-react'

const HARNESS_ID = '\0task-cards-host-harness'
const rendererSrc = resolve(__dirname, '..')
const modulePath = (path: string): string => JSON.stringify(resolve(rendererSrc, path).replace(/\\/g, '/'))

const HARNESS = `
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { TaskCardsHost } from ${modulePath('components/TaskCardsHost.tsx')}

const state = { resolveInitial: null, listener: null }
window.IS_REACT_ACT_ENVIRONMENT = true
window.toto = { taskCards: {
  list: () => new Promise((resolve) => { state.resolveInitial = resolve }),
  onCards: (listener) => { state.listener = listener; return () => { state.listener = null } },
  stop: async () => ({ ok: true }),
  dismiss: async () => ({ ok: true })
} }
createRoot(document.getElementById('root')).render(createElement(TaskCardsHost))
window.__taskCardsHost = {
  ready: () => Boolean(state.resolveInitial && state.listener),
  resolveInitial: async (cards) => {
    await act(async () => {
      state.resolveInitial(cards)
      await Promise.resolve()
    })
  },
  push: async (cards) => {
    await act(async () => {
      state.listener?.(cards)
    })
  }
}
`

async function bundleHarness(): Promise<string> {
  const rendererRoot = resolve(rendererSrc, '..')
  const output = (await build({
    root: rendererRoot,
    configFile: false,
    mode: 'development',
    logLevel: 'silent',
    define: {
      'process.env.NODE_ENV': '"development"',
      __METIS_FEEDBACK_EMAIL__: '""',
      __METIS_QA_IDENTITY__: 'false'
    },
    resolve: { alias: { '@': rendererSrc, '@shared': resolve(rendererRoot, '../shared') } },
    plugins: [
      react(),
      {
        name: 'task-cards-host-harness',
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

declare global {
  interface Window {
    __taskCardsHost: {
      ready(): boolean
      resolveInitial(cards: unknown[]): Promise<void>
      push(cards: unknown[]): Promise<void>
    }
  }
}

const RUNNING_CARD = {
  cardId: 'a'.repeat(32),
  actionId: 'desktop.open_notes',
  phase: 'running',
  stoppable: true,
  dismissible: false
}
const DONE_CARD = {
  cardId: 'c'.repeat(32),
  actionId: 'desktop.create_note',
  phase: 'done',
  stoppable: false,
  dismissible: true
}

describe('TaskCardsHost owner-state synchronization', () => {
  let browser: Browser
  let context: BrowserContext
  let page: Page
  let bundle: string

  beforeAll(async () => {
    bundle = await bundleHarness()
    const { chromium } = await import('playwright')
    browser = await chromium.launch({ headless: true })
  }, 120_000)

  beforeEach(async () => {
    context = await browser.newContext({ offline: true, serviceWorkers: 'block' })
    await context.route('**/*', (route) => route.abort())
    page = await context.newPage()
    await page.setContent('<!doctype html><html><body><div id="root"></div></body></html>')
    await page.addScriptTag({ content: bundle })
    await page.waitForFunction(() => window.__taskCardsHost.ready())
  })

  afterEach(async () => {
    await context?.close()
  })

  afterAll(async () => {
    await browser?.close()
  })

  it('renders a healthy initial main-process list', async () => {
    await page.evaluate((cards) => window.__taskCardsHost.resolveInitial(cards), [RUNNING_CARD])
    await page.locator('[data-task-card="running"]').waitFor()
    expect(await page.locator('[data-task-card="running"]').count()).toBe(1)
  })

  it('does not let a pending initial list overwrite a newer empty owner push', async () => {
    await page.evaluate(() => window.__taskCardsHost.push([]))
    await page.evaluate((cards) => window.__taskCardsHost.resolveInitial(cards), [RUNNING_CARD])
    expect(await page.locator('[data-task-card="running"]').count()).toBe(0)
  })

  it('does not let a pending initial list replace a newer nonempty owner push', async () => {
    await page.evaluate((cards) => window.__taskCardsHost.push(cards), [DONE_CARD])
    await page.evaluate((cards) => window.__taskCardsHost.resolveInitial(cards), [RUNNING_CARD])
    expect(await page.locator('[data-task-card="done"]').count()).toBe(1)
    expect(await page.locator('[data-task-card="running"]').count()).toBe(0)
  })
})
