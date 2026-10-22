import { describe, expect, it, vi } from 'vitest'
import { DICTATION_MEMORY_IPC } from '@shared/dictation-memory'
import { registerDictationMemoryIpc } from './dictation-memory-ipc'
import { SenderRefusal, type AuthorizeSender } from './sender-auth'

const ID = 'a'.repeat(32)

function harness(options: { signedIn?: boolean; refuse?: boolean } = {}) {
  const handlers = new Map<string, (event: unknown, raw?: unknown) => Promise<unknown>>()
  const surfaces: Array<{ surface: string; requireOwner: boolean; allowedFrames: string }> = []
  const memory = {
    recoveryTake: vi.fn(async () => null),
    recoveryResolve: vi.fn(async () => ({ ok: true, count: 0 })),
    spansRecent: vi.fn(() => ({ spans: [] })),
    spansCorrect: vi.fn(async () => ({ ok: true, count: 1 })),
    dictionaryList: vi.fn(async () => ({ status: 'ok' as const, entries: [] })),
    dictionaryRemove: vi.fn(async () => ({ ok: true, count: 1 })),
    dictionaryClear: vi.fn(async () => ({ ok: true, count: 2 }))
  }
  const authorizeSender = ((_event: unknown, o: { surface: string; requireOwner: boolean; allowedFrames: string }) => {
    surfaces.push(o)
    if (options.refuse) throw new SenderRefusal('wrong-window', o.surface)
    return null
  }) as unknown as AuthorizeSender
  registerDictationMemoryIpc({
    ipcMain: { handle: (channel: string, fn: never) => void handlers.set(channel, fn) },
    authorizeSender,
    requireAuth: () => options.signedIn ?? true,
    memory
  })
  return { handlers, surfaces, memory, call: (channel: string, raw?: unknown) => handlers.get(channel)!({}, raw) }
}

describe('dictation memory IPC (G26)', () => {
  it('registers exactly the seven channels, each behind the main-window top-frame sender gate', async () => {
    const h = harness()
    expect([...h.handlers.keys()].sort()).toEqual(Object.values(DICTATION_MEMORY_IPC).sort())
    for (const channel of Object.values(DICTATION_MEMORY_IPC))
      await h.call(channel, channel.endsWith('Remove') ? { id: ID } : {})
    expect(h.surfaces).toHaveLength(7)
    for (const surface of h.surfaces) {
      expect(surface).toMatchObject({ requireOwner: false, allowedFrames: 'main-window-top' })
      expect(surface.surface).toMatch(/^dictation\.memory\./)
    }
  })

  it('a refused sender reaches nothing', async () => {
    const h = harness({ refuse: true })
    for (const channel of Object.values(DICTATION_MEMORY_IPC))
      await expect(h.call(channel, { id: ID })).rejects.toBeInstanceOf(SenderRefusal)
    for (const fn of Object.values(h.memory)) expect(fn).not.toHaveBeenCalled()
  })

  it('signed out: reads are empty, writes are refused, and a signed-out person can still not touch the memory', async () => {
    const h = harness({ signedIn: false })
    expect(await h.call(DICTATION_MEMORY_IPC.recoveryTake)).toBeNull()
    expect(await h.call(DICTATION_MEMORY_IPC.spansRecent)).toEqual({ spans: [] })
    expect(await h.call(DICTATION_MEMORY_IPC.dictionaryList)).toEqual({ status: 'unavailable', entries: [] })
    expect(await h.call(DICTATION_MEMORY_IPC.dictionaryRemove, { id: ID })).toEqual({ ok: false, count: 0 })
    expect(await h.call(DICTATION_MEMORY_IPC.dictionaryClear)).toEqual({ ok: false, count: 0 })
    expect(await h.call(DICTATION_MEMORY_IPC.recoveryResolve, { id: ID })).toEqual({ ok: false, count: 0 })
    expect(await h.call(DICTATION_MEMORY_IPC.spansCorrect, { id: ID, correctedText: 'x' })).toEqual({
      ok: false,
      count: 0
    })
    for (const fn of Object.values(h.memory)) expect(fn).not.toHaveBeenCalled()
  })

  it('validates every payload strictly: unknown keys, a bad id, empty or oversize text are refused before main acts', async () => {
    const h = harness()
    const refused = { ok: false, count: 0 }
    expect(await h.call(DICTATION_MEMORY_IPC.recoveryResolve, { id: 'x' })).toEqual(refused)
    expect(await h.call(DICTATION_MEMORY_IPC.recoveryResolve, { id: ID, original: 'meeting words' })).toEqual(refused)
    expect(await h.call(DICTATION_MEMORY_IPC.recoveryResolve, { id: ID, correctedText: '' })).toEqual(refused)
    expect(await h.call(DICTATION_MEMORY_IPC.spansCorrect, { id: ID, correctedText: 'x'.repeat(16_001) })).toEqual(
      refused
    )
    expect(await h.call(DICTATION_MEMORY_IPC.spansCorrect, { id: ID, original: 'a', correctedText: 'b' })).toEqual(
      refused
    )
    expect(await h.call(DICTATION_MEMORY_IPC.spansCorrect, 'nope')).toEqual(refused)
    expect(await h.call(DICTATION_MEMORY_IPC.dictionaryRemove, { id: ID, all: true })).toEqual(refused)
    expect(await h.call(DICTATION_MEMORY_IPC.dictionaryRemove, undefined)).toEqual(refused)
    expect(h.memory.recoveryResolve).not.toHaveBeenCalled()
    expect(h.memory.spansCorrect).not.toHaveBeenCalled()
    expect(h.memory.dictionaryRemove).not.toHaveBeenCalled()
  })

  it('passes a valid request to main and returns its answer', async () => {
    const h = harness()
    expect(await h.call(DICTATION_MEMORY_IPC.recoveryResolve, { id: ID, correctedText: 'fixed text' })).toEqual({
      ok: true,
      count: 0
    })
    expect(h.memory.recoveryResolve).toHaveBeenCalledWith({ id: ID, correctedText: 'fixed text' })
    expect(await h.call(DICTATION_MEMORY_IPC.spansCorrect, { id: ID, correctedText: 'fixed text' })).toEqual({
      ok: true,
      count: 1
    })
    expect(await h.call(DICTATION_MEMORY_IPC.dictionaryRemove, { id: ID })).toEqual({ ok: true, count: 1 })
    expect(await h.call(DICTATION_MEMORY_IPC.dictionaryClear)).toEqual({ ok: true, count: 2 })
  })

  it('never lets a main-side failure surface as an error or carry text: a throw becomes the typed fallback', async () => {
    const h = harness()
    h.memory.recoveryTake.mockRejectedValueOnce(new Error('synthetic secret text'))
    h.memory.dictionaryList.mockRejectedValueOnce(new Error('synthetic secret text'))
    h.memory.dictionaryClear.mockRejectedValueOnce(new Error('synthetic secret text'))
    expect(await h.call(DICTATION_MEMORY_IPC.recoveryTake)).toBeNull()
    expect(await h.call(DICTATION_MEMORY_IPC.dictionaryList)).toEqual({ status: 'unavailable', entries: [] })
    expect(await h.call(DICTATION_MEMORY_IPC.dictionaryClear)).toEqual({ ok: false, count: 0 })
  })
})
