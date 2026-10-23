import { describe, expect, it, vi } from 'vitest'
import { ASSISTANT_IPC } from '../shared/assistants'
import { createAssistantsPreloadApi } from './assistants'

describe('assistants preload bridge (G48)', () => {
  it('forwards each call on its channel with only the typed payload', async () => {
    const invoke = vi.fn(async (...args: unknown[]) => {
      void args
      return { ok: false, reason: 'signed-out' }
    })
    const { assistants } = createAssistantsPreloadApi({ invoke } as never)
    await assistants.list()
    await assistants.propose([{ name: 'A', base: 'sales', instructions: '' }])
    await assistants.confirm('a'.repeat(32), 'b'.repeat(64))
    await assistants.update({ assistantId: 'sys-sales', expectedRevision: 1, name: 'n', base: 'support' })
    await assistants.archive('sys-sales', 1, true)
    await assistants.historyMap()
    expect(invoke.mock.calls.map((c) => c[0])).toEqual([
      ASSISTANT_IPC.list,
      ASSISTANT_IPC.propose,
      ASSISTANT_IPC.confirm,
      ASSISTANT_IPC.update,
      ASSISTANT_IPC.archive,
      ASSISTANT_IPC.historyMap
    ])
    expect(invoke.mock.calls[1]![1]).toEqual({ drafts: [{ name: 'A', base: 'sales', instructions: '' }] })
    expect(invoke.mock.calls[2]![1]).toEqual({ proposalId: 'a'.repeat(32), previewHash: 'b'.repeat(64) })
    expect(invoke.mock.calls[3]![1]).toEqual({
      assistantId: 'sys-sales',
      expectedRevision: 1,
      name: 'n',
      base: 'support'
    })
  })

  it('replaces a malformed or key-bearing reply with a content-free refusal', async () => {
    const leaky = {
      ok: true,
      assistants: [
        {
          assistantId: 'sys-sales',
          name: 'Sales',
          base: 'sales',
          instructions: '',
          createdAt: 0,
          updatedAt: 0,
          revision: 1,
          archived: false,
          system: true,
          ownerKey: 'a'.repeat(64)
        }
      ]
    }
    const { assistants } = createAssistantsPreloadApi({ invoke: vi.fn(async () => leaky) } as never)
    expect(await assistants.list()).toEqual({ ok: false, reason: 'unavailable' })
    const garbage = createAssistantsPreloadApi({ invoke: vi.fn(async () => 'nope') } as never).assistants
    expect(await garbage.propose([])).toEqual({ ok: false, reason: 'unavailable' })
    expect(await garbage.confirm('a'.repeat(32), 'b'.repeat(64))).toEqual({ ok: false, reason: 'unavailable' })
    expect(await garbage.archive('sys-sales', 1, true)).toEqual({ ok: false, reason: 'unavailable' })
    expect(await garbage.historyMap()).toEqual({ ok: false, reason: 'unavailable' })
  })
})
