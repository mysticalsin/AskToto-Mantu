import { describe, expect, it, vi } from 'vitest'
import type { QuietAction } from '@shared/quiet-mode-settings'
import { ROUTINE_AVAILABILITY_COPY, type CompileRequest } from '@shared/routines'
import { TaskScheduler } from '../../tasks/task-scheduler'
import {
  createRoutineEngine,
  ROUTINE_SCHEDULER_LIMITS,
  type RoutineEngine,
  type RoutineEngineDeps
} from './routine-engine'
import { createRoutineStore, type RoutineFileIo, type RoutineScope } from './routine-store'

const KEY_A = 'a'.repeat(64)
const KEY_B = 'b'.repeat(64)
const T1 = '1'.repeat(64)
const scopeA: RoutineScope = { partitionId: 'a1'.repeat(12), ownerKey: KEY_A, tenantKey: T1 }
const scopeB: RoutineScope = { partitionId: 'b1'.repeat(12), ownerKey: KEY_B, tenantKey: T1 }
const seal = (plain: string): Buffer => Buffer.from(Buffer.from(plain, 'utf8').map((b) => b ^ 0x5a))
const open = (sealed: Buffer): string => Buffer.from(sealed.map((b) => b ^ 0x5a)).toString('utf8')
const T0 = Date.parse('2026-11-01T10:00:00Z')
const DAY = 86_400_000

function memoryIo(): RoutineFileIo & { files: Map<string, Buffer> } {
  const files = new Map<string, Buffer>()
  return {
    files,
    async read(id) {
      return files.get(id) ?? null
    },
    async write(id, data) {
      files.set(id, data)
    }
  }
}

const DAILY: CompileRequest = {
  assistantId: 'sys-sales',
  purpose: 'reminder',
  title: 'Stand up',
  consentKind: 'recurring',
  schedule: { kind: 'recurring', cadence: 'daily', time: '09:00', timeZone: 'UTC' }
}

interface Rig {
  engine: RoutineEngine
  io: ReturnType<typeof memoryIo>
  clock: { now: number }
  current: { scope: RoutineScope | null }
  state: {
    online: boolean
    quiet: QuietAction
    publishResult: QuietAction
    idle: boolean
    allowance: { available: true } | { available: false; resetAt: number | null }
    archived: Set<string>
  }
  publish: ReturnType<typeof vi.fn>
  emit: ReturnType<typeof vi.fn>
  audit: ReturnType<typeof vi.fn>
  make(extra?: Partial<RoutineEngineDeps>): RoutineEngine
}

function rig(extra: Partial<RoutineEngineDeps> = {}): Rig {
  const io = memoryIo()
  const clock = { now: T0 }
  const current: { scope: RoutineScope | null } = { scope: scopeA }
  const state: Rig['state'] = {
    online: true,
    quiet: 'allow',
    publishResult: 'allow',
    idle: true,
    allowance: { available: true },
    archived: new Set()
  }
  const publish = vi.fn(() => state.publishResult)
  const emit = vi.fn()
  const audit = vi.fn()
  const make = (more: Partial<RoutineEngineDeps> = {}): RoutineEngine =>
    createRoutineEngine({
      store: createRoutineStore({ io, seal, open, scope: () => current.scope }),
      scope: () => current.scope,
      scheduler: new TaskScheduler(ROUTINE_SCHEDULER_LIMITS),
      now: () => clock.now,
      defaultTimeZone: () => 'UTC',
      assistants: async () => [
        { assistantId: 'sys-sales', archived: state.archived.has('sys-sales') },
        { assistantId: 'sys-support', archived: state.archived.has('sys-support') }
      ],
      isOnline: () => state.online,
      allowance: () => state.allowance,
      quietAction: () => state.quiet,
      publish,
      commandIdle: () => state.idle,
      audit,
      emit,
      ...extra,
      ...more
    })
  return { engine: make(), io, clock, current, state, publish, emit, audit, make }
}

async function create(r: Rig, request: CompileRequest = DAILY, engine: RoutineEngine = r.engine) {
  const compiled = await engine.compile(request)
  if (!compiled.ok) throw new Error(`compile refused: ${compiled.reason}`)
  const consent = await engine.consent({ proposalId: compiled.proposalId, previewHash: compiled.previewHash })
  if (!consent.ok) throw new Error(`consent refused: ${consent.reason}`)
  return { compiled, consent }
}

