import { describe, expect, it, vi } from 'vitest'
import type { DesktopActionRequest, DesktopActionResult } from '@shared/desktop-actions'
import type { CommandExecutionContext } from '../command-control'
import { actionEnvelope, type ActionEnvelope } from '../action-guard'
import {
  DesktopActionTaskBridge,
  desktopActionArgumentsDigest,
  type DesktopActionTaskBridgeDeps
} from './desktop-action-task-bridge'
import {
  DESKTOP_ACTION_TASK_CODEC_LIMITS,
  DESKTOP_ACTION_TASK_POLICY,
  desktopActionResources
} from './desktop-action-task-bridge'
import { createTask, createTaskRuntimeState, pauseTaskForQuota } from './task-state'
import { encodeTaskRuntimeState } from './task-persistence'
import { TASK_STORE_DECRYPT_FAILED, type TaskStateStore } from './encrypted-task-file-store'
import type { TaskStateReadResult } from './task-persistence'

const NOTES: DesktopActionRequest = { id: 'desktop.open_notes', args: {} }
const envelopeFor = (proposalId: string, request: DesktopActionRequest = NOTES): ActionEnvelope =>
  actionEnvelope(proposalId, request)
/** The observed-receipt rule: a verified result carries readback bound to the dispatch it answers. */
const verified = (
  id: DesktopActionRequest['id'] = 'desktop.open_notes',
  envelope?: ActionEnvelope
): DesktopActionResult => ({
  id,
  ok: true,
  outcome: 'verified',
  ...(envelope ? { receipt: { ...envelope, observation: 'The action is visible in its app' } } : {})
})
const verifiedFor = (proposalId: string, request: DesktopActionRequest = NOTES): DesktopActionResult =>
  verified(request.id, envelopeFor(proposalId, request))
const context = (
  proposalId: string,
  webContentsId = 7,
  request: DesktopActionRequest = NOTES,
  dependsOn: string[] = []
): CommandExecutionContext => ({
  proposalId,
  owner: { webContentsId, revision: 3 },
  ...envelopeFor(proposalId, request),
  dependsOn
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
  const execute = vi.fn(async (request: DesktopActionRequest, envelope: ActionEnvelope) =>
    verified(request.id, envelope)
  )
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

    expect(result).toEqual(verifiedFor('p1'))
    expect(execute).toHaveBeenCalledTimes(1)
    expect(bridge.snapshot()).toEqual([
      { taskId: 'desktop-action:p1', actionId: 'desktop.open_notes', status: 'completed', effectOutcome: 'applied' }
    ])
    expect(store.serialized).toContain('"status":"completed"')
  })

  it('makes progress visible only while the dispatch is in flight', async () => {
    let release: () => void = () => {}
    const pending = new Promise<DesktopActionResult>((resolve) => {
      release = () => resolve(verifiedFor('p1'))
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
    const note: DesktopActionRequest = { id: 'desktop.create_note', args: { title: 'private board notes' } }
    await bridge.execute(note, context('p1', 7, note))

    expect(JSON.stringify(audit.mock.calls)).not.toContain('private board notes')
  })

  it('hashes the same request identically regardless of key order', () => {
    const a = desktopActionArgumentsDigest({ id: 'desktop.create_note', args: { title: 'x' } })
    const b = desktopActionArgumentsDigest(JSON.parse('{"args":{"title":"x"},"id":"desktop.create_note"}'))
    expect(a).toBe(b)
    expect(a).not.toBe(desktopActionArgumentsDigest({ id: 'desktop.create_note', args: { title: 'y' } }))
  })
})

