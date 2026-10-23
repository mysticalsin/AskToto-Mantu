import { describe, expect, it, vi } from 'vitest'
import type { DesktopActionRequest, DesktopActionResult } from '@shared/desktop-actions'
import { actionEnvelope, type ActionEnvelope } from '../action-guard'
import type { CommandExecutionContext } from '../command-control'
import { DesktopActionTaskBridge, type DesktopActionTaskBridgeDeps } from './desktop-action-task-bridge'
import type { TaskStateStore } from './encrypted-task-file-store'
import type { TaskStateReadResult } from './task-persistence'

const NOTE: DesktopActionRequest = { id: 'desktop.create_note', args: { title: 'Synthetic recovery note' } }
const OWNER = { webContentsId: 7, revision: 3 }

type StableRecoveryPrincipal = Readonly<{ ownerKey: string; tenantKey: string }>

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
  beforeRead?: () => void
  beforeWrite?: () => void
  async read(): Promise<readonly string[]> {
    this.reads += 1
    this.beforeRead?.()
    return [...this.ids]
  }
  async write(ids: readonly string[]): Promise<void> {
    this.writes += 1
    this.beforeWrite?.()
    this.ids = [...ids]
  }
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
    receipt: { ...envelope, observation: 'Synthetic action is visible in its app' }
  }
}

function bridge(
  store: MemoryStore,
  acknowledgements: MemoryAcks,
  principal: StableRecoveryPrincipal | null | (() => StableRecoveryPrincipal | null),
  generation: number,
  execute: DesktopActionTaskBridgeDeps['execute'] = async (request, envelope) => verified(request, envelope)
): DesktopActionTaskBridge {
  const deps: DesktopActionTaskBridgeDeps & { recoveryPrincipal: () => StableRecoveryPrincipal | null } = {
    execute,
    store,
    acknowledgements,
    authSessionGeneration: () => generation,
    recoveryPrincipal: typeof principal === 'function' ? principal : () => principal,
    newId: (() => {
      let id = 0
      return () => `recovery-owner-${++id}`
    })(),
    now: () => 1_000_000
  }
  return new DesktopActionTaskBridge(deps)
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const PRINCIPAL_A = { ownerKey: 'a'.repeat(64), tenantKey: 'b'.repeat(64) } as const

async function crashSnapshot(proposalId: string): Promise<{ bytes: string; acknowledgements: string[] }> {
  const source = new MemoryStore()
  const sourceAcks = new MemoryAcks()
  const held = deferred<DesktopActionResult>()
  let executorStarted = false
  const first = bridge(source, sourceAcks, PRINCIPAL_A, 59, async () => {
    executorStarted = true
    return held.promise
  })
  const running = first.execute(NOTE, context(proposalId))
  let settled = false
  void running.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    }
  )
  let bytes = ''
  let acknowledgements: string[] = []
  try {
    await vi.waitFor(() => expect(executorStarted).toBe(true), { timeout: 1_000 })
    await vi.waitFor(() => expect(source.serialized).toContain('"status":"dispatching"'))
    first.stop('owner-reset')
    bytes = source.serialized ?? ''
    acknowledgements = [...sourceAcks.ids]
    expect(bytes).toContain('"status":"dispatching"')
    expect(acknowledgements).toEqual([])
  } finally {
    held.resolve(verified(NOTE, actionEnvelope(proposalId, NOTE)))
    await vi.waitFor(() => expect(settled).toBe(true), { timeout: 1_000 })
  }
  return { bytes, acknowledgements }
}

