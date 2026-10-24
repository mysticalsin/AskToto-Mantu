import { describe, expect, it, vi } from 'vitest'
import { ROUTINE_IPC, RoutineViewSchema } from '@shared/routines'
import { registerRoutinesIpc } from './routines-ipc'
import { SenderRefusal, type AuthorizeSender } from './sender-auth'
import type { RoutineEngine } from '../features/routines'

const ID = `r_${'a'.repeat(24)}`
const VIEW = {
  routineId: ID,
  assistantId: 'sys-sales',
  title: 'Stand up',
  purpose: 'reminder',
  consentKind: 'recurring',
  schedule: { kind: 'recurring', cadence: 'daily', time: '09:00', timeZone: 'UTC' },
  copy: 'Every day 09:00 UTC',
  status: 'active',
  pauseReasons: [],
  waiting: null,
  failures: 0,
  lastErrorClass: null,
  nextDueAt: 1,
  quotaResetAt: null,
  history: [],
  availability: { runner: 'running', copy: 'Runs while Métis is open' }
}

function setup(options: { signedIn?: boolean; refuse?: boolean } = {}) {
  const engine = {
    compile: vi.fn(async () => ({ ok: false, reason: 'unsupported' })),
    consent: vi.fn(async () => ({ ok: true, routine: VIEW, created: true })),
    list: vi.fn(async () => ({ ok: true, routines: [VIEW] })),
    pause: vi.fn(async () => ({ ok: true, routine: VIEW })),
    resume: vi.fn(async () => ({ ok: true, routine: VIEW })),
    runNow: vi.fn(async () => ({ ok: true, routine: VIEW })),
    remove: vi.fn(async () => ({ ok: true, routine: null }))
  } as unknown as RoutineEngine
  const handlers = new Map<string, (event: unknown, raw?: unknown) => Promise<unknown>>()
  const surfaces: Array<{ surface: string; requireOwner: boolean; allowedFrames: string }> = []
  const authorizeSender = ((_event: unknown, o: { surface: string; requireOwner: boolean; allowedFrames: string }) => {
    surfaces.push(o)
    if (options.refuse) throw new SenderRefusal('wrong-window', o.surface)
    return null
  }) as unknown as AuthorizeSender
  const sender = { send: vi.fn(), isDestroyed: () => false }
  const api = registerRoutinesIpc({
    ipcMain: { handle: (channel: string, fn: never) => void handlers.set(channel, fn) },
    authorizeSender,
    requireAuth: () => options.signedIn ?? true,
    engine
  })
  return {
    engine,
    api,
    sender,
    surfaces,
    handlers,
    call: (channel: string, raw?: unknown) => handlers.get(channel)!({ sender }, raw)
  }
}

