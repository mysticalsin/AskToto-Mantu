import { describe, expect, it, vi } from 'vitest'
import type { DesktopActionRequest, DesktopActionResult } from '@shared/desktop-actions'
import { actionEnvelope, type ActionEnvelope } from '../action-guard'
import type { CommandExecutionContext } from '../command-control'
import { DesktopActionTaskBridge, type DesktopActionTaskBridgeDeps } from './desktop-action-task-bridge'
import type { TaskStateStore } from './encrypted-task-file-store'
import type { TaskStateReadResult } from './task-persistence'

const NOTE: DesktopActionRequest = { id: 'desktop.create_note', args: { title: 'Synthetic owner-bound note' } }
const OPEN: DesktopActionRequest = { id: 'desktop.open_notes', args: {} }
const OWNER = 'webContents:7'

class MemoryStore implements TaskStateStore {
  serialized: string | null = null
  readGate: Promise<void> | null = null
  readStarted: (() => void) | null = null

  async read(): Promise<TaskStateReadResult> {
    this.readStarted?.()
    await this.readGate
    return this.serialized === null ? { kind: 'not-found' } : { kind: 'found', serialized: this.serialized }
  }
  async write(serialized: string): Promise<void> {
    this.serialized = serialized
  }
  async quarantine(): Promise<void> {
    this.serialized = null
  }
}

function context(proposalId: string, request: DesktopActionRequest): CommandExecutionContext {
  return {
    proposalId,
    owner: { webContentsId: 7, revision: 1 },
    ...actionEnvelope(proposalId, request),
    dependsOn: []
  }
}

function verified(request: DesktopActionRequest, envelope: ActionEnvelope): DesktopActionResult {
  return {
    id: request.id,
    ok: true,
    outcome: 'verified',
    receipt: { ...envelope, observation: 'The synthetic action is visible in its app' }
  }
}

function deferred<T = void>() {
  let complete!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    complete = done
  })
  return { promise, resolve: (value?: T | PromiseLike<T>) => complete(value as T) }
}

function make(
  generation: () => number,
  overrides: Partial<Omit<DesktopActionTaskBridgeDeps, 'store'>> = {},
  store = new MemoryStore()
) {
  let task = 0
  let card = 0
  const execute = vi.fn(
    overrides.execute ??
      (async (request: DesktopActionRequest, envelope: ActionEnvelope) => verified(request, envelope))
  )
  const bridge = new DesktopActionTaskBridge({
    ...overrides,
    execute,
    store,
    authSessionGeneration: generation,
    newId: () => `task-${++task}`,
    newCardId: () => (++card).toString(16).padStart(32, '0'),
    now: () => 1_000_000
  })
  return { bridge, execute, store }
}

