import { describe, expect, it, vi } from 'vitest'
import { DICTATION_MEMORY_IPC } from '../shared/dictation-memory'
import { createDictationMemoryPreloadApi } from './dictation-memory'

const ID = 'a'.repeat(32)

function fakeIpc(replies: Record<string, unknown> = {}) {
  return { invoke: vi.fn(async (channel: string) => replies[channel]) }
}

describe('dictation memory preload bridge (G26)', () => {
  it('has no call that inserts text or supplies an original: only take, resolve, correct, list, remove and clear', () => {
    const api = createDictationMemoryPreloadApi(fakeIpc() as never).dictationMemory
    expect(Object.keys(api).sort()).toEqual(
      [
        'clearDictionary',
        'correctSpan',
        'listDictionary',
        'recentSpans',
        'removeDictionaryEntry',
        'resolveRecovery',
        'takeRecovery'
      ].sort()
    )
  })

  it('parses a recovery notice and drops anything that does not match the contract', async () => {
    const good = {
      v: 1,
      kind: 'dictation-recovery',
      autoInsert: false,
      items: [{ id: ID, text: 'synthetic words', savedAtMs: 5, reason: 'interrupted' }]
    }
    expect(
      await createDictationMemoryPreloadApi(
        fakeIpc({ [DICTATION_MEMORY_IPC.recoveryTake]: good }) as never
      ).dictationMemory.takeRecovery()
    ).toEqual(good)
    for (const bad of [{ ...good, autoInsert: true }, { ...good, items: [] }, null, 'x', { ...good, extra: 1 }]) {
      expect(
        await createDictationMemoryPreloadApi(
          fakeIpc({ [DICTATION_MEMORY_IPC.recoveryTake]: bad }) as never
        ).dictationMemory.takeRecovery()
      ).toBeNull()
    }
  })

  it('sends only the validated shapes and falls back to a content-free refusal', async () => {
    const ipc = fakeIpc({
      [DICTATION_MEMORY_IPC.spansCorrect]: { ok: true, count: 1 },
      [DICTATION_MEMORY_IPC.dictionaryClear]: 'garbage'
    })
    const api = createDictationMemoryPreloadApi(ipc as never).dictationMemory
    expect(await api.correctSpan(ID, 'fixed')).toEqual({ ok: true, count: 1 })
    expect(ipc.invoke).toHaveBeenCalledWith(DICTATION_MEMORY_IPC.spansCorrect, { id: ID, correctedText: 'fixed' })
    expect(await api.clearDictionary()).toEqual({ ok: false, count: 0 })
    await api.resolveRecovery(ID)
    expect(ipc.invoke).toHaveBeenCalledWith(DICTATION_MEMORY_IPC.recoveryResolve, { id: ID })
    await api.resolveRecovery(ID, 'edited')
    expect(ipc.invoke).toHaveBeenCalledWith(DICTATION_MEMORY_IPC.recoveryResolve, { id: ID, correctedText: 'edited' })
  })

  it('lists the dictionary and the correction window through the schemas', async () => {
    const entry = { id: ID, heard: 'tota', preferred: 'Toto', count: 1, updatedAtMs: 3 }
    const ipc = fakeIpc({
      [DICTATION_MEMORY_IPC.dictionaryList]: { status: 'ok', entries: [entry] },
      [DICTATION_MEMORY_IPC.spansRecent]: { spans: [{ id: ID, text: 'words', insertedAtMs: 1, expiresAtMs: 21_000 }] }
    })
    const api = createDictationMemoryPreloadApi(ipc as never).dictationMemory
    expect(await api.listDictionary()).toEqual({ status: 'ok', entries: [entry] })
    expect((await api.recentSpans()).spans).toHaveLength(1)
    expect(
      await createDictationMemoryPreloadApi(
        fakeIpc({ [DICTATION_MEMORY_IPC.dictionaryList]: 'x' }) as never
      ).dictationMemory.listDictionary()
    ).toEqual({ status: 'unavailable', entries: [] })
    expect(await createDictationMemoryPreloadApi(fakeIpc() as never).dictationMemory.recentSpans()).toEqual({
      spans: []
    })
  })
})
