import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopActionRequest, DesktopActionResult } from '@shared/desktop-actions'
import { TASK_CARD_IPC } from '@shared/task-card'
import type { CommandConfirmRuntime } from './command-confirm-runtime'
import { CommandConfirmation } from '../command-confirmation'
import { registerTaskCardIpc } from '../ipc/task-card-ipc'
import type { ActionEnvelope } from '../action-guard'

const state = vi.hoisted(() => ({
  generation: 51,
  serialized: null as string | null,
  execute: vi.fn()
}))

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '/isolated/asktoto-userdata', isAccessibilitySupportEnabled: () => false }
}))
vi.mock('../foreground-watcher', () => ({
  startForegroundWatcher: () => ({ current: () => null, healthy: () => true, stop: vi.fn() })
}))
vi.mock('../desktop-permission-probes', () => ({ createDesktopPermissionProbes: () => ({}) }))
vi.mock('../mac-helper', () => ({ activatePid: vi.fn() }))
vi.mock('../logger', () => ({ mainLog: { warn: vi.fn(), error: vi.fn() }, auditLog: vi.fn() }))
vi.mock('./command-preflight', () => ({ createCommandPreflight: () => async () => ({ ok: true }) }))
vi.mock('./confirm-focus', () => ({
  createConfirmFocus: () => ({ presented: vi.fn(), release: vi.fn() })
}))
vi.mock('./gesture-binding', () => ({
  createGestureBindings: () => ({ current: () => null, clear: vi.fn(), begin: vi.fn() })
}))
vi.mock('../desktop-adapter-deps', () => ({ createProductionDesktopAdapterDeps: () => ({}) }))
vi.mock('../desktop-adapters', () => ({
  executeDesktopAction: (...args: unknown[]) => state.execute(...args)
}))
vi.mock('../auth', () => ({ authSessionGeneration: () => state.generation }))
vi.mock('../qa-identity', () => ({ QA_IDENTITY_BUILD: false }))
vi.mock('../qa-voice-hooks', () => ({ qaDesktopSinkEnabled: vi.fn(() => false), createQaDesktopSink: vi.fn() }))
vi.mock('../secrets', () => ({ encryptSecret: vi.fn(), decryptSecret: vi.fn() }))
vi.mock('../infra/storage/atomic-saved-write', () => ({ atomicSavedWrite: vi.fn() }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  return { ...original, mkdir: vi.fn(async () => undefined), readFile: vi.fn(async () => '') }
})
vi.mock('../tasks/encrypted-task-file-store', () => ({
  createEncryptedTaskFileStore: () => ({
    read: async () =>
      state.serialized === null ? { kind: 'not-found' } : { kind: 'found', serialized: state.serialized },
    write: async (serialized: string) => {
      state.serialized = serialized
    },
    quarantine: async () => {
      state.serialized = null
    }
  })
}))

const NOTE: DesktopActionRequest = { id: 'desktop.create_note', args: { title: 'Synthetic lifecycle note' } }

function deferred<T = void>() {
  let complete!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    complete = done
  })
  return { promise, resolve: (value?: T | PromiseLike<T>) => complete(value as T) }
}

function eventHarness(runtime: CommandConfirmRuntime) {
  const handlers = new Map<string, (event: unknown, raw?: unknown) => unknown>()
  const send = vi.fn()
  const event = { sender: { id: 7 } }
  const dispose = registerTaskCardIpc(
    {
      handle: (channel: string, handler: (event: unknown, raw?: unknown) => unknown) => handlers.set(channel, handler)
    } as never,
    vi.fn(),
    runtime.taskCards,
    () => ({ isDestroyed: () => false, webContents: { id: 7, send } }) as never
  )
  return {
    dispose,
    send,
    list: () => handlers.get(TASK_CARD_IPC.list)?.(event) as unknown[],
    stop: (cardId: string) => handlers.get(TASK_CARD_IPC.stop)?.(event, { cardId }),
    dismiss: (cardId: string) => handlers.get(TASK_CARD_IPC.dismiss)?.(event, { cardId })
  }
}