describe('desktop task owner generation', () => {
  it('hides old-generation cards and refuses their Stop after same-window auth changes', async () => {
    const hold = deferred()
    let generation = 4
    const { bridge, execute } = make(() => generation, {
      execute: async (request, envelope) => {
        await hold.promise
        return verified(request, envelope)
      }
    })
    let running: Promise<DesktopActionResult> | undefined
    try {
      running = bridge.execute(NOTE, context('owner-old-card', NOTE))
      await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce())
      const stale = bridge.cards(OWNER)[0]!
      expect(stale).toMatchObject({ phase: 'running', stoppable: true })

      generation += 1
      const currentCards = bridge.cards(OWNER)
      const staleStop = bridge.stopCard(OWNER, stale.cardId)
      expect(currentCards).toEqual([])
      expect(staleStop).toBe(false)
    } finally {
      hold.resolve()
      if (running) await Promise.allSettled([running])
    }
  })

  it('keeps a current-generation card live when a detached prior-generation task settles', async () => {
    const finishOld = deferred()
    const finishNew = deferred()
    let generation = 51
    const { bridge, execute } = make(() => generation, {
      execute: async (request, envelope) => {
        if (request.id === NOTE.id) await finishOld.promise
        else await finishNew.promise
        return verified(request, envelope)
      }
    })
    let oldRun: Promise<DesktopActionResult> | undefined
    let newRun: Promise<DesktopActionResult> | undefined
    try {
      oldRun = bridge.execute(NOTE, context('old-owner-late', NOTE))
      await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce())
      generation += 1
      bridge.stop('window_replaced')
      expect(bridge.cards(OWNER)).toEqual([])
      newRun = bridge.execute(OPEN, context('new-owner-live', OPEN))
      await vi.waitFor(() => expect(bridge.cards(OWNER)).toMatchObject([{ phase: 'queued', actionId: OPEN.id }]))

      finishOld.resolve()
      await oldRun
      await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2))
      await vi.waitFor(() => expect(bridge.cards(OWNER)).toMatchObject([{ phase: 'running', actionId: OPEN.id }]))
      const currentCard = bridge.cards(OWNER)[0]!
      expect(currentCard.stoppable).toBe(true)
      expect(bridge.stopCard(OWNER, currentCard.cardId)).toBe(true)
      expect(bridge.cards(OWNER)).toMatchObject([{ phase: 'stopping', actionId: OPEN.id }])
      finishNew.resolve()

      await newRun
      expect(bridge.cards(OWNER)).toMatchObject([{ phase: 'done', actionId: OPEN.id }])
    } finally {
      finishOld.resolve()
      finishNew.resolve()
      await Promise.allSettled([...(oldRun ? [oldRun] : []), ...(newRun ? [newRun] : [])])
    }
  })

  it('does not dispatch an old-generation job that waited in the real scheduler queue', async () => {
    const active = deferred()
    let generation = 11
    const { bridge, execute } = make(() => generation, {
      execute: async (request, envelope) => {
        if (request.id === NOTE.id) await active.promise
        return verified(request, envelope)
      }
    })
    const first = bridge.execute(NOTE, context('queue-owner-first', NOTE))
    let queued: Promise<DesktopActionResult> | undefined
    try {
      await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce())
      queued = bridge.execute(OPEN, context('queue-owner-old', OPEN))
      await vi.waitFor(() => expect(bridge.cards(OWNER).map(({ phase }) => phase)).toEqual(['running', 'queued']))

      // There is intentionally no Stop: admission must compare the generation captured when queued.
      generation += 1
      active.resolve()
      await Promise.all([first, queued])
      expect(execute).toHaveBeenCalledTimes(1)
    } finally {
      active.resolve()
      await Promise.allSettled([first, ...(queued ? [queued] : [])])
    }
  })

  it('does not adopt a new auth owner while the actual recovery-store read is held', async () => {
    const read = deferred()
    let generation = 21
    const store = new MemoryStore()
    store.readGate = read.promise
    let readHasStarted = false
    store.readStarted = () => {
      readHasStarted = true
    }
    const { bridge, execute } = make(() => generation, {}, store)
    let pending: Promise<DesktopActionResult> | undefined
    try {
      pending = bridge.execute(OPEN, context('recovery-owner-old', OPEN))
      await vi.waitFor(() => expect(readHasStarted).toBe(true))
      generation += 1
      read.resolve()
      await pending
      expect(execute).not.toHaveBeenCalled()
      const saved =
        store.serialized === null
          ? null
          : (JSON.parse(store.serialized) as { tasks: Array<{ owner: { authSessionGeneration: number } }> })
      expect(saved === null || saved.tasks.every((task) => task.owner.authSessionGeneration === 21)).toBe(true)
    } finally {
      read.resolve()
      if (pending) await Promise.allSettled([pending])
    }
  })

  it('keeps durable uncertainty while a detached old-generation execution settles without republishing its card', async () => {
    const settle = deferred()
    let generation = 31
    let wasDispatched = false
    const { bridge, execute, store } = make(() => generation, {
      execute: async () => {
        wasDispatched = true
        await settle.promise
        throw new Error('synthetic adapter settlement loss')
      }
    })
    // The adapter gate is released in finally even when a RED assertion fails.
    let pending: Promise<DesktopActionResult> | undefined
    try {
      pending = bridge.execute(NOTE, context('late-owner-settlement', NOTE))
      await vi.waitFor(() => expect(wasDispatched).toBe(true))
      expect(bridge.cards(OWNER)).toHaveLength(1)

      generation += 1
      settle.resolve()
      await pending

      expect(store.serialized).toContain('"status":"uncertain"')
      expect(bridge.cards(OWNER)).toEqual([])
      expect(execute).toHaveBeenCalledOnce()
    } finally {
      settle.resolve()
      if (pending) await Promise.allSettled([pending])
    }
  })

  it('does not allow Dismiss of a durable uncertain card from a retired generation', async () => {
    const settle = deferred()
    let generation = 41
    let wasDispatched = false
    const { bridge, store } = make(() => generation, {
      execute: async () => {
        wasDispatched = true
        await settle.promise
        throw new Error('synthetic uncertain effect')
      }
    })
    let pending: Promise<DesktopActionResult> | undefined
    try {
      pending = bridge.execute(NOTE, context('retired-uncertain-card', NOTE))
      await vi.waitFor(() => expect(wasDispatched).toBe(true))
      const oldCard = bridge.cards(OWNER)[0]!
      generation += 1
      settle.resolve()
      await pending

      const currentCards = bridge.cards(OWNER)
      const staleDismiss = bridge.dismissCard(OWNER, oldCard.cardId)
      expect(store.serialized).toContain('"status":"uncertain"')
      expect(currentCards).toEqual([])
      expect(staleDismiss).toBe(false)
    } finally {
      settle.resolve()
      if (pending) await Promise.allSettled([pending])
    }
  })
})
