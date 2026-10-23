import { describe, expect, it, vi } from 'vitest'
import type { DesktopActionRequest, DesktopActionResult } from '@shared/desktop-actions'
import { actionEnvelope, type ActionEnvelope } from '../action-guard'
import type { CommandExecutionContext } from '../command-control'
import { DesktopActionTaskBridge, type DesktopActionTaskBridgeDeps } from './desktop-action-task-bridge'
import type { TaskStateStore } from './encrypted-task-file-store'
import type { TaskStateReadResult } from './task-persistence'

const NOTE: DesktopActionRequest = { id: 'desktop.create_note', args: { title: 'Synthetic late settlement' } }
const OWNER = { webContentsId: 7, revision: 3 }
const PRINCIPAL_A = { ownerKey: 'a'.repeat(64), tenantKey: 'b'.repeat(64) }
const PRINCIPAL_B = { ownerKey: 'c'.repeat(64), tenantKey: 'd'.repeat(64) }

class MemoryStore implements TaskStateStore {
  serialized: string | null = null
  async read(): Promise<TaskStateReadResult> {
    return this.serialized === null ? { kind: 'not-found' } : { kind: 'found', serialized: this.serialized }
  }
  async write(serialized: string): Promise<void> {
    this.serialized = serialized
  }
  async quarantine(): Promise<void> {
    this.serialized = null
  }
}

class MemoryAcks {
  ids: string[] = []
  reads = 0
  writes = 0
  readGate: ReturnType<typeof deferred<void>> | null = null
  readStarted: (() => void) | null = null

  async read(): Promise<readonly string[]> {
    this.reads += 1
    this.readStarted?.()
    this.readStarted = null
    const gate = this.readGate
    this.readGate = null
    if (gate) await gate.promise
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

function context(proposalId: string): CommandExecutionContext {
  return {
    proposalId,
    owner: OWNER,
    ...actionEnvelope(proposalId, NOTE),
    dependsOn: []
  }
}

function verified(request: DesktopActionRequest, envelope: ActionEnvelope): DesktopActionResult {
  return {
    id: request.id,
    ok: true,
    outcome: 'verified',
    receipt: { ...envelope, observation: 'Synthetic dispatch receipt' }
  }
}

function heldDispatch(
  proposalId: string,
  options: {
    generation?: () => number
    principal?: () => typeof PRINCIPAL_A | typeof PRINCIPAL_B | null
    store?: MemoryStore
    acknowledgements?: MemoryAcks
  } = {}
) {
  const adapter = deferred<DesktopActionResult>()
  void adapter.promise.catch(() => undefined)
  const store = options.store ?? new MemoryStore()
  const acknowledgements = options.acknowledgements ?? new MemoryAcks()
  let generation = 41
  let principal: typeof PRINCIPAL_A | typeof PRINCIPAL_B | null = PRINCIPAL_A
  let started = false
  let settled = false
  let dispatches = 0
  let bridge!: DesktopActionTaskBridge
  const execute = vi.fn(async () => {
    started = true
    dispatches += 1
    return adapter.promise
  })
  const deps: DesktopActionTaskBridgeDeps = {
    execute,
    store,
    acknowledgements,
    authSessionGeneration: options.generation ?? (() => generation),
    recoveryPrincipal: options.principal ?? (() => principal),
    newId: (() => {
      let id = 0
      return () => `settlement-${++id}`
    })(),
    newCardId: () => 'e'.repeat(32),
    now: () => 1_000_000
  }
  bridge = new DesktopActionTaskBridge(deps)
  const running = bridge.execute(NOTE, context(proposalId))
  void running.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    }
  )

  return {
    adapter,
    store,
    acknowledgements,
    bridge,
    execute,
    running,
    proposalId,
    taskId: `desktop-action:${proposalId}`,
    get generation() {
      return generation
    },
    set generation(value: number) {
      generation = value
    },
    get principal() {
      return principal
    },
    set principal(value: typeof PRINCIPAL_A | typeof PRINCIPAL_B | null) {
      principal = value
    },
    get started() {
      return started
    },
    get settled() {
      return settled
    },
    get dispatches() {
      return dispatches
    }
  }
}