describe('routines IPC (G66)', () => {
  it('registers exactly the seven request channels, each behind the main-window top-frame gate', async () => {
    const t = setup()
    const request = Object.values(ROUTINE_IPC).filter((c) => c !== ROUTINE_IPC.changed && c !== ROUTINE_IPC.result)
    expect([...t.handlers.keys()].sort()).toEqual(request.sort())
    for (const channel of request) await t.call(channel, {})
    expect(t.surfaces).toHaveLength(7)
    for (const s of t.surfaces) expect(s).toMatchObject({ requireOwner: true, allowedFrames: 'main-window-top' })
  })

  it('non-main sender refused', async () => {
    const t = setup({ refuse: true })
    await expect(t.call(ROUTINE_IPC.list)).rejects.toBeInstanceOf(SenderRefusal)
    expect(t.engine.list).not.toHaveBeenCalled()
  })

  it('signed-out refusal', async () => {
    const t = setup({ signedIn: false })
    for (const channel of [ROUTINE_IPC.list, ROUTINE_IPC.compile, ROUTINE_IPC.consent, ROUTINE_IPC.pause]) {
      expect(await t.call(channel, {})).toEqual({ ok: false, reason: 'signed-out' })
    }
    expect(t.engine.list).not.toHaveBeenCalled()
  })

  it('unknown key → invalid', async () => {
    const t = setup()
    const draft = {
      assistantId: 'sys-sales',
      purpose: 'reminder',
      title: 'x',
      consentKind: 'recurring',
      phrase: 'every day at 9am'
    }
    expect(await t.call(ROUTINE_IPC.compile, { ...draft, ownerKey: 'a'.repeat(64) })).toEqual({
      ok: false,
      reason: 'invalid'
    })
    expect(await t.call(ROUTINE_IPC.compile, { ...draft, action: { id: 'desktop.open_x' } })).toEqual({
      ok: false,
      reason: 'invalid'
    })
    expect(await t.call(ROUTINE_IPC.compile, { ...draft, tools: ['mail.send'] })).toEqual({
      ok: false,
      reason: 'invalid'
    })
    // Both a schedule and a phrase, or neither, is invalid.
    expect(
      await t.call(ROUTINE_IPC.compile, {
        ...draft,
        schedule: { kind: 'once', date: '2026-11-02', time: '09:00', timeZone: 'UTC' }
      })
    ).toEqual({ ok: false, reason: 'invalid' })
    expect(await t.call(ROUTINE_IPC.pause, { routineId: ID, scope: {} })).toEqual({ ok: false, reason: 'invalid' })
    expect(await t.call(ROUTINE_IPC.pause, { routineId: 'nope' })).toEqual({ ok: false, reason: 'invalid' })
    expect(await t.call(ROUTINE_IPC.list, { x: 1 })).toEqual({ ok: false, reason: 'invalid' })
    expect(t.engine.compile).not.toHaveBeenCalled()
    expect(await t.call(ROUTINE_IPC.compile, draft)).toEqual({ ok: false, reason: 'unsupported' })
  })

  it('forwards parsed requests only', async () => {
    const t = setup()
    await t.call(ROUTINE_IPC.resume, { routineId: ID, reconciled: true })
    expect(t.engine.resume).toHaveBeenCalledWith({ routineId: ID, reconciled: true })
    expect(await t.call(ROUTINE_IPC.resume, { routineId: ID, reconciled: false })).toEqual({
      ok: false,
      reason: 'invalid'
    })
  })

  it('views carry no owner/tenant/idempotency keys', async () => {
    const t = setup()
    const out = (await t.call(ROUTINE_IPC.list)) as { routines: unknown[] }
    const text = JSON.stringify(out)
    expect(text).not.toMatch(/ownerKey|tenantKey|idempotency|journal/i)
    expect(RoutineViewSchema.safeParse(out.routines[0]).success).toBe(true)
    // The schema is strict: a view that carried a key would not parse.
    expect(RoutineViewSchema.safeParse({ ...VIEW, ownerKey: 'a'.repeat(64) }).success).toBe(false)
    expect(RoutineViewSchema.safeParse({ ...VIEW, idempotencyKey: 'a'.repeat(64) }).success).toBe(false)
  })

  it('an engine failure becomes a typed refusal, not an error', async () => {
    const t = setup()
    vi.mocked(t.engine.list).mockRejectedValueOnce(new Error('boom'))
    expect(await t.call(ROUTINE_IPC.list)).toEqual({ ok: false, reason: 'unavailable' })
  })

  it('pushes content-free events to the windows that used the surface', async () => {
    const t = setup()
    await t.call(ROUTINE_IPC.list)
    t.api.push({ type: 'changed' })
    t.api.push({ type: 'result', routineId: ID, outcome: 'succeeded', at: 5 })
    expect(t.sender.send.mock.calls).toEqual([
      [ROUTINE_IPC.changed, {}],
      [ROUTINE_IPC.result, { routineId: ID, outcome: 'succeeded', at: 5 }]
    ])
  })
})
