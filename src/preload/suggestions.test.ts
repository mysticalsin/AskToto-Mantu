import { describe, expect, it, vi } from 'vitest'
import { SUGGESTION_IPC } from '../shared/suggestions'
import { createSuggestionsPreloadApi } from './suggestions'

const REF = { id: 'a'.repeat(24), revision: 1, nonce: 'b'.repeat(32) }

describe('suggestions preload bridge (G67)', () => {
  it('exposes only the six channels, forwarding only the typed payload', async () => {
    const invoke = vi.fn(async (...args: unknown[]) => {
      void args
      return { ok: false, reason: 'signed-out' }
    })
    const { suggestions } = createSuggestionsPreloadApi({ invoke } as never)
    expect(Object.keys(suggestions).sort()).toEqual(['accept', 'adjust', 'checkNow', 'dismiss', 'list', 'shown'])
    await suggestions.list()
    await suggestions.checkNow()
    await suggestions.shown(REF)
    await suggestions.accept(REF)
    await suggestions.dismiss(REF, 'not_useful')
    await suggestions.adjust({ ...REF, action: 'draft', title: 'Prep' })
    expect(invoke.mock.calls.map((c) => c[0])).toEqual([
      SUGGESTION_IPC.list,
      SUGGESTION_IPC.checkNow,
      SUGGESTION_IPC.shown,
      SUGGESTION_IPC.accept,
      SUGGESTION_IPC.dismiss,
      SUGGESTION_IPC.adjust
    ])
    expect(invoke.mock.calls[4]![1]).toEqual({ ...REF, reason: 'not_useful' })
  })

  it('replaces a malformed or key-bearing reply with a content-free refusal', async () => {
    const leaky = { ok: true, cards: [], lastShownId: null, activeRun: null, lastRun: null, ownerKey: 'a'.repeat(64) }
    const { suggestions } = createSuggestionsPreloadApi({ invoke: vi.fn(async () => leaky) } as never)
    expect(await suggestions.list()).toEqual({ ok: false, reason: 'unavailable' })
    const { suggestions: boom } = createSuggestionsPreloadApi({
      invoke: vi.fn(async () => {
        throw new Error('detail')
      })
    } as never)
    expect(await boom.accept(REF)).toEqual({ ok: false, reason: 'unavailable' })
  })

  it('accepts a well-formed list reply', async () => {
    const reply = { ok: true, cards: [], lastShownId: null, activeRun: null, lastRun: null }
    const { suggestions } = createSuggestionsPreloadApi({ invoke: vi.fn(async () => reply) } as never)
    expect(await suggestions.list()).toEqual(reply)
  })
})