async function waitForDispatch(fixture: ReturnType<typeof heldDispatch>): Promise<void> {
  await vi.waitFor(() => expect(fixture.started).toBe(true), { timeout: 1_000 })
  await vi.waitFor(() => expect(fixture.store.serialized).toContain('"status":"dispatching"'), { timeout: 1_000 })
}

async function drain(fixture: ReturnType<typeof heldDispatch>): Promise<void> {
  fixture.adapter.reject(new Error('synthetic cleanup settlement'))
  await vi.waitFor(() => expect(fixture.settled).toBe(true), { timeout: 2_000 })
  await Promise.allSettled([fixture.running])
}

async function restartA(fixture: ReturnType<typeof heldDispatch>): Promise<void> {
  const replay = vi.fn(async (request: DesktopActionRequest, envelope: ActionEnvelope) => verified(request, envelope))
  const restarted = new DesktopActionTaskBridge({
    execute: replay,
    store: fixture.store,
    acknowledgements: fixture.acknowledgements,
    authSessionGeneration: () => fixture.generation + 1,
    recoveryPrincipal: () => PRINCIPAL_A,
    now: () => 1_000_000
  })
  expect(await restarted.recover()).toMatchObject({ available: true, uncertain: 1 })
  const notices = await restarted.takeRecoveryNotices()
  expect(notices).toEqual([
    {
      taskId: fixture.taskId,
      actionId: NOTE.id,
      copy: "A voice action may not have finished: Create note. Métis won't retry it."
    }
  ])
  expect(await restarted.takeRecoveryNotices()).toEqual([])
  expect(fixture.acknowledgements.ids).toEqual([fixture.taskId])
  expect(replay).not.toHaveBeenCalled()
  expect(restarted.snapshot()).toMatchObject([{ status: 'uncertain', effectOutcome: 'uncertain' }])
}

