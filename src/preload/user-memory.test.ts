import { describe, expect, it, vi } from 'vitest'
import { USER_MEMORY_IPC } from '../shared/user-memory'
import { createUserMemoryPreloadApi } from './user-memory'

const ID = 'a'.repeat(32)
const fakeIpc = (replies: Record<string, unknown> = {}) => ({ invoke: vi.fn(async (c: string) => replies[c]) })

describe('user memory preload bridge (G57)', () => {
  it('exposes only list, correct and remove: nothing adds an item', () => {
    expect(Object.keys(createUserMemoryPreloadApi(fakeIpc() as never).userMemory).sort()).toEqual([
      'correct',
      'list',
      'remove'
    ])
  })

  it('parses a list and replaces a malformed reply with a content-free fallback', async () => {
    const item = {
      id: ID,
      kind: 'preference',
      text: 'Answer in Portuguese',
      source: 'owner-typed',
      at: 1,
      revision: 1,
      expiresAt: null,
      conversation: null
    }
    const good = { status: 'ok', items: [item], tombstones: 2 }
    expect(
      await createUserMemoryPreloadApi(fakeIpc({ [USER_MEMORY_IPC.list]: good }) as never).userMemory.list()
    ).toEqual(good)
    for (const bad of [
      { ...good, items: [{ ...item, extra: 1 }] },
      { ...good, items: [{ ...item, kind: 'instruction' }] },
      null,
      'x'
    ])
      expect(
        await createUserMemoryPreloadApi(fakeIpc({ [USER_MEMORY_IPC.list]: bad }) as never).userMemory.list()
      ).toEqual({ status: 'unavailable', items: [], tombstones: 0 })
  })

  it('sends validated shapes and never throws', async () => {
    const ipc = fakeIpc({
      [USER_MEMORY_IPC.delete]: { ok: true },
      [USER_MEMORY_IPC.correct]: { ok: true, text: 'leak' }
    })
    const api = createUserMemoryPreloadApi(ipc as never).userMemory
    expect(await api.remove(ID)).toEqual({ ok: true })
    expect(ipc.invoke).toHaveBeenCalledWith(USER_MEMORY_IPC.delete, { id: ID })
    expect(await api.correct(ID, 'new')).toEqual({ ok: false })
    const broken = createUserMemoryPreloadApi({
      invoke: vi.fn(async () => Promise.reject(new Error('x')))
    } as never).userMemory
    expect(await broken.remove(ID)).toEqual({ ok: false })
    expect((await broken.list()).status).toBe('unavailable')
  })
})
