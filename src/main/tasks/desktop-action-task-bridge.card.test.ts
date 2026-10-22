import { describe, expect, it, vi } from 'vitest'
import type { DesktopActionRequest, DesktopActionResult } from '@shared/desktop-actions'
import { actionEnvelope, type ActionEnvelope } from '../action-guard'
import { CommandControl, type CommandExecutionContext } from '../command-control'
import { DesktopActionTaskBridge, type DesktopActionTaskBridgeDeps } from './desktop-action-task-bridge'
import type { TaskStateStore } from './encrypted-task-file-store'
import type { TaskStateReadResult } from './task-persistence'

const NOTE: DesktopActionRequest = { id: 'desktop.create_note', args: { title: 'Groceries' } }

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

function make(store: MemoryStore, acknowledgements: MemoryAcks, overrides: Partial<DesktopActionTaskBridgeDeps> = {}) {
  let id = 0
  const execute = vi.fn(
    async (request: DesktopActionRequest, envelope: ActionEnvelope): Promise<DesktopActionResult> => ({
      id: request.id,
      ok: true,
      outcome: 'verified',
      receipt: { ...envelope, observation: 'Notes shows the note' }
    })
  )
  const bridge = new DesktopActionTaskBridge({
    execute,
    store,
    acknowledgements,
    authSessionGeneration: () => 1,
    newId: () => `id-${(id += 1)}`,
    now: () => 1_000_000,
    ...overrides
  })
  return { bridge, execute }
}

const context = (proposalId: string): CommandExecutionContext => ({
  proposalId,
  owner: { webContentsId: 7, revision: 3 },
  ...actionEnvelope(proposalId, NOTE),
  dependsOn: []
})

describe('boot recovery of uncertain voice actions (surfaced once, never replayed)', () => {
  async function crashedStore(): Promise<MemoryStore> {
    const store = new MemoryStore()
    const first = make(store, new MemoryAcks(), { execute: () => new Promise<DesktopActionResult>(() => {}) })
    void first.bridge.execute(NOTE, context('crashed'))
    await vi.waitFor(() => expect(store.serialized).toContain('"status":"dispatching"'))
    return store
  }

  it('returns each recovered uncertain task once, with the action label and never the arguments', async () => {
    const store = await crashedStore()
    const acks = new MemoryAcks()
    const { bridge, execute } = make(store, acks)
    await bridge.recover()

    const notices = await bridge.takeRecoveryNotices()
    expect(notices).toEqual([
      {
        taskId: 'desktop-action:crashed',
        actionId: 'desktop.create_note',
        copy: "A voice action may not have finished: Create note. Métis won't retry it."
      }
    ])
    expect(JSON.stringify(notices)).not.toContain('Groceries')
    expect(await bridge.takeRecoveryNotices()).toEqual([])
    expect(execute).not.toHaveBeenCalled()
  })

  it('counts a notice as acknowledged across restarts', async () => {
    const store = await crashedStore()
    const acks = new MemoryAcks()
    const first = make(store, acks)
    await first.bridge.recover()
    expect(await first.bridge.takeRecoveryNotices()).toHaveLength(1)
    expect(acks.ids).toEqual(['desktop-action:crashed'])

    const second = make(store, acks)
    await second.bridge.recover()
    expect(await second.bridge.takeRecoveryNotices()).toEqual([])
  })

  it('returns nothing before recovery has run and nothing when the archive was unreadable', async () => {
    const store = await crashedStore()
    const { bridge } = make(store, new MemoryAcks())
    expect(await bridge.takeRecoveryNotices()).toEqual([])
  })

  it('does not re-announce an uncertain result the person already saw in this session', async () => {
    const store = new MemoryStore()
    const acks = new MemoryAcks()
    const { bridge } = make(store, acks, {
      execute: async () => {
        throw new Error('lost acknowledgement')
      }
    })
    await bridge.execute(NOTE, context('seen'))
    expect(await bridge.takeRecoveryNotices()).toEqual([])
  })
})

describe('preflight runs before the task is created', () => {
  const owner = { webContentsId: 7, revision: 3 }

  it('a denied automation produces no task, no durable write and no dispatch', async () => {
    const store = new MemoryStore()
    const { bridge, execute } = make(store, new MemoryAcks())
    const control = new CommandControl({
      execute: bridge.execute,
      policyAllows: () => true,
      platform: 'darwin',
      preflight: async () => ({
        ok: false,
        notice: { code: 'automation_denied', copy: "Métis isn't allowed to control Notes.", settingsKind: 'automation' }
      })
    })
    const proposal = control.propose(owner, NOTE)
    expect(await control.confirm({ ...proposal, webContentsId: 7 })).toEqual({ ok: false, reason: 'preflight_failed' })
    expect(bridge.snapshot()).toEqual([])
    expect(store.writes).toBe(0)
    expect(execute).not.toHaveBeenCalled()
  })

  it('a passing preflight leaves the existing path unchanged: one durable task, one dispatch', async () => {
    const store = new MemoryStore()
    const { bridge, execute } = make(store, new MemoryAcks())
    const control = new CommandControl({
      execute: bridge.execute,
      policyAllows: () => true,
      platform: 'darwin',
      preflight: async () => ({ ok: true })
    })
    const proposal = control.propose(owner, NOTE)
    expect(await control.confirm({ ...proposal, webContentsId: 7 })).toEqual({ ok: true, outcome: 'verified' })
    expect(bridge.snapshot()).toHaveLength(1)
    expect(execute).toHaveBeenCalledTimes(1)
  })
})