describe('desktop task settlement delivery eligibility', () => {
  it.each([
    'window_closed',
    'window_replaced',
    'renderer_replaced',
    'auth_session_cleared'
  ] as const)('leaves late uncertain work recoverable after %s retires its captured card without changing auth generation', async (reason) => {
    const current = heldDispatch(`retire-${reason}`)
    try {
      await waitForDispatch(current)
      const card = current.bridge.cards('webContents:7')[0]
      expect(card).toMatchObject({ phase: 'running', stoppable: true })
      const generation = current.generation

      current.bridge.stop(reason)
      expect(current.generation).toBe(generation)
      expect(current.bridge.cards('webContents:7')).toEqual([])
      current.adapter.reject(new Error('synthetic late settlement after retirement'))
      await current.running

      expect(current.bridge.snapshot()).toMatchObject([{ status: 'uncertain', effectOutcome: 'uncertain' }])
      expect(current.acknowledgements.ids).toEqual([])
      expect(current.acknowledgements.writes).toBe(0)
      expect(current.dispatches).toBe(1)
      await restartA(current)
    } finally {
      await drain(current)
    }
  })

  it('does not auto-ack when only the auth generation drifts and the old card becomes hidden', async () => {
    const current = heldDispatch('generation-only-retirement')
    try {
      await waitForDispatch(current)
      expect(current.bridge.cards('webContents:7')).toMatchObject([{ phase: 'running' }])

      current.generation += 1
      expect(current.bridge.cards('webContents:7')).toEqual([])
      current.adapter.reject(new Error('synthetic late settlement after generation change'))
      await current.running

      expect(current.bridge.snapshot()).toMatchObject([{ status: 'uncertain', effectOutcome: 'uncertain' }])
      expect(current.acknowledgements.ids).toEqual([])
      expect(current.acknowledgements.writes).toBe(0)
      await restartA(current)
    } finally {
      await drain(current)
    }
  })

  it('rechecks the captured card after retirement during the acknowledgement read', async () => {
    const current = heldDispatch('retire-during-ack-read')
    const ackRead = deferred<void>()
    let readStarted = false
    current.acknowledgements.readGate = ackRead
    current.acknowledgements.readStarted = () => {
      readStarted = true
    }
    try {
      await waitForDispatch(current)
      current.adapter.reject(new Error('synthetic late settlement while ack read is held'))
      await vi.waitFor(() => expect(readStarted).toBe(true), { timeout: 1_000 })
      current.bridge.stop('renderer_replaced')
      expect(current.bridge.cards('webContents:7')).toEqual([])
      ackRead.resolve(undefined)
      await current.running

      expect(current.bridge.snapshot()).toMatchObject([{ status: 'uncertain', effectOutcome: 'uncertain' }])
      expect(current.acknowledgements.ids).toEqual([])
      expect(current.acknowledgements.writes).toBe(0)
      await restartA(current)
    } finally {
      ackRead.resolve(undefined)
      await drain(current)
    }
  })

  it.each([
    'ordinary_stop',
    'screen_locked',
    'system_suspend'
  ] as const)('preserves historic acknowledgement behavior after %s while the same card and generation remain current', async (reason) => {
    const current = heldDispatch(`keep-${reason}`)
    try {
      await waitForDispatch(current)
      const before = current.bridge.cards('webContents:7')
      expect(before).toMatchObject([{ phase: 'running', stoppable: true }])
      if (reason === 'ordinary_stop') current.bridge.stop()
      else current.bridge.stop(reason)
      expect(current.generation).toBe(41)
      expect(current.bridge.cards('webContents:7')).toMatchObject([{ phase: 'stopping' }])

      current.adapter.reject(new Error('synthetic late settlement after ordinary Stop'))
      await current.running

      expect(current.acknowledgements.ids).toEqual([current.taskId])
      expect(current.acknowledgements.writes).toBe(1)
      expect(current.dispatches).toBe(1)
      expect(current.bridge.snapshot()).toMatchObject([{ status: 'uncertain', effectOutcome: 'uncertain' }])
    } finally {
      await drain(current)
    }
  })

  it('fails closed when reading the live principal reentrantly retires the captured card', async () => {
    let bridge: DesktopActionTaskBridge | undefined
    let retireOnRead = false
    let reentrantRetirementRan = false
    const current = heldDispatch('principal-read-retires-card', {
      principal: () => {
        if (retireOnRead) {
          retireOnRead = false
          reentrantRetirementRan = true
          bridge?.stop('window_closed')
        }
        return PRINCIPAL_A
      }
    })
    bridge = current.bridge
    try {
      await waitForDispatch(current)
      retireOnRead = true
      current.adapter.reject(new Error('synthetic late settlement after reentrant retirement'))
      await current.running

      expect(reentrantRetirementRan).toBe(true)
      expect(current.bridge.cards('webContents:7')).toEqual([])
      expect(current.bridge.snapshot()).toMatchObject([{ status: 'uncertain', effectOutcome: 'uncertain' }])
      expect(current.acknowledgements.ids).toEqual([])
      expect(current.acknowledgements.writes).toBe(0)
      await restartA(current)
    } finally {
      await drain(current)
    }
  })

  it('rejects a duplicate proposal without a second dispatch or acknowledging the first owner under B', async () => {
    const current = heldDispatch('duplicate-settlement-foreign-owner')
    try {
      await waitForDispatch(current)
      current.principal = PRINCIPAL_B
      const duplicate = await current.bridge.execute(NOTE, context(current.proposalId))
      expect(duplicate).toMatchObject({ outcome: 'failed', detail: 'task_denied:queue_duplicate_job' })
      expect(current.dispatches).toBe(1)

      current.adapter.reject(new Error('synthetic late settlement after duplicate submit'))
      await current.running

      expect(current.bridge.snapshot()).toMatchObject([{ status: 'uncertain', effectOutcome: 'uncertain' }])
      expect(current.acknowledgements.ids).toEqual([])
      expect(current.acknowledgements.writes).toBe(0)
      expect(current.dispatches).toBe(1)
      await restartA(current)
    } finally {
      await drain(current)
    }
  })
})