beforeEach(() => {
  state.generation = 51
  state.serialized = null
  state.execute.mockReset()
  vi.resetModules()
})

describe('command-confirm runtime task owner composition', () => {
  it.each([
    'system_suspend',
    'screen_locked'
  ] as const)('preserves existing and late uncertain notices across %s while aborting active work', async (reason) => {
    const finishLate = deferred()
    let calls = 0
    let wasStarted = false
    let activeSignal: AbortSignal | undefined
    state.execute.mockImplementation(async (_request: DesktopActionRequest, options: { signal?: AbortSignal }) => {
      calls += 1
      if (calls === 1) throw new Error('synthetic prior uncertain effect')
      wasStarted = true
      activeSignal = options.signal
      await finishLate.promise
      throw new Error('synthetic late uncertain effect')
    })

    const { createCommandConfirmRuntime } = await import('./command-confirm-runtime')
    const runtime = createCommandConfirmRuntime({
      isAuthenticated: () => true,
      isRecordingMeeting: () => false,
      showForConfirm: vi.fn(),
      blurWindow: vi.fn()
    })
    const confirmation = new CommandConfirmation({
      ...runtime.deps,
      platform: 'darwin',
      minConfirmDelayMs: 0,
      isAuthenticated: () => true,
      hasListenEntitlement: () => true,
      getOwner: () => ({
        isDestroyed: () => false,
        isVisible: () => true,
        isFocused: () => true,
        webContents: { id: 7, send: vi.fn() }
      }),
      isOnboardingExclusive: () => false,
      audit: vi.fn()
    })
    confirmation.initialize({ on: vi.fn() }, vi.fn(), { warn: vi.fn(), error: vi.fn() })
    const ipc = eventHarness(runtime)
    let lateConfirming: Promise<unknown> | undefined

    try {
      const priorProposal = confirmation.propose({ webContentsId: 7, revision: 1 }, NOTE)
      await confirmation.confirm({ ...priorProposal, webContentsId: 7 })
      const priorCard = (ipc.list() as Array<{ cardId: string; phase: string }>)[0]!
      expect(priorCard.phase).toBe('uncertain')

      const lateProposal = confirmation.propose({ webContentsId: 7, revision: 1 }, NOTE)
      lateConfirming = confirmation.confirm({ ...lateProposal, webContentsId: 7 })
      await vi.waitFor(() => expect(wasStarted).toBe(true))
      const activeCard = (ipc.list() as Array<{ cardId: string; phase: string }>).find(
        ({ phase }) => phase === 'running'
      )!

      // Lock and suspend stop the live step but do not retire this authenticated window's reviewable notices.
      confirmation.revokeForLifecycleEvent(reason)
      expect(activeSignal?.aborted).toBe(true)
      expect(ipc.list()).toEqual([
        expect.objectContaining({ cardId: priorCard.cardId, phase: 'uncertain', dismissible: true }),
        expect.objectContaining({ cardId: activeCard.cardId, phase: 'stopping' })
      ])

      finishLate.resolve()
      await lateConfirming
      const notices = ipc.list() as Array<{ cardId: string; phase: string; dismissible: boolean }>
      expect(notices).toEqual([
        expect.objectContaining({ cardId: priorCard.cardId, phase: 'uncertain', dismissible: true }),
        expect.objectContaining({ cardId: activeCard.cardId, phase: 'uncertain', dismissible: true })
      ])
      expect(ipc.dismiss(priorCard.cardId)).toEqual({ ok: true })
      expect(ipc.dismiss(activeCard.cardId)).toEqual({ ok: true })
      expect(ipc.list()).toEqual([])
    } finally {
      finishLate.resolve()
      if (lateConfirming) await Promise.allSettled([lateConfirming])
      ipc.dispose()
      runtime.dispose()
    }
  })

  it.each([
    'generation-before-lifecycle',
    'generation-after-lifecycle'
  ] as const)('removes a stale same-window task card when auth changes %s', async (ordering) => {
    const finish = deferred()
    let wasStarted = false
    state.execute.mockImplementation(
      async (request: DesktopActionRequest, options: { envelope: ActionEnvelope; signal?: AbortSignal }) => {
        wasStarted = true
        await finish.promise
        if (options.signal?.aborted) return { id: request.id, ok: false, outcome: 'cancelled' }
        return {
          id: request.id,
          ok: true,
          outcome: 'verified',
          receipt: { ...options.envelope, observation: 'The synthetic note is visible in Notes' }
        } satisfies DesktopActionResult
      }
    )

    const { createCommandConfirmRuntime } = await import('./command-confirm-runtime')
    const runtime = createCommandConfirmRuntime({
      isAuthenticated: () => true,
      isRecordingMeeting: () => false,
      showForConfirm: vi.fn(),
      blurWindow: vi.fn()
    })
    const confirmation = new CommandConfirmation({
      ...runtime.deps,
      platform: 'darwin',
      minConfirmDelayMs: 0,
      isAuthenticated: () => true,
      hasListenEntitlement: () => true,
      getOwner: () => ({
        isDestroyed: () => false,
        isVisible: () => true,
        isFocused: () => true,
        webContents: { id: 7, send: vi.fn() }
      }),
      isOnboardingExclusive: () => false,
      audit: vi.fn()
    })
    confirmation.initialize({ on: vi.fn() }, vi.fn(), { warn: vi.fn(), error: vi.fn() })
    const ipc = eventHarness(runtime)
    let confirming: Promise<unknown> | undefined

    try {
      const proposal = confirmation.propose({ webContentsId: 7, revision: 1 }, NOTE)
      confirming = confirmation.confirm({ ...proposal, webContentsId: 7 })
      try {
        await vi.waitFor(() => expect(wasStarted).toBe(true))
      } catch (error) {
        let timeout: ReturnType<typeof setTimeout> | undefined
        const diagnosis = await Promise.race([
          confirming.then(
            (result) => JSON.stringify(result),
            (reason: unknown) => `rejected: ${String(reason)}`
          ),
          new Promise<string>((resolve) => {
            timeout = setTimeout(() => resolve('confirmation still pending'), 100)
          })
        ])
        if (timeout) clearTimeout(timeout)
        throw new Error(`task adapter did not start; confirmation outcome: ${diagnosis}; wait error: ${String(error)}`)
      }
      const oldCard = (ipc.list() as Array<{ cardId: string; phase: string }>)[0]!
      expect(oldCard.phase).toBe('running')

      if (ordering === 'generation-before-lifecycle') state.generation += 1
      confirmation.revokeForLifecycleEvent('auth_session_cleared')
      // Revocation must detach this projection even when the trusted generation has not advanced yet.
      const immediatelyAfterLifecycle = ipc.list()
      const lifecyclePush = ipc.send.mock.calls.at(-1)
      if (ordering === 'generation-after-lifecycle') state.generation += 1

      const afterGenerationChange = ipc.list()
      const staleStop = ipc.stop(oldCard.cardId)
      finish.resolve()
      await confirming
      const afterLateSettlement = ipc.list()
      const settlementPush = ipc.send.mock.calls.at(-1)

      expect(immediatelyAfterLifecycle).toEqual([])
      expect(lifecyclePush).toEqual([TASK_CARD_IPC.cards, []])
      expect(afterGenerationChange).toEqual([])
      expect(staleStop).toEqual({ ok: false })
      expect(afterLateSettlement).toEqual([])
      expect(settlementPush).toEqual([TASK_CARD_IPC.cards, []])
    } finally {
      finish.resolve()
      if (confirming) await Promise.allSettled([confirming])
      ipc.dispose()
      runtime.dispose()
    }
  })
})