describe('desktop action durable recovery owner', () => {
  it('does not disclose or acknowledge a dispatching A task after Stop and restart under B', async () => {
    const source = new MemoryStore()
    const sourceAcks = new MemoryAcks()
    const lateExecutor = deferred<DesktopActionResult>()
    let executorStarted = false
    const first = bridge(source, sourceAcks, PRINCIPAL_A, 17, async () => {
      executorStarted = true
      return lateExecutor.promise
    })

    let running: Promise<DesktopActionResult> | undefined
    let settled = false
    let crashBytes: string | null = null
    let crashAcks: string[] = []
    try {
      running = first.execute(NOTE, context('crash-before-settlement'))
      void running.then(
        () => {
          settled = true
        },
        () => {
          settled = true
        }
      )
      await vi.waitFor(() => expect(executorStarted).toBe(true), { timeout: 1_000 })
      await vi.waitFor(() => expect(source.serialized).toContain('"status":"dispatching"'))

      first.stop('owner-reset')
      crashBytes = source.serialized
      crashAcks = [...sourceAcks.ids]
      expect(crashBytes).toContain('"status":"dispatching"')
      expect(crashAcks).toEqual([])
    } finally {
      lateExecutor.resolve(verified(NOTE, actionEnvelope('crash-before-settlement', NOTE)))
      if (running) await vi.waitFor(() => expect(settled).toBe(true), { timeout: 1_000 })
    }

    expect(crashBytes).not.toBeNull()
    const restartedStore = new MemoryStore()
    restartedStore.serialized = crashBytes
    const restartedAcks = new MemoryAcks()
    restartedAcks.ids = crashAcks
    const principalB = { ownerKey: 'c'.repeat(64), tenantKey: 'd'.repeat(64) }
    const replay = vi.fn(async (request: DesktopActionRequest, envelope: ActionEnvelope) => verified(request, envelope))
    const restarted = bridge(restartedStore, restartedAcks, principalB, 17, replay)

    expect(await restarted.recover()).toMatchObject({ available: true, uncertain: 1 })
    expect(await restarted.takeRecoveryNotices()).toEqual([])
    expect(restartedAcks.ids).toEqual([])
    expect(replay).not.toHaveBeenCalled()
    expect(restarted.snapshot()).toMatchObject([{ status: 'uncertain', effectOutcome: 'uncertain' }])
  })

  it('discloses once for the same stable owner across a new process generation and never replays', async () => {
    const store = new MemoryStore()
    const acks = new MemoryAcks()
    const lateExecutor = deferred<DesktopActionResult>()
    let executorStarted = false
    const first = bridge(store, acks, PRINCIPAL_A, 31, async () => {
      executorStarted = true
      return lateExecutor.promise
    })
    let running: Promise<DesktopActionResult> | undefined
    let settled = false
    let crashBytes: string | null = null
    let crashAcks: string[] = []
    try {
      running = first.execute(NOTE, context('same-owner-restart'))
      void running.then(
        () => {
          settled = true
        },
        () => {
          settled = true
        }
      )
      await vi.waitFor(() => expect(executorStarted).toBe(true), { timeout: 1_000 })
      await vi.waitFor(() => expect(store.serialized).toContain('"status":"dispatching"'))
      first.stop('simulated-process-exit')
      crashBytes = store.serialized
      crashAcks = [...acks.ids]
      expect(crashBytes).toContain('"status":"dispatching"')
      expect(crashAcks).toEqual([])
    } finally {
      lateExecutor.resolve(verified(NOTE, actionEnvelope('same-owner-restart', NOTE)))
      if (running) await vi.waitFor(() => expect(settled).toBe(true), { timeout: 1_000 })
    }
    // The old executor drains only against the original store, after the crash snapshot was captured.
    const restartedStore = new MemoryStore()
    restartedStore.serialized = crashBytes
    const restartedAcks = new MemoryAcks()
    restartedAcks.ids = crashAcks
    const replay = vi.fn(async (request: DesktopActionRequest, envelope: ActionEnvelope) => verified(request, envelope))
    const restarted = bridge(restartedStore, restartedAcks, PRINCIPAL_A, 32, replay)
    expect(await restarted.recover()).toMatchObject({ available: true, uncertain: 1 })
    const notices = await restarted.takeRecoveryNotices()
    expect(notices).toHaveLength(1)
    expect(await restarted.takeRecoveryNotices()).toEqual([])
    expect(restartedAcks.ids).toEqual(['desktop-action:same-owner-restart'])
    expect(replay).not.toHaveBeenCalled()
    expect(restarted.snapshot()).toMatchObject([{ status: 'uncertain', effectOutcome: 'uncertain' }])
  })

  it.each([
    ['owner key differs', { ownerKey: 'c'.repeat(64), tenantKey: PRINCIPAL_A.tenantKey }],
    ['tenant key differs', { ownerKey: PRINCIPAL_A.ownerKey, tenantKey: 'd'.repeat(64) }],
    ['principal unavailable', null]
  ])('withholds notice and acknowledgement when %s', async (_caseName, principal) => {
    const snapshot = await crashSnapshot(`principal-filter-${_caseName}`)
    const store = new MemoryStore()
    store.serialized = snapshot.bytes
    const acks = new MemoryAcks()
    const restarted = bridge(store, acks, principal, 59)
    await restarted.recover()

    expect(await restarted.takeRecoveryNotices()).toEqual([])
    expect(acks.ids).toEqual([])
    expect(acks.writes).toBe(0)
    expect(restarted.snapshot()).toMatchObject([{ effectOutcome: 'uncertain' }])
  })

  it('retains legacy unattributed uncertainty without disclosing or auto-acknowledging it', async () => {
    const snapshot = await crashSnapshot('legacy-unattributed')
    const archive = JSON.parse(snapshot.bytes) as { version: number; tasks: Array<Record<string, unknown>> }
    archive.version = 2
    delete archive.tasks[0]?.recoveryOwner
    const store = new MemoryStore()
    store.serialized = JSON.stringify(archive)
    const acks = new MemoryAcks()
    const restarted = bridge(store, acks, PRINCIPAL_A, 59)
    expect(await restarted.recover()).toMatchObject({ available: true, uncertain: 1 })

    expect(await restarted.takeRecoveryNotices()).toEqual([])
    expect(acks.writes).toBe(0)
    expect(acks.ids).toEqual([])
    expect(restarted.snapshot()).toMatchObject([{ effectOutcome: 'uncertain' }])
  })

  it('abandons notice and ack before writing when the owner changes during ack read', async () => {
    const snapshot = await crashSnapshot('owner-change-during-read')
    const store = new MemoryStore()
    store.serialized = snapshot.bytes
    let current = PRINCIPAL_A
    const acks = new MemoryAcks()
    acks.beforeRead = () => {
      current = { ownerKey: 'c'.repeat(64), tenantKey: 'd'.repeat(64) }
    }
    const restarted = bridge(store, acks, () => current, 59)
    await restarted.recover()

    expect(await restarted.takeRecoveryNotices()).toEqual([])
    expect(acks.writes).toBe(0)
    expect(acks.ids).toEqual([])
  })

  it('withholds delivery if the owner changes during the dispatched ack write', async () => {
    const snapshot = await crashSnapshot('owner-change-during-write')
    const store = new MemoryStore()
    store.serialized = snapshot.bytes
    let current = PRINCIPAL_A
    const acks = new MemoryAcks()
    acks.beforeWrite = () => {
      current = { ownerKey: 'c'.repeat(64), tenantKey: 'd'.repeat(64) }
    }
    const restarted = bridge(store, acks, () => current, 59)
    await restarted.recover()

    expect(await restarted.takeRecoveryNotices()).toEqual([])
    // The storage write was already dispatched when this owner change happened; the bridge cannot undo it.
    expect(acks.writes).toBe(1)
    expect(acks.ids).toEqual(['desktop-action:owner-change-during-write'])
  })

  it('does not rebind a queued command to the owner present when its executor eventually starts', async () => {
    const store = new MemoryStore()
    const holdFirst = deferred<DesktopActionResult>()
    let current = PRINCIPAL_A
    let firstStarted = false
    let calls = 0
    let firstSettled = false
    let secondSettled = false
    let first: Promise<DesktopActionResult> | undefined
    let second: Promise<DesktopActionResult> | undefined
    const firstEnvelope = actionEnvelope('queue-principal-first', NOTE)
    const secondEnvelope = actionEnvelope('queue-principal-second', NOTE)
    const queuedBridge = bridge(
      store,
      new MemoryAcks(),
      () => current,
      61,
      async (request, envelope) => {
        calls += 1
        if (calls === 1) {
          firstStarted = true
          return holdFirst.promise
        }
        return verified(request, envelope)
      }
    )
    try {
      first = queuedBridge.execute(NOTE, { ...context('queue-principal-first'), ...firstEnvelope })
      void first.then(
        () => {
          firstSettled = true
        },
        () => {
          firstSettled = true
        }
      )
      await vi.waitFor(() => expect(firstStarted).toBe(true), { timeout: 1_000 })
      second = queuedBridge.execute(NOTE, { ...context('queue-principal-second'), ...secondEnvelope })
      void second.then(
        () => {
          secondSettled = true
        },
        () => {
          secondSettled = true
        }
      )
      await vi.waitFor(() => expect(queuedBridge.cards('webContents:7')).toHaveLength(2), { timeout: 1_000 })
      current = { ownerKey: 'c'.repeat(64), tenantKey: 'd'.repeat(64) }
      holdFirst.resolve(verified(NOTE, firstEnvelope))
      await Promise.all([first, second])

      const records = JSON.parse(store.serialized ?? '{}').tasks as Array<{ taskId: string; recoveryOwner?: unknown }>
      expect(records.find((record) => record.taskId === 'desktop-action:queue-principal-first')?.recoveryOwner).toEqual(
        PRINCIPAL_A
      )
      expect(
        records.find((record) => record.taskId === 'desktop-action:queue-principal-second')?.recoveryOwner
      ).toBeUndefined()
    } finally {
      holdFirst.resolve(verified(NOTE, firstEnvelope))
      if (first !== undefined) {
        await vi.waitFor(() => expect(firstSettled && (second === undefined || secondSettled)).toBe(true), {
          timeout: 1_000
        })
      }
      await Promise.allSettled([first, ...(second === undefined ? [] : [second])])
    }
  })

  it('keeps the existing settled-uncertain acknowledgement behavior as a control', async () => {
    const store = new MemoryStore()
    const acks = new MemoryAcks()
    const first = bridge(store, acks, PRINCIPAL_A, 41, async () => {
      throw new Error('synthetic lost acknowledgement')
    })
    const result = await first.execute(NOTE, context('settled-uncertain-control'))
    expect(result).toMatchObject({ outcome: 'unknown' })
    expect(acks.ids).toEqual(['desktop-action:settled-uncertain-control'])
    expect(await first.takeRecoveryNotices()).toEqual([])
  })
})
