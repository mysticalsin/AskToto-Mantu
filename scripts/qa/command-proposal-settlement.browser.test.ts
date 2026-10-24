/** Real confirmation UI and main task bridge across a detached renderer settlement, in offline Chromium. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolve } from 'node:path'
import type { Browser, BrowserContext, Page } from 'playwright'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { build, type Rollup } from 'vite'
import react from '@vitejs/plugin-react'
import type { DesktopActionRequest, DesktopActionResult } from '../../src/shared/desktop-actions'
import { COMMAND_CONFIRM_IPC, type MetisCommandState } from '../../src/shared/metis-command-contract'
import { IPC } from '../../src/shared/ipc'
import { CommandConfirmation } from '../../src/main/command-confirmation'
import { registerCommandConfirmIpc } from '../../src/main/ipc/command-confirm-ipc'
import type { TaskStateStore } from '../../src/main/tasks/encrypted-task-file-store'
import {
  DesktopActionTaskBridge,
  type DesktopActionTaskBridgeDeps
} from '../../src/main/tasks/desktop-action-task-bridge'
import type { TaskStateReadResult } from '../../src/main/tasks/task-persistence'

const HARNESS_ID = '\0command-proposal-settlement-harness'
const rendererSrc = resolve(__dirname, '../../src/renderer/src')
const modulePath = (path: string): string => JSON.stringify(resolve(rendererSrc, path).replace(/\\/g, '/'))
const OWNER_ID = 7
const PRINCIPAL_A = { ownerKey: 'a'.repeat(64), tenantKey: 'b'.repeat(64) }
const NOTE: DesktopActionRequest = { id: 'desktop.create_note', args: { title: 'Synthetic settlement fixture' } }

const HARNESS = `
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { CommandProposalHost } from ${modulePath('components/CommandProposalHost.tsx')}

const state = {
  componentState: { proposalId: null },
  mounted: false,
  noticeListener: null,
  noticePushes: [],
  confirmationResults: [],
  recoveryResponses: []
}
window.IS_REACT_ACT_ENVIRONMENT = true
window.toto = {
  onMetisCommandNotice(listener) {
    state.noticeListener = listener
    return () => { state.noticeListener = null }
  },
  takeMetisCommandRecoveryNotices: async () => {
    const notices = await window.__takeRecovery()
    state.recoveryResponses.push(notices)
    return notices
  },
  confirmMetisCommand: async (input) => {
    const result = await window.__confirm(input)
    state.confirmationResults.push(result)
    return result
  },
  cancelMetisCommand: async (input) => window.__cancel(input),
  openPermissionSettings: async () => undefined,
  // The account choice card (G62) shares this host; with no pending choice it renders nothing.
  accountChoice: {
    current: async () => ({ choiceId: null }),
    onChanged: () => () => undefined
  },
  // The connector confirm card (G64) shares this host too.
  connectorConfirm: {
    current: async () => ({ proposalId: null }),
    onChanged: () => () => undefined
  }
}
const root = createRoot(document.getElementById('root'))
function render() {
  root.render(state.mounted ? createElement(CommandProposalHost, { state: state.componentState }) : null)
}
window.__commandProposalHost = {
  mount: async (nextState = { proposalId: null }) => {
    await act(async () => {
      state.mounted = true
      state.componentState = nextState
      render()
      await Promise.resolve()
    })
  },
  unmount: async () => {
    await act(async () => {
      state.mounted = false
      render()
      await Promise.resolve()
    })
  },
  setState: async (nextState) => {
    await act(async () => {
      state.componentState = nextState
      render()
      await Promise.resolve()
    })
  },
  pushNotice: async (notice) => {
    state.noticePushes.push(notice)
    await act(async () => {
      state.noticeListener?.(notice)
      await Promise.resolve()
    })
  },
  takeRecoveryAgain: async () => window.toto.takeMetisCommandRecoveryNotices(),
  flush: async () => act(async () => { await Promise.resolve() }),
  snapshot: () => ({
    mounted: state.mounted,
    noticeSubscribed: state.noticeListener !== null,
    noticePushes: [...state.noticePushes],
    confirmationResults: [...state.confirmationResults],
    recoveryResponses: [...state.recoveryResponses],
    text: document.body.innerText,
    rootChildCount: document.getElementById('root')?.childElementCount ?? -1
  })
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
        name: 'command-proposal-settlement-harness',
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
    __confirm(input: { proposalId: string; nonce: string; argsHash: string }): Promise<unknown>
    __cancel(input: { proposalId: string; nonce: string }): Promise<unknown>
    __takeRecovery(): Promise<unknown[]>
    __commandProposalHost: {
      mount(state?: MetisCommandState): Promise<void>
      unmount(): Promise<void>
      setState(state: MetisCommandState): Promise<void>
      pushNotice(notice: unknown): Promise<void>
      takeRecoveryAgain(): Promise<unknown[]>
      flush(): Promise<void>
      snapshot(): {
        mounted: boolean
        noticeSubscribed: boolean
        noticePushes: unknown[]
        confirmationResults: unknown[]
        recoveryResponses: unknown[][]
        text: string
        rootChildCount: number
      }
    }
  }
}

declare const window: Window

class MemoryStore implements TaskStateStore {
  serialized: string | null = null
  writes = 0

  async read(): Promise<TaskStateReadResult> {
    return this.serialized === null ? { kind: 'not-found' } : { kind: 'found', serialized: this.serialized }
  }
  async write(serialized: string): Promise<void> {
    this.writes += 1
    this.serialized = serialized
  }
  async quarantine(): Promise<void> {
    this.serialized = null
  }
}

class MemoryAcks {
  ids: string[] = []
  writes = 0

  async read(): Promise<readonly string[]> {
    return [...this.ids]
  }
  async write(ids: readonly string[]): Promise<void> {
    this.writes += 1
    this.ids = [...ids]
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept
    reject = fail
  })
  return { promise, resolve, reject }
}

function fixture(page: Page, adapter: () => Promise<DesktopActionResult>) {
  const store = new MemoryStore()
  const acknowledgements = new MemoryAcks()
  let generation = 1
  let principal: typeof PRINCIPAL_A | null = PRINCIPAL_A
  let id = 0
  let confirmCall: Promise<unknown> | null = null
  let confirmCallSettled = false
  const uiUpdates: Promise<void>[] = []
  let recoveryInvoke: (() => Promise<unknown[]>) | undefined
  const bridge = new DesktopActionTaskBridge({
    execute: adapter,
    store,
    acknowledgements,
    authSessionGeneration: () => generation,
    recoveryPrincipal: () => principal,
    newId: () => `synthetic-${++id}`,
    newCardId: () => (++id).toString(16).padStart(32, '0'),
    now: () => 1_800_000_000_000
  })
  const handlers = new Map<string, (event: IpcMainInvokeEvent) => unknown>()
  const registerRecoveryHandler = (currentBridge: DesktopActionTaskBridge): void => {
    const ipcMain: Pick<IpcMain, 'handle'> = {
      handle: (channel, handler) => {
        handlers.set(channel, handler as unknown as (event: IpcMainInvokeEvent) => unknown)
      }
    }
    registerCommandConfirmIpc(
      ipcMain,
      (event) => {
        if (event.sender.id !== OWNER_ID) throw new Error('wrong main-window sender')
      },
      { takeRecoveryNotices: () => currentBridge.takeRecoveryNotices() }
    )
    const handler = handlers.get(COMMAND_CONFIRM_IPC.recoveryNotices)
    if (!handler) throw new Error('recovery IPC handler was not registered')
    const syntheticIpcMainInvokeEvent = { sender: { id: OWNER_ID } } as unknown as IpcMainInvokeEvent
    recoveryInvoke = async () => (await handler(syntheticIpcMainInvokeEvent)) as unknown[]
  }
  registerRecoveryHandler(bridge)

  const owner = {
    isDestroyed: () => false,
    isVisible: () => true,
    isFocused: () => true,
    webContents: {
      id: OWNER_ID,
      send: (channel: string, ...args: unknown[]) => {
        const update =
          channel === IPC.metisCommandState
            ? page.evaluate((state) => window.__commandProposalHost.setState(state as MetisCommandState), args[0])
            : channel === COMMAND_CONFIRM_IPC.notice
              ? page.evaluate((notice) => window.__commandProposalHost.pushNotice(notice), args[0])
              : Promise.resolve()
        uiUpdates.push(update.then(() => undefined))
      }
    }
  }
  const confirmation = new CommandConfirmation({
    execute: bridge.execute,
    recoverTasks: bridge.recover,
    stopTasks: bridge.stop,
    isAuthenticated: () => true,
    hasListenEntitlement: () => true,
    getOwner: () => owner,
    isOnboardingExclusive: () => false,
    audit: () => undefined,
    platform: 'darwin',
    minConfirmDelayMs: 0
  })
  confirmation.initialize({ on: () => undefined }, () => undefined, { warn: () => undefined, error: () => undefined })

  return {
    store,
    acknowledgements,
    bridge,
    confirmation,
    get generation() {
      return generation
    },
    get principal() {
      return principal
    },
    set generation(value: number) {
      generation = value
    },
    set principal(value: typeof PRINCIPAL_A | null) {
      principal = value
    },
    registerRecoveryHandler,
    get confirmCall() {
      return confirmCall
    },
    get confirmCallSettled() {
      return confirmCallSettled
    },
    async flushUi(): Promise<void> {
      await Promise.all(uiUpdates.splice(0))
      await page.evaluate(() => window.__commandProposalHost.flush())
    },
    async installBindings(): Promise<void> {
      await page.exposeBinding(
        '__confirm',
        async (_source, input: { proposalId: string; nonce: string; argsHash: string }) => {
          const call = confirmation.confirm({ ...input, webContentsId: OWNER_ID })
          confirmCall = call
          void call.then(
            () => {
              confirmCallSettled = true
            },
            () => {
              confirmCallSettled = true
            }
          )
          return call
        }
      )
      await page.exposeBinding('__cancel', async (_source, input: { proposalId: string; nonce: string }) =>
        confirmation.cancel({ ...input, webContentsId: OWNER_ID })
      )
      await page.exposeBinding('__takeRecovery', async () => {
        if (!recoveryInvoke) throw new Error('recovery IPC handler is unavailable')
        return recoveryInvoke()
      })
    }
  }
}

async function cleanupFixture(
  main: ReturnType<typeof fixture>,
  releaseAdapter: () => void,
  pendingConfirmation?: Promise<unknown>
): Promise<void> {
  releaseAdapter()
  try {
    const outstanding = pendingConfirmation ?? main.confirmCall
    if (outstanding) {
      await vi.waitFor(() => expect(main.confirmCallSettled).toBe(true), { timeout: 2_000 })
      await Promise.allSettled([outstanding])
    }
  } finally {
    main.confirmation.revokeForLifecycleEvent('window_closed')
    await main.flushUi()
  }
}

const verified = (request: DesktopActionRequest, _envelope: unknown): DesktopActionResult => ({
  id: request.id,
  ok: true,
  outcome: 'verified',
  receipt: { idempotencyKey: 'unused', argsHash: 'unused', observation: 'synthetic' }
})

describe('CommandProposalHost late detached settlement', () => {
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
  })

  afterEach(async () => {
    await context?.close()
  })

  afterAll(async () => {
    await browser?.close()
  })

  it('shows the unverified sentence and auto-acknowledges an ordinary mounted settlement', async () => {
    const adapter = deferred<DesktopActionResult>()
    void adapter.promise.catch(() => undefined)
    let adapterStarted = false
    const main = fixture(page, async () => {
      adapterStarted = true
      return adapter.promise
    })
    await main.installBindings()
    await main.bridge.recover()
    await page.evaluate(() => window.__commandProposalHost.mount())
    await page.waitForFunction(() => window.__commandProposalHost.snapshot().recoveryResponses.length === 1)

    let confirmationPromise: ReturnType<typeof main.confirmation.confirm> | undefined
    try {
      main.confirmation.propose({ webContentsId: OWNER_ID, revision: 1 }, NOTE)
      await main.flushUi()
      const dialog = page.getByRole('alertdialog')
      await dialog.waitFor()
      await page.getByRole('button', { name: 'Create' }).click()
      await vi.waitFor(() => expect(adapterStarted).toBe(true), { timeout: 2_000 })
      await vi.waitFor(() => expect(main.confirmCall).not.toBeNull(), { timeout: 2_000 })
      confirmationPromise = main.confirmCall as ReturnType<typeof main.confirmation.confirm>

      adapter.reject(new Error('synthetic lost adapter acknowledgement'))
      await confirmationPromise
      await page.waitForFunction(() => window.__commandProposalHost.snapshot().confirmationResults.length === 1)
      await page.getByRole('status').filter({ hasText: "couldn't confirm it worked" }).waitFor()
      await main.flushUi()

      expect(main.bridge.snapshot()).toMatchObject([{ status: 'uncertain', effectOutcome: 'uncertain' }])
      expect(main.acknowledgements.ids).toEqual([main.bridge.snapshot()[0]?.taskId])
      expect(await page.locator('[role="alertdialog"]').count()).toBe(0)
      expect((await page.evaluate(() => window.__commandProposalHost.snapshot())).text).toContain(
        "couldn't confirm it worked"
      )
    } finally {
      await cleanupFixture(main, () => adapter.reject(new Error('cleanup release')), confirmationPromise)
    }
  })

  it('keeps an uncertain result unacknowledged while its retired renderer is unmounted, then recovers it once for A', async () => {
    const adapter = deferred<DesktopActionResult>()
    void adapter.promise.catch(() => undefined)
    let adapterStarted = false
    const main = fixture(page, async () => {
      adapterStarted = true
      return adapter.promise
    })
    await main.installBindings()
    await main.bridge.recover()
    await page.evaluate(() => window.__commandProposalHost.mount())
    await page.waitForFunction(() => window.__commandProposalHost.snapshot().recoveryResponses.length === 1)

    let confirmationPromise: ReturnType<typeof main.confirmation.confirm> | undefined
    try {
      main.confirmation.propose({ webContentsId: OWNER_ID, revision: 1 }, NOTE)
      await main.flushUi()
      await page.getByRole('alertdialog').waitFor()
      await page.getByRole('button', { name: 'Create' }).click()
      await vi.waitFor(() => expect(adapterStarted).toBe(true), { timeout: 2_000 })
      await vi.waitFor(() => expect(main.confirmCall).not.toBeNull(), { timeout: 2_000 })
      confirmationPromise = main.confirmCall as ReturnType<typeof main.confirmation.confirm>
      await vi.waitFor(() => expect(main.store.serialized).toContain('"status":"dispatching"'), { timeout: 2_000 })
      expect((await page.evaluate(() => window.__commandProposalHost.snapshot())).noticeSubscribed).toBe(true)

      main.generation = 2
      main.principal = null
      main.confirmation.revokeForLifecycleEvent('auth_session_cleared')
      await main.flushUi()
      await page.evaluate(() => window.__commandProposalHost.unmount())
      expect((await page.evaluate(() => window.__commandProposalHost.snapshot())).mounted).toBe(false)

      // Retirement and the awaited React unmount happen before the adapter settles.
      adapter.reject(new Error('synthetic late adapter settlement'))
      await confirmationPromise
      await page.waitForFunction(() => window.__commandProposalHost.snapshot().confirmationResults.length === 1)
      await main.flushUi()

      expect(main.bridge.snapshot()).toMatchObject([{ status: 'uncertain', effectOutcome: 'uncertain' }])
      expect(main.bridge.cards(`webContents:${OWNER_ID}`)).toEqual([])
      const retiredUi = await page.evaluate(() => window.__commandProposalHost.snapshot())
      expect(retiredUi).toMatchObject({ mounted: false, noticeSubscribed: false, noticePushes: [], rootChildCount: 0 })
      expect(retiredUi.text).not.toContain("couldn't confirm it worked")
      expect(retiredUi.text).not.toContain('Synthetic settlement fixture')
      expect(retiredUi.text).not.toContain('A voice action may not have finished')
      expect(retiredUi.confirmationResults).toEqual([{ ok: false, reason: 'outcome_unverified' }])
      expect(main.acknowledgements.ids).toEqual([])
      expect(main.acknowledgements.writes).toBe(0)

      main.generation = 3
      main.principal = PRINCIPAL_A
      let recoveryExecutorCalls = 0
      const restarted = new DesktopActionTaskBridge({
        execute: async (request) => {
          recoveryExecutorCalls += 1
          return verified(request, undefined)
        },
        store: main.store,
        acknowledgements: main.acknowledgements,
        authSessionGeneration: () => main.generation,
        recoveryPrincipal: () => main.principal,
        now: () => 1_800_000_000_000
      } as DesktopActionTaskBridgeDeps)
      await restarted.recover()
      main.registerRecoveryHandler(restarted)
      await page.evaluate(() => window.__commandProposalHost.mount())
      await page.getByRole('status').filter({ hasText: 'A voice action may not have finished' }).waitFor()
      await main.flushUi()

      const recoveredUi = await page.evaluate(() => window.__commandProposalHost.snapshot())
      expect(recoveredUi.text).toContain("Métis won't retry it.")
      expect(recoveredUi.text).not.toContain("couldn't confirm it worked")
      expect(await page.locator('[role="alertdialog"]').count()).toBe(0)
      expect(recoveryExecutorCalls).toBe(0)
      expect(main.acknowledgements.ids).toEqual([main.bridge.snapshot()[0]?.taskId])
      expect(recoveredUi.recoveryResponses).toHaveLength(2)
      expect(recoveredUi.recoveryResponses[1]).toEqual([
        {
          taskId: main.bridge.snapshot()[0]?.taskId,
          actionId: NOTE.id,
          copy: "A voice action may not have finished: Create note. Métis won't retry it."
        }
      ])
      const secondRecovery = await page.evaluate(() => window.__commandProposalHost.takeRecoveryAgain())
      expect(secondRecovery).toEqual([])
    } finally {
      await cleanupFixture(main, () => adapter.reject(new Error('cleanup release')), confirmationPromise)
    }
  })
})
