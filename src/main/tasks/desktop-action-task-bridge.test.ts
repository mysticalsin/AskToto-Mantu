import { describe, expect, it, vi } from 'vitest'
import type { DesktopActionRequest, DesktopActionResult } from '@shared/desktop-actions'
import type { CommandExecutionContext } from '../command-control'
import {
  DesktopActionTaskBridge,
  desktopActionArgumentsDigest,
  type DesktopActionTaskBridgeDeps
} from './desktop-action-task-bridge'
import { TASK_STORE_DECRYPT_FAILED, type TaskStateStore } from './encrypted-task-file-store'
import type { TaskStateReadResult } from './task-persistence'

const NOTES: DesktopActionRequest = { id: 'desktop.open_notes', args: {} }
const verified = (id: DesktopActionRequest['id'] = 'desktop.open_notes'): DesktopActionResult => ({
  id,
  ok: true,
  outcome: 'verified'
})
const context = (proposalId: string, webContentsId = 7): CommandExecutionContext => ({
  proposalId,
  owner: { webContentsId, revision: 3 }
})

class MemoryStore implements TaskStateStore {
  serialized: string | null = null
  readOverride: TaskStateReadResult | null = null
  writeError: Error | null = null
  quarantined = 0
  writes = 0
  async read(): Promise<TaskStateReadResult> {
    if (this.readOverride) return this.readOverride
    return this.serialized === null ? { kind: 'not-found' } : { kind: 'found', serialized: this.serialized }
  }
  async write(serialized: string): Promise<void> {
    if (this.writeError) throw this.writeError
    this.writes += 1
    this.serialized = serialized
  }
  async quarantine(): Promise<void> {
    this.quarantined += 1
    this.serialized = null
  }
}

function make(overrides: Partial<DesktopActionTaskBridgeDeps> = {}, store = new MemoryStore()) {
  let id = 0
  const execute = vi.fn(async (_request: DesktopActionRequest) => verified())
  const audit = vi.fn()
  const bridge = new DesktopActionTaskBridge({
    execute,
    store,
    authSessionGeneration: () => 1,
    audit,
    newId: () => `id-${(id += 1)}`,
    now: () => 1_000_000,
    ...overrides
  })
  return { bridge, execute, audit, store }
}