const listed = async (engine: RoutineEngine) => {
  const out = await engine.list()
  if (!out.ok) throw new Error(out.reason)
  return out.routines
}

describe('routine engine (G66)', () => {
  it('compile previews three runs with the owner copy and nothing is stored', async () => {
    const r = rig()
    const c = await r.engine.compile(DAILY)
    expect(c.ok && c.preview.copy).toBe('Every day 09:00 UTC; next run 2026-11-02 09:00')
    expect(c.ok && c.preview.nextRuns).toHaveLength(3)
    expect(await listed(r.engine)).toHaveLength(0)
  })

  it('once consent creates no recurrence', async () => {
    const r = rig()
    const { consent } = await create(r, {
      ...DAILY,
      consentKind: 'once',
      schedule: { kind: 'once', date: '2026-11-02', time: '09:00', timeZone: 'UTC' }
    })
    expect(consent.ok && consent.routine.consentKind).toBe('once')
    r.clock.now = Date.parse('2026-11-02T09:00:30Z')
    await r.engine.tick()
    await r.engine.idle()
    expect(r.publish).toHaveBeenCalledTimes(1)
    const [routine] = await listed(r.engine)
    expect(routine!.status).toBe('completed')
    expect(routine!.nextDueAt).toBeNull()
    r.clock.now += 5 * DAY
    await r.engine.tick()
    await r.engine.idle()
    expect(r.publish).toHaveBeenCalledTimes(1)
  })

  it('a consent kind that disagrees with the schedule is refused', async () => {
    const r = rig()
    expect(await r.engine.compile({ ...DAILY, consentKind: 'once' })).toEqual({ ok: false, reason: 'consent_mismatch' })
  })

  it('recurring consent creates exactly one; replay returns same id', async () => {
    const r = rig()
    const first = await create(r)
    const again = await r.engine.consent({
      proposalId: first.compiled.ok ? first.compiled.proposalId : '',
      previewHash: first.compiled.ok ? first.compiled.previewHash : ''
    })
    expect(again.ok && again.created).toBe(false)
    expect(again.ok && first.consent.ok && again.routine.routineId === first.consent.routine.routineId).toBe(true)
    expect(await listed(r.engine)).toHaveLength(1)
  })

  it('hash mismatch refused', async () => {
    const r = rig()
    const c = await r.engine.compile(DAILY)
    if (!c.ok) throw new Error('compile')
    expect(await r.engine.consent({ proposalId: c.proposalId, previewHash: 'f'.repeat(64) })).toEqual({
      ok: false,
      reason: 'preview-mismatch'
    })
    expect(await r.engine.consent({ proposalId: '0'.repeat(32), previewHash: c.previewHash })).toEqual({
      ok: false,
      reason: 'unknown-proposal'
    })
    r.clock.now += 11 * 60_000
    expect(await r.engine.consent({ proposalId: c.proposalId, previewHash: c.previewHash })).toEqual({
      ok: false,
      reason: 'expired'
    })
    expect(await listed(r.engine)).toHaveLength(0)
  })

  it('five missed runs → one claim, one coalesced(4)', async () => {
    const r = rig()
    await create(r)
    r.clock.now = Date.parse('2026-11-06T10:00:00Z')
    await r.engine.tick()
    await r.engine.idle()
    expect(r.publish).toHaveBeenCalledTimes(1)
    const [routine] = await listed(r.engine)
    const coalesced = routine!.history.filter((h) => h.outcome === 'coalesced')
    expect(coalesced).toHaveLength(1)
    expect(coalesced[0]!.count).toBe(4)
    expect(routine!.history.filter((h) => h.outcome === 'succeeded')).toHaveLength(1)
    // Nothing more is owed.
    await r.engine.tick()
    await r.engine.idle()
    expect(r.publish).toHaveBeenCalledTimes(1)
  })

  it('concurrent wake+network ticks start once', async () => {
    const r = rig()
    await create(r)
    r.clock.now = Date.parse('2026-11-02T09:00:05Z')
    await Promise.all([r.engine.tick(), r.engine.tick(), r.engine.tick()])
    await r.engine.idle()
    expect(r.publish).toHaveBeenCalledTimes(1)
    // A second engine over the same file also finds the lease and starts nothing.
    const other = r.make()
    await other.tick()
    await other.idle()
    expect(r.publish).toHaveBeenCalledTimes(1)
  })

  it('run-now keeps nextDueAt', async () => {
    const r = rig()
    const { consent } = await create(r)
    if (!consent.ok) throw new Error('consent')
    const before = consent.routine.nextDueAt
    const out = await r.engine.runNow({ routineId: consent.routine.routineId })
    expect(out.ok).toBe(true)
    await r.engine.idle()
    expect(r.publish).toHaveBeenCalledTimes(1)
    const [routine] = await listed(r.engine)
    expect(routine!.nextDueAt).toBe(before)
    expect(routine!.history.at(-1)!.outcome).toBe('succeeded')
  })

  it('pause blocks future starts and resume does not replay the missed ones', async () => {
    const r = rig()
    const { consent } = await create(r)
    if (!consent.ok) throw new Error('consent')
    const id = consent.routine.routineId
    const paused = await r.engine.pause({ routineId: id })
    expect(paused.ok && paused.routine?.pauseReasons).toEqual(['user'])
    r.clock.now = Date.parse('2026-11-03T10:00:00Z')
    await r.engine.tick()
    await r.engine.idle()
    expect(r.publish).not.toHaveBeenCalled()
    expect(await r.engine.runNow({ routineId: id })).toEqual({ ok: false, reason: 'paused' })
    const resumed = await r.engine.resume({ routineId: id })
    expect(resumed.ok && resumed.routine?.pauseReasons).toEqual([])
    await r.engine.tick()
    await r.engine.idle()
    expect(r.publish).not.toHaveBeenCalled()
  })

  it('delete removes the routine', async () => {
    const r = rig()
    const { consent } = await create(r)
    if (!consent.ok) throw new Error('consent')
    expect(await r.engine.remove({ routineId: consent.routine.routineId })).toEqual({ ok: true, routine: null })
    expect(await listed(r.engine)).toHaveLength(0)
    expect(await r.engine.remove({ routineId: consent.routine.routineId })).toEqual({ ok: false, reason: 'not-found' })
  })

  it('quiet defer waits (no failure); the wait clears and the run starts when quiet ends', async () => {
    const r = rig()
    await create(r)
    r.state.quiet = 'defer'
    r.clock.now = Date.parse('2026-11-02T09:00:05Z')
    await r.engine.tick()
    await r.engine.idle()
    expect(r.publish).not.toHaveBeenCalled()
    let [routine] = await listed(r.engine)
    expect(routine!.waiting).toMatchObject({ reason: 'quiet' })
    expect(routine!.failures).toBe(0)
    expect(routine!.history.at(-1)).toMatchObject({ outcome: 'waiting', waitReason: 'quiet' })
    // The same wait is not written twice.
    await r.engine.tick()
    ;[routine] = await listed(r.engine)
    expect(routine!.history.filter((h) => h.outcome === 'waiting')).toHaveLength(1)
    r.state.quiet = 'allow'
    await r.engine.tick()
    await r.engine.idle()
    expect(r.publish).toHaveBeenCalledTimes(1)
    ;[routine] = await listed(r.engine)
    expect(routine!.waiting).toBeNull()
  })

  it('network is a wait, not a failure', async () => {
    const r = rig()
    await create(r)
    r.state.online = false
    r.clock.now = Date.parse('2026-11-02T09:00:05Z')
    await r.engine.tick()
    const [routine] = await listed(r.engine)
    expect(routine!.waiting).toMatchObject({ reason: 'network' })
    expect(routine!.failures).toBe(0)
    expect(routine!.pauseReasons).toEqual([])
  })

  it('quiet drop records suppressed', async () => {
    const r = rig()
    await create(r)
    r.state.quiet = 'drop'
    r.state.publishResult = 'drop'
    r.clock.now = Date.parse('2026-11-02T09:00:05Z')
    await r.engine.tick()
    await r.engine.idle()
    const [routine] = await listed(r.engine)
    expect(routine!.history.map((h) => h.outcome)).toEqual(['succeeded', 'suppressed'])
  })

  it('owner change withholds a late result', async () => {
    let release: (v: { ok: true }) => void = () => {}
    const research = vi.fn(() => new Promise<{ ok: true }>((resolve) => (release = resolve)))
    const r = rig({ research })
    await create(r, { ...DAILY, purpose: 'read_only_suggestion', tools: ['web.search'] })
    r.clock.now = Date.parse('2026-11-02T09:00:05Z')
    await r.engine.tick()
    expect(research).toHaveBeenCalledTimes(1)
    r.current.scope = scopeB
    r.engine.onOwnerChange()
    release({ ok: true })
    await r.engine.idle()
    expect(r.publish).not.toHaveBeenCalled()
    expect(r.emit).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'result' }))
    // Back as the first owner, the lease the aborted run left open is reconciled, never silently re-run.
    r.current.scope = scopeA
    const [routine] = await listed(r.engine)
    expect(routine!.pauseReasons).toEqual(['review'])
  })

  it('scheduled_task only reaches proposeAction, never execute', async () => {
    const proposeAction = vi.fn(
      async (_action: { request: Record<string, unknown>; argsHash: string }, _ctx: { routineId: string }) => ({
        shown: true
      })
    )
    const r = rig({ proposeAction })
    const request = { id: 'desktop.open_x', args: {} }
    const compiled = await r.engine.compile({ ...DAILY, purpose: 'scheduled_task', action: { request } })
    if (!compiled.ok) throw new Error(`compile ${compiled.reason}`)
    await r.engine.consent({ proposalId: compiled.proposalId, previewHash: compiled.previewHash })
    r.clock.now = Date.parse('2026-11-02T09:00:05Z')
    await r.engine.tick()
    await r.engine.idle()
    expect(proposeAction).toHaveBeenCalledTimes(1)
    expect(proposeAction.mock.calls[0]![0]).toMatchObject({
      request,
      argsHash: expect.stringMatching(/^[0-9a-f]{64}$/)
    })
    // The card is the output: no extra unsolicited notification and no `execute` dependency exists.
    expect(r.publish).not.toHaveBeenCalled()
    const deps = Object.keys(proposeAction.mock.calls[0]![1] ?? {})
    expect(deps).not.toContain('execute')
  })

  it('owner_busy wait when a proposal is current', async () => {
    const proposeAction = vi.fn(async () => ({ shown: true }))
    const r = rig({ proposeAction })
    const compiled = await r.engine.compile({
      ...DAILY,
      purpose: 'scheduled_task',
      action: { request: { id: 'desktop.open_x', args: {} } }
    })
    if (!compiled.ok) throw new Error('compile')
    await r.engine.consent({ proposalId: compiled.proposalId, previewHash: compiled.previewHash })
    r.state.idle = false
    r.clock.now = Date.parse('2026-11-02T09:00:05Z')
    await r.engine.tick()
    await r.engine.idle()
    expect(proposeAction).not.toHaveBeenCalled()
    const [routine] = await listed(r.engine)
    expect(routine!.waiting).toMatchObject({ reason: 'owner_busy' })
    expect(routine!.failures).toBe(0)
  })

  it('read_only_suggestion with write tool refused', async () => {
    const r = rig({ research: async () => ({ ok: true }) })
    const out = await r.engine.compile({ ...DAILY, purpose: 'read_only_suggestion', tools: ['mail.send'] } as never)
    expect(out).toEqual({ ok: false, reason: 'tool_not_allowed' })
  })

  it('unsupported purposes refused when port absent', async () => {
    const r = rig()
    expect(await r.engine.compile({ ...DAILY, purpose: 'read_only_suggestion', tools: ['web.search'] })).toEqual({
      ok: false,
      reason: 'unsupported'
    })
    expect(
      await r.engine.compile({
        ...DAILY,
        purpose: 'scheduled_task',
        action: { request: { id: 'desktop.open_x', args: {} } }
      })
    ).toEqual({ ok: false, reason: 'unsupported' })
  })

  it('availability copy present on every view', async () => {
    const r = rig()
    await create(r)
    await create(r, { ...DAILY, title: 'Second' })
    const views = await listed(r.engine)
    expect(views).toHaveLength(2)
    for (const v of views) {
      expect(v.availability).toEqual({ runner: 'running', copy: ROUTINE_AVAILABILITY_COPY })
    }
    r.engine.onOwnerChange()
    expect((await listed(r.engine))[0]!.availability.runner).toBe('not_running')
    await r.engine.tick()
    expect((await listed(r.engine))[0]!.availability.runner).toBe('running')
  })

  it('three genuine failures pause with the error class; waiting never counted', async () => {
    const research = vi.fn(async () => ({ ok: false as const, errorClass: 'provider' as const }))
    const r = rig({ research })
    await create(r, { ...DAILY, purpose: 'read_only_suggestion', tools: ['web.search'] })
    for (let day = 2; day <= 4; day += 1) {
      r.state.online = false
      r.clock.now = Date.parse(`2026-11-0${day}T09:00:05Z`)
      await r.engine.tick()
      expect((await listed(r.engine))[0]!.failures).toBe(day - 2)
      r.state.online = true
      await r.engine.tick()
      await r.engine.idle()
    }
    const [routine] = await listed(r.engine)
    expect(routine!.failures).toBe(3)
    expect(routine!.pauseReasons).toEqual(['failure'])
    expect(routine!.lastErrorClass).toBe('provider')
    expect(research).toHaveBeenCalledTimes(3)
  })

  it('quota pause shows one notice per resetAt and a reset clears only quota', async () => {
    const r = rig()
    const { consent } = await create(r)
    if (!consent.ok) throw new Error('consent')
    await r.engine.pause({ routineId: consent.routine.routineId })
    r.state.allowance = { available: false, resetAt: T0 + 3 * DAY }
    r.clock.now = T0 + 1000
    await r.engine.tick()
    await r.engine.tick()
    let [routine] = await listed(r.engine)
    expect(routine!.pauseReasons).toEqual(['quota', 'user'])
    expect(routine!.quotaResetAt).toBe(T0 + 3 * DAY)
    expect(r.publish.mock.calls.filter((c) => (c[0] as { kind: string }).kind === 'allowance')).toHaveLength(1)
    r.state.allowance = { available: true }
    await r.engine.tick()
    ;[routine] = await listed(r.engine)
    expect(routine!.pauseReasons).toEqual(['user'])
  })

  it('archived assistant pauses with archive and resume is refused until unarchived', async () => {
    const r = rig()
    const { consent } = await create(r)
    if (!consent.ok) throw new Error('consent')
    r.state.archived.add('sys-sales')
    await r.engine.tick()
    const [routine] = await listed(r.engine)
    expect(routine!.pauseReasons).toEqual(['archive'])
    expect(await r.engine.resume({ routineId: consent.routine.routineId })).toEqual({
      ok: false,
      reason: 'assistant_archived'
    })
    r.state.archived.clear()
    const ok = await r.engine.resume({ routineId: consent.routine.routineId })
    expect(ok.ok && ok.routine?.pauseReasons).toEqual([])
  })

  it('a run left open by a previous process needs reconciliation before resume', async () => {
    const research = vi.fn(() => new Promise<{ ok: true }>(() => {}))
    const r = rig({ research })
    const { consent } = await create(r, { ...DAILY, purpose: 'read_only_suggestion', tools: ['web.search'] })
    if (!consent.ok) throw new Error('consent')
    r.clock.now = Date.parse('2026-11-02T09:00:05Z')
    await r.engine.tick()
    // The app quit while the run was open: a fresh engine opens the same file.
    const next = r.make({ research })
    const [routine] = await listed(next)
    expect(routine!.pauseReasons).toEqual(['review'])
    expect(await next.resume({ routineId: consent.routine.routineId })).toEqual({
      ok: false,
      reason: 'reconciliation_required'
    })
    // The owner says they checked what the open run did: only then does review clear.
    const out = await next.resume({ routineId: consent.routine.routineId, reconciled: true })
    expect(out.ok && out.routine?.pauseReasons).toEqual([])
  })

  it('refuses every call when signed out', async () => {
    const r = rig()
    r.current.scope = null
    expect(await r.engine.compile(DAILY)).toEqual({ ok: false, reason: 'signed-out' })
    expect(await r.engine.list()).toEqual({ ok: false, reason: 'signed-out' })
    expect(await r.engine.pause({ routineId: `r_${'0'.repeat(24)}` })).toEqual({ ok: false, reason: 'signed-out' })
  })

  it('never audits a title or an id', async () => {
    const r = rig()
    await create(r, { ...DAILY, title: 'Secret board prep' })
    r.clock.now = Date.parse('2026-11-02T09:00:05Z')
    await r.engine.tick()
    await r.engine.idle()
    expect(r.audit).toHaveBeenCalled()
    expect(JSON.stringify(r.audit.mock.calls)).not.toMatch(/Secret|r_[0-9a-f]{24}|sys-sales/)
  })
})
