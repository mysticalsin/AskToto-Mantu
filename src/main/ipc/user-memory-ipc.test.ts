import { describe, expect, it, vi } from 'vitest'
import { USER_MEMORY_IPC } from '@shared/user-memory'
import { registerUserMemoryIpc } from './user-memory-ipc'
import { SenderRefusal, type AuthorizeSender } from './sender-auth'

const ID = 'a'.repeat(32)

function harness(options: { signedIn?: boolean; refuse?: boolean } = {}) {
  const handlers = new Map<string, (event: unknown, raw?: unknown) => Promise<unknown>>()
  const surfaces: Array<{ surface: string; requireOwner: boolean; allowedFrames: string }> = []
  const memory = {
    list: vi.fn(async () => ({ status: 'ok' as const, items: [], tombstones: 0 })),
    correct: vi.fn(async () => true),
    delete: vi.fn(async () => true)
  }
  const audit = vi.fn()
  const authorizeSender = ((_event: unknown, o: { surface: string; requireOwner: boolean; allowedFrames: string }) => {
    surfaces.push(o)
    if (options.refuse) throw new SenderRefusal('wrong-window', o.surface)
    return null
  }) as unknown as AuthorizeSender
  registerUserMemoryIpc({
    ipcMain: { handle: (channel: string, fn: never) => void handlers.set(channel, fn) },
    authorizeSender,
    requireAuth: () => options.signedIn ?? true,
    memory,
    audit
  })
  return {
    handlers,
    surfaces,
    memory,
    audit,
    call: (channel: string, raw?: unknown) => handlers.get(channel)!({}, raw)
  }
}

describe('user memory IPC (G57)', () => {
  it('registers exactly list, correct and delete (no add), each behind the main-window top-frame gate', async () => {
    const h = harness()
    expect([...h.handlers.keys()].sort()).toEqual(Object.values(USER_MEMORY_IPC).sort())
    expect(Object.keys(USER_MEMORY_IPC).sort()).toEqual(['correct', 'delete', 'list'])
    await h.call(USER_MEMORY_IPC.list)
    await h.call(USER_MEMORY_IPC.correct, { id: ID, text: 'x' })
    await h.call(USER_MEMORY_IPC.delete, { id: ID })
    expect(h.surfaces).toHaveLength(3)
    for (const s of h.surfaces) expect(s).toMatchObject({ requireOwner: false, allowedFrames: 'main-window-top' })
  })

  it('a refused sender reaches nothing', async () => {
    const h = harness({ refuse: true })
    for (const channel of Object.values(USER_MEMORY_IPC))
      await expect(h.call(channel, { id: ID, text: 'x' })).rejects.toBeInstanceOf(SenderRefusal)
    for (const fn of Object.values(h.memory)) expect(fn).not.toHaveBeenCalled()
  })

  it('signed out: list is unavailable and writes are refused', async () => {
    const h = harness({ signedIn: false })
    expect(await h.call(USER_MEMORY_IPC.list)).toEqual({ status: 'unavailable', items: [], tombstones: 0 })
    expect(await h.call(USER_MEMORY_IPC.delete, { id: ID })).toEqual({ ok: false })
    expect(await h.call(USER_MEMORY_IPC.correct, { id: ID, text: 'x' })).toEqual({ ok: false })
    expect(h.memory.delete).not.toHaveBeenCalled()
  })

  it('validates strictly: extra keys, a bad id, empty or oversized text and non-objects are refused untouched', async () => {
    const h = harness()
    for (const bad of [
      undefined,
      null,
      'x',
      {},
      { id: 'nope', text: 'x' },
      { id: ID, text: '' },
      { id: ID, text: 'x'.repeat(401) },
      { id: ID, text: 'x', kind: 'preference' }
    ])
      expect(await h.call(USER_MEMORY_IPC.correct, bad)).toEqual({ ok: false })
    for (const bad of [undefined, { id: 'x' }, { id: ID, extra: 1 }])
      expect(await h.call(USER_MEMORY_IPC.delete, bad)).toEqual({ ok: false })
    expect(h.memory.correct).not.toHaveBeenCalled()
    expect(h.memory.delete).not.toHaveBeenCalled()
  })

  it('passes the validated payload, audits action and outcome only, and a throw becomes a refusal', async () => {
    const h = harness()
    expect(await h.call(USER_MEMORY_IPC.correct, { id: ID, text: ' Answer in Portuguese ' })).toEqual({ ok: true })
    expect(h.memory.correct).toHaveBeenCalledWith(ID, 'Answer in Portuguese')
    h.memory.delete.mockRejectedValueOnce(new Error('disk'))
    expect(await h.call(USER_MEMORY_IPC.delete, { id: ID })).toEqual({ ok: false })
    expect(h.audit.mock.calls).toEqual([[{ action: 'correct', ok: true }], [{ action: 'delete', ok: false }]])
    h.memory.list.mockRejectedValueOnce(new Error('disk'))
    expect(await h.call(USER_MEMORY_IPC.list)).toEqual({ status: 'unavailable', items: [], tombstones: 0 })
  })
})