describe('DesktopActionTaskBridge', () => {
  it('runs a confirmed action once as a task and records the verified effect', async () => {
    const { bridge, execute, store } = make()
    const result = await bridge.execute(NOTES, context('p1'))

    expect(result).toEqual(verified())
    expect(execute).toHaveBeenCalledTimes(1)
    expect(bridge.snapshot()).toEqual([
      { taskId: 'desktop-action:p1', actionId: 'desktop.open_notes', status: 'completed', effectOutcome: 'applied' }
    ])
    expect(store.serialized).toContain('"status":"completed"')
  })

  it('makes progress visible only while the dispatch is in flight', async () => {
    let release: () => void = () => {}
    const pending = new Promise<DesktopActionResult>((resolve) => {
      release = () => resolve(verified())
    })
    const { bridge } = make({ execute: () => pending })
    const run = bridge.execute(NOTES, context('p1'))
    await vi.waitFor(() => expect(bridge.snapshot()[0]?.status).toBe('dispatching'))
    expect(bridge.snapshot()[0]?.progress).toMatchObject({ label: 'dispatching', completedUnits: 0, totalUnits: 1 })

    release()
    await run
    expect(bridge.snapshot()[0]?.progress).toBeUndefined()
  })

  it('refuses a replayed confirmation of the same proposal without executing again', async () => {
    const { bridge, execute, audit } = make()
    await bridge.execute(NOTES, context('p1'))
    const replay = await bridge.execute(NOTES, context('p1'))

    expect(replay).toMatchObject({ ok: false, outcome: 'failed', detail: 'task_denied:duplicate_task' })
    expect(execute).toHaveBeenCalledTimes(1)
    expect(audit).toHaveBeenCalledWith('task.dispatch_denied', {
      actionId: 'desktop.open_notes',
      reason: 'duplicate_task'
    })
  })

  it('rejects an expired grant, cancels the task and does not dispatch', async () => {
    let clock = 0
    // Each clock read advances 11 s: issue and authorize land on opposite sides of the 10 s grant lifetime.
    const { bridge, execute } = make({ now: () => (clock += 11_000) })
    const result = await bridge.execute(NOTES, context('p1'))

    expect(result).toMatchObject({ ok: false, outcome: 'failed', detail: 'task_denied:grant_expired' })
    expect(execute).not.toHaveBeenCalled()
    expect(bridge.snapshot()[0]).toMatchObject({ status: 'cancelled' })
  })

  it('rejects a grant presented by a different owner generation and does not dispatch', async () => {
    let generation = 0
    const { bridge, execute } = make({ authSessionGeneration: () => (generation += 1) })
    const result = await bridge.execute(NOTES, context('p1'))

    expect(result).toMatchObject({ ok: false, outcome: 'failed', detail: 'task_denied:wrong_owner' })
    expect(execute).not.toHaveBeenCalled()
  })

  it('does not dispatch when the session changes after the dispatching state was made durable', async () => {
    const generations = [1, 1, 2]
    let calls = 0
    const { bridge, execute } = make({ authSessionGeneration: () => generations[Math.min(calls++, 2)]! })
    const result = await bridge.execute(NOTES, context('p1'))

    expect(result).toMatchObject({ ok: false, outcome: 'failed', detail: 'task_denied:wrong_owner' })
    expect(execute).not.toHaveBeenCalled()
    expect(bridge.snapshot()[0]).toMatchObject({ status: 'cancelled', effectOutcome: 'not-applied' })
  })

  it('records a dispatch that threw as uncertain, reports it unknown and never retries', async () => {
    const execute = vi.fn(async () => {
      throw new Error('lost acknowledgement after launch')
    })
    const { bridge, audit, store } = make({ execute })
    const result = await bridge.execute(NOTES, context('p1'))

    expect(result).toMatchObject({ id: 'desktop.open_notes', ok: false, outcome: 'unknown' })
    expect(bridge.snapshot()[0]).toMatchObject({ status: 'uncertain', effectOutcome: 'uncertain' })
    expect(audit).toHaveBeenCalledWith('task.effect_uncertain', {
      taskId: 'desktop-action:p1',
      actionId: 'desktop.open_notes'
    })
    expect(store.serialized).toContain('"status":"uncertain"')
    expect(await bridge.execute(NOTES, context('p1'))).toMatchObject({ detail: 'task_denied:duplicate_task' })
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('keeps an unknown adapter outcome and a mismatched result id uncertain', async () => {
    const unknown = make({ execute: async () => ({ id: 'desktop.open_notes', ok: true, outcome: 'unknown' }) })
    expect(await unknown.bridge.execute(NOTES, context('p1'))).toEqual({
      id: 'desktop.open_notes',
      ok: true,
      outcome: 'unknown'
    })
    expect(unknown.bridge.snapshot()[0]).toMatchObject({ status: 'uncertain' })

    const mismatched = make({ execute: async () => verified('desktop.open_arc') })
    expect(await mismatched.bridge.execute(NOTES, context('p1'))).toMatchObject({
      id: 'desktop.open_notes',
      ok: false,
      outcome: 'unknown'
    })
    expect(mismatched.bridge.snapshot()[0]).toMatchObject({ status: 'uncertain' })
  })

  it('records a clean adapter failure as not applied and closes the task', async () => {
    const { bridge } = make({ execute: async () => ({ id: 'desktop.open_notes', ok: false, outcome: 'failed' }) })
    expect(await bridge.execute(NOTES, context('p1'))).toMatchObject({ ok: false, outcome: 'failed' })
    expect(bridge.snapshot()[0]).toMatchObject({ status: 'cancelled', effectOutcome: 'not-applied' })
  })

  it('does not dispatch when the dispatching state cannot be made durable', async () => {
    const store = new MemoryStore()
    store.writeError = new Error('disk full')
    const { bridge, execute } = make({ log: { warn: vi.fn(), error: vi.fn() } }, store)
    const result = await bridge.execute(NOTES, context('p1'))

    expect(result).toMatchObject({ ok: false, outcome: 'failed', detail: 'task_denied:task_state_persist_failed' })
    expect(execute).not.toHaveBeenCalled()
  })

  it('never puts request arguments in audit metadata', async () => {
    const execute = vi.fn(async () => {
      throw new Error('boom')
    })
    const { bridge, audit } = make({ execute })
    await bridge.execute({ id: 'desktop.create_note', args: { title: 'private board notes' } }, context('p1'))

    expect(JSON.stringify(audit.mock.calls)).not.toContain('private board notes')
  })

  it('hashes the same request identically regardless of key order', () => {
    const a = desktopActionArgumentsDigest({ id: 'desktop.create_note', args: { title: 'x' } })
    const b = desktopActionArgumentsDigest(JSON.parse('{"args":{"title":"x"},"id":"desktop.create_note"}'))
    expect(a).toBe(b)
    expect(a).not.toBe(desktopActionArgumentsDigest({ id: 'desktop.create_note', args: { title: 'y' } }))
  })
})

describe('DesktopActionTaskBridge restart recovery', () => {
  it('recovers an interrupted dispatch as uncertain, reports it, and never replays it', async () => {
    const store = new MemoryStore()
    const first = make({ execute: () => new Promise<DesktopActionResult>(() => {}) }, store)
    void first.bridge.execute(NOTES, context('crashed'))
    await vi.waitFor(() => expect(store.serialized).toContain('"status":"dispatching"'))

    const log = { warn: vi.fn(), error: vi.fn() }
    const second = make({ log }, store)
    expect(await second.bridge.recover()).toEqual({ available: true, uncertain: 1 })
    expect(second.bridge.snapshot()).toEqual([
      {
        taskId: 'desktop-action:crashed',
        actionId: 'desktop.open_notes',
        status: 'uncertain',
        effectOutcome: 'uncertain'
      }
    ])
    expect(second.audit).toHaveBeenCalledWith('task.recovered', {
      taskId: 'desktop-action:crashed',
      actionId: 'desktop.open_notes',
      status: 'uncertain'
    })
    expect(log.warn).toHaveBeenCalled()
    expect(second.execute).not.toHaveBeenCalled()

    // The interrupted proposal cannot be confirmed again, and a fresh confirmation by the live owner does not revive it.
    expect(await second.bridge.execute(NOTES, context('crashed'))).toMatchObject({
      detail: 'task_denied:duplicate_task'
    })
    expect(second.execute).not.toHaveBeenCalled()
    expect(await second.bridge.execute(NOTES, context('fresh'))).toEqual(verified())
    expect(second.execute).toHaveBeenCalledTimes(1)
    const statuses = Object.fromEntries(second.bridge.snapshot().map((task) => [task.taskId, task.status]))
    expect(statuses).toEqual({ 'desktop-action:crashed': 'uncertain', 'desktop-action:fresh': 'completed' })
  })

  it('reloads a completed task from the encrypted archive and drops it after its retention', async () => {
    const store = new MemoryStore()
    await make({}, store).bridge.execute(NOTES, context('done'))

    const reloaded = make({}, store)
    await reloaded.bridge.recover()
    expect(reloaded.bridge.snapshot()).toHaveLength(1)

    const later = make({ now: () => 1_000_000 + 25 * 60 * 60 * 1000 }, store)
    await later.bridge.recover()
    expect(later.bridge.snapshot()).toEqual([])
  })

  it('starts fresh and keeps the bytes aside when the archive is corrupt', async () => {
    const store = new MemoryStore()
    store.serialized = '{not json'
    const { bridge, execute, audit } = make({ log: { warn: vi.fn(), error: vi.fn() } }, store)

    expect(await bridge.recover()).toEqual({ available: true, uncertain: 0 })
    expect(store.quarantined).toBe(1)
    expect(audit).toHaveBeenCalledWith('task.recovered', { status: 'quarantined', reason: 'invalid-json' })
    expect(await bridge.execute(NOTES, context('p1'))).toEqual(verified())
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('treats an archive that cannot be decrypted as corrupt and keeps it aside', async () => {
    const store = new MemoryStore()
    store.readOverride = { kind: 'unavailable', reason: TASK_STORE_DECRYPT_FAILED }
    const { bridge } = make({ log: { warn: vi.fn(), error: vi.fn() } }, store)

    expect(await bridge.recover()).toEqual({ available: true, uncertain: 0 })
    expect(store.quarantined).toBe(1)
  })

  it('keeps dispatch closed while the archive is unreadable and retries once it is readable', async () => {
    const store = new MemoryStore()
    store.readOverride = { kind: 'unavailable', reason: 'read-failed:EACCES' }
    const { bridge, execute } = make({ log: { warn: vi.fn(), error: vi.fn() } }, store)

    expect(await bridge.execute(NOTES, context('p1'))).toMatchObject({
      ok: false,
      outcome: 'failed',
      detail: 'task_denied:task_state_unavailable'
    })
    expect(execute).not.toHaveBeenCalled()
    expect(store.quarantined).toBe(0)

    store.readOverride = null
    expect(await bridge.execute(NOTES, context('p2'))).toEqual(verified())
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('fails the start of a task, not the process, when the archive read throws', async () => {
    const store = new MemoryStore()
    store.read = async () => {
      throw new Error('io exploded')
    }
    const { bridge, execute } = make({ log: { warn: vi.fn(), error: vi.fn() } }, store)
    expect(await bridge.execute(NOTES, context('p1'))).toMatchObject({ ok: false, outcome: 'failed' })
    expect(execute).not.toHaveBeenCalled()
  })
})