describe('DesktopActionTaskBridge ActionGuard (G04)', () => {
  it('hands the adapter the same args hash and idempotency key the confirmation carried', async () => {
    const { bridge, execute } = make()
    await bridge.execute(NOTES, context('p1'))
    expect(execute).toHaveBeenCalledWith(NOTES, envelopeFor('p1'), expect.any(AbortSignal))
    expect(envelopeFor('p1').idempotencyKey).not.toBe(envelopeFor('p2').idempotencyKey)
  })

  it.each([
    ['a changed args hash', (c: CommandExecutionContext) => ({ ...c, argsHash: 'e'.repeat(64) })],
    ['a foreign idempotency key', (c: CommandExecutionContext) => ({ ...c, idempotencyKey: 'e'.repeat(64) })]
  ])('denies a dispatch with %s before any task or effect exists', async (_name, tamper) => {
    const { bridge, execute, audit } = make()
    const result = await bridge.execute(NOTES, tamper(context('p1')))
    expect(result).toMatchObject({ ok: false, outcome: 'failed', detail: 'task_denied:arguments_changed' })
    expect(execute).not.toHaveBeenCalled()
    expect(bridge.snapshot()).toEqual([])
    expect(audit).toHaveBeenCalledWith('task.dispatch_denied', {
      actionId: 'desktop.open_notes',
      reason: 'arguments_changed'
    })
  })

  it('denies an args hash computed for a different request than the one being dispatched', async () => {
    const { bridge, execute } = make()
    const other: DesktopActionRequest = { id: 'desktop.create_note', args: { title: 'x' } }
    const result = await bridge.execute(NOTES, context('p1', 7, other))
    expect(result).toMatchObject({ detail: 'task_denied:arguments_changed' })
    expect(execute).not.toHaveBeenCalled()
  })

  it('keeps a verified result without a bound receipt uncertain, reports it unknown and never replays it', async () => {
    const execute = vi.fn(async () => verified())
    const { bridge, audit } = make({ execute })
    const result = await bridge.execute(NOTES, context('p1'))

    expect(result).toMatchObject({
      id: 'desktop.open_notes',
      ok: false,
      outcome: 'unknown',
      detail: 'outcome_unverified'
    })
    expect(bridge.snapshot()[0]).toMatchObject({ status: 'uncertain', effectOutcome: 'uncertain' })
    expect(audit).toHaveBeenCalledWith('task.effect_uncertain', {
      taskId: 'desktop-action:p1',
      actionId: 'desktop.open_notes'
    })
    expect(await bridge.execute(NOTES, context('p1'))).toMatchObject({ detail: 'task_denied:duplicate_task' })
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['another dispatch key', (e: ActionEnvelope) => ({ ...e, idempotencyKey: 'f'.repeat(64) })],
    ['other arguments', (e: ActionEnvelope) => ({ ...e, argsHash: 'f'.repeat(64) })]
  ])('keeps a receipt bound to %s uncertain', async (_name, forge) => {
    const { bridge } = make({ execute: async (request, envelope) => verified(request.id, forge(envelope)) })
    expect(await bridge.execute(NOTES, context('p1'))).toMatchObject({ outcome: 'unknown' })
    expect(bridge.snapshot()[0]).toMatchObject({ status: 'uncertain', effectOutcome: 'uncertain' })
  })

  it('keeps a verified result with an empty observation uncertain', async () => {
    const { bridge } = make({
      execute: async (request, envelope) => ({
        ...verified(request.id, envelope),
        receipt: { ...envelope, observation: ' ' }
      })
    })
    expect(await bridge.execute(NOTES, context('p1'))).toMatchObject({ outcome: 'unknown' })
    expect(bridge.snapshot()[0]).toMatchObject({ effectOutcome: 'uncertain' })
  })

  describe('dependsOn', () => {
    it('refuses an action whose dependency was never run, without creating a task or dispatching', async () => {
      const { bridge, execute, audit } = make()
      const result = await bridge.execute(NOTES, context('child', 7, NOTES, ['parent']))
      expect(result).toMatchObject({ ok: false, outcome: 'failed', detail: 'task_denied:dependency_not_verified' })
      expect(execute).not.toHaveBeenCalled()
      expect(bridge.snapshot()).toEqual([])
      expect(audit).toHaveBeenCalledWith('task.dispatch_denied', {
        actionId: 'desktop.open_notes',
        reason: 'dependency_not_verified'
      })
    })

    it('unlocks the dependent action once its dependency was verified by an observed receipt', async () => {
      const { bridge, execute } = make()
      await bridge.execute(NOTES, context('parent'))
      expect(await bridge.execute(NOTES, context('child', 7, NOTES, ['parent']))).toEqual(verifiedFor('child'))
      expect(execute).toHaveBeenCalledTimes(2)
    })

    it('stays blocked behind an uncertain dependency, and the dependency is never replayed', async () => {
      let first = true
      const execute = vi.fn(async (request: DesktopActionRequest, envelope: ActionEnvelope) => {
        if (first) {
          first = false
          return { id: request.id, ok: false, outcome: 'unknown' as const }
        }
        return verified(request.id, envelope)
      })
      const { bridge } = make({ execute })
      await bridge.execute(NOTES, context('parent'))
      expect(await bridge.execute(NOTES, context('child', 7, NOTES, ['parent']))).toMatchObject({
        detail: 'task_denied:dependency_not_verified'
      })
      expect(await bridge.execute(NOTES, context('parent'))).toMatchObject({ detail: 'task_denied:duplicate_task' })
      expect(execute).toHaveBeenCalledTimes(1)
    })

    it('stays blocked behind a dependency that failed without effect', async () => {
      const failing = make({ execute: async () => ({ id: 'desktop.open_notes', ok: false, outcome: 'failed' }) })
      await failing.bridge.execute(NOTES, context('parent'))
      expect(await failing.bridge.execute(NOTES, context('child', 7, NOTES, ['parent']))).toMatchObject({
        detail: 'task_denied:dependency_not_verified'
      })
    })

    it('requires every dependency, and a verified dependency survives a restart', async () => {
      const store = new MemoryStore()
      await make({}, store).bridge.execute(NOTES, context('a'))
      let id = 100
      const second = make({ newId: () => `later-${(id += 1)}` }, store)
      expect(await second.bridge.execute(NOTES, context('c', 7, NOTES, ['a', 'b']))).toMatchObject({
        detail: 'task_denied:dependency_not_verified'
      })
      await second.bridge.execute(NOTES, context('b'))
      expect(await second.bridge.execute(NOTES, context('c', 7, NOTES, ['a', 'b']))).toEqual(verifiedFor('c'))
    })
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
    expect(await second.bridge.execute(NOTES, context('fresh'))).toEqual(verifiedFor('fresh'))
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
    expect(await bridge.execute(NOTES, context('p1'))).toEqual(verifiedFor('p1'))
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
    expect(await bridge.execute(NOTES, context('p2'))).toEqual(verifiedFor('p2'))
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

function deferred() {
  let release!: (value: DesktopActionResult) => void
  const promise = new Promise<DesktopActionResult>((resolve) => {
    release = resolve
  })
  return { promise, release }
}
const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve()
}
const OPEN_ARC: DesktopActionRequest = { id: 'desktop.open_arc', args: {} }
const CREATE_NOTE: DesktopActionRequest = { id: 'desktop.create_note', args: { title: 'a' } }

describe('DesktopActionTaskBridge scheduling (G32)', () => {
  it('names the app each action acts on', () => {
    expect(desktopActionResources(NOTES)).toEqual(['app:notes'])
    expect(desktopActionResources(CREATE_NOTE)).toEqual(['app:notes'])
    expect(desktopActionResources({ id: 'desktop.google_search', args: { q: 'x', browser: 'arc' } })).toEqual([
      'app:arc'
    ])
  })

  it('runs one desktop effect per owner at a time, in arrival order', async () => {
    const gates = [deferred(), deferred()]
    const started: string[] = []
    const { bridge } = make({
      execute: async (request, envelope) => {
        started.push(request.id)
        const gate = gates[started.length - 1]!
        await gate.promise
        return verified(request.id, envelope)
      }
    })
    const first = bridge.execute(NOTES, context('p1'))
    const second = bridge.execute(OPEN_ARC, context('p2', 7, OPEN_ARC))
    await flush()
    expect(started).toEqual(['desktop.open_notes'])
    gates[0]!.release(verifiedFor('p1'))
    await flush()
    expect(started).toEqual(['desktop.open_notes', 'desktop.open_arc'])
    gates[1]!.release(verifiedFor('p2', OPEN_ARC))
    expect((await first).outcome).toBe('verified')
    expect((await second).outcome).toBe('verified')
  })

  it('never lets two owners act on the same app at once, but lets different apps overlap', async () => {
    const gate = deferred()
    const started: string[] = []
    const { bridge } = make({
      execute: async (request, envelope) => {
        started.push(`${request.id}`)
        await gate.promise
        return verified(request.id, envelope)
      }
    })
    void bridge.execute(NOTES, context('p1', 7))
    void bridge.execute(CREATE_NOTE, context('p2', 8, CREATE_NOTE))
    void bridge.execute(OPEN_ARC, context('p3', 9, OPEN_ARC))
    await flush()
    expect(started).toEqual(['desktop.open_notes', 'desktop.open_arc'])
    gate.release(verified())
    await flush()
    expect(started).toContain('desktop.create_note')
  })

  it('Stop cancels queued work unrun, aborts the running lease, and still classifies the running effect by receipt', async () => {
    const gate = deferred()
    const signals: AbortSignal[] = []
    const { bridge, execute } = make({
      execute: async (request, envelope, signal) => {
        if (signal) signals.push(signal)
        await gate.promise
        return verified(request.id, envelope)
      }
    })
    const running = bridge.execute(NOTES, context('p1'))
    const queued = bridge.execute(OPEN_ARC, context('p2', 7, OPEN_ARC))
    await flush()
    bridge.stop()
    expect(signals[0]?.aborted).toBe(true)
    expect(await queued).toMatchObject({ ok: false, outcome: 'cancelled', detail: 'stopped' })
    gate.release(verifiedFor('p1'))
    expect(await running).toEqual(verifiedFor('p1'))
    expect(execute).not.toHaveBeenCalledWith(OPEN_ARC, expect.anything(), expect.anything())
    expect(bridge.snapshot().find((task) => task.taskId === 'desktop-action:p1')).toMatchObject({
      effectOutcome: 'applied'
    })
  })

  it('refuses to retry a proposal whose effect was applied or may have happened', async () => {
    const execute = vi.fn(async (request: DesktopActionRequest, envelope: ActionEnvelope) => {
      if (request.id === 'desktop.open_arc') throw new Error('lost')
      return verified(request.id, envelope)
    })
    const { bridge } = make({ execute })
    expect((await bridge.execute(NOTES, context('p1'))).outcome).toBe('verified')
    expect(await bridge.execute(NOTES, context('p1'))).toMatchObject({ detail: 'task_denied:duplicate_task' })
    expect((await bridge.execute(OPEN_ARC, context('p2', 7, OPEN_ARC))).outcome).toBe('unknown')
    expect(await bridge.execute(OPEN_ARC, context('p2', 7, OPEN_ARC))).toMatchObject({
      ok: false,
      outcome: 'failed',
      detail: 'task_denied:duplicate_task'
    })
    // Nothing was dispatched by the retry; the first dispatch stays recorded as uncertain.
    expect(bridge.snapshot().find((task) => task.taskId === 'desktop-action:p2')).toMatchObject({
      effectOutcome: 'uncertain'
    })
    expect(execute).toHaveBeenCalledTimes(2)
  })

  it('holds a steer until the step settles, then hands it to G06 steerTask exactly once and never revives a finished task', async () => {
    const gate = deferred()
    const log = { warn: vi.fn(), error: vi.fn() }
    const { bridge } = make({
      log,
      execute: async (request, envelope) => {
        await gate.promise
        return verified(request.id, envelope)
      }
    })
    const running = bridge.execute(NOTES, context('p1'))
    await flush()
    const steer = { steerId: 's1', taskId: 'desktop-action:p1', revision: 2, argumentsDigest: 'd2' }
    expect(await bridge.steer(steer)).toEqual({ ok: true })
    expect(bridge.snapshot()[0]?.status).toBe('dispatching')
    gate.release(verifiedFor('p1'))
    await running
    // A one-shot desktop task is finished once its step settles, so G06 refuses the steer: nothing is revived.
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('invalid_transition'))
    expect(bridge.snapshot()[0]?.status).toBe('completed')
    expect(await bridge.steer({ ...steer, revision: 3 })).toEqual({ ok: false, reason: 'invalid_transition' })
  })

  it('Stop drops a steer that was waiting for the boundary', async () => {
    const gate = deferred()
    const { bridge } = make({
      execute: async (request, envelope) => {
        await gate.promise
        return verified(request.id, envelope)
      }
    })
    const running = bridge.execute(NOTES, context('p1'))
    await flush()
    await bridge.steer({ steerId: 's1', taskId: 'desktop-action:p1', revision: 2, argumentsDigest: 'd2' })
    bridge.stop()
    gate.release(verifiedFor('p1'))
    await running
    expect(bridge.snapshot()[0]?.status).not.toBe('planning')
  })

  it('cancels planning and quota-paused tasks on restart', async () => {
    const owner = { webContentsId: 7, frameId: 'main', isTopFrame: true, authSessionGeneration: 1, contextRevision: 3 }
    const base = {
      revision: 1,
      taskType: 'desktop-action',
      owner,
      argumentsDigest: 'd',
      scope: { capabilities: ['desktop.open_notes'], resources: { actions: 1 } },
      createdAt: 1_000_000,
      retentionMs: 60_000
    }
    let state = createTaskRuntimeState()
    const a = createTask(state, { ...base, taskId: 'desktop-action:plan' }, DESKTOP_ACTION_TASK_POLICY, {
      initialStatus: 'planning'
    })
    if (!a.ok) throw new Error(a.reason)
    const b = createTask(a.state, { ...base, taskId: 'desktop-action:quota' }, DESKTOP_ACTION_TASK_POLICY)
    if (!b.ok) throw new Error(b.reason)
    const c = pauseTaskForQuota(b.state, 'desktop-action:quota')
    if (!c.ok) throw new Error(c.reason)
    state = c.state
    const store = new MemoryStore()
    store.serialized = encodeTaskRuntimeState(state, DESKTOP_ACTION_TASK_CODEC_LIMITS)
    const { bridge } = make({}, store)
    await bridge.recover()
    expect(bridge.snapshot().map((task) => task.status)).toEqual(['cancelled', 'cancelled'])
  })
})
