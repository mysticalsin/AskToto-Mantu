import { describe, expect, it, vi } from 'vitest'
import { CONVERSATION_IPC } from '../shared/conversations'
import { createConversationsPreloadApi } from './conversations'

const CID = `c_${'a'.repeat(32)}`
const TID = `t_${'b'.repeat(32)}`

describe('conversations preload bridge (G49)', () => {
  it('forwards each call on its channel with only the typed payload', async () => {
    const invoke = vi.fn(async (...args: unknown[]) => {
      void args
      return { ok: false, reason: 'signed-out' }
    })
    const { conversations } = createConversationsPreloadApi({ invoke } as never)
    await conversations.list()
    await conversations.open('sys-general')
    await conversations.open('sys-general', 'm.md')
    await conversations.history(CID, { before: 's9', limit: 12 })
    await conversations.append({
      conversationId: CID,
      assistantId: 'sys-general',
      runId: 'r1',
      turns: [{ role: 'user', text: 'q' }]
    })
    await conversations.draftGet(CID)
    await conversations.draftSet(CID, 'draft')
    await conversations.setAnchor(CID, TID)
    expect(invoke.mock.calls.map((c) => c[0])).toEqual([
      CONVERSATION_IPC.list,
      CONVERSATION_IPC.open,
      CONVERSATION_IPC.open,
      CONVERSATION_IPC.history,
      CONVERSATION_IPC.append,
      CONVERSATION_IPC.draftGet,
      CONVERSATION_IPC.draftSet,
      CONVERSATION_IPC.setAnchor
    ])
    expect(invoke.mock.calls[1]![1]).toEqual({ assistantId: 'sys-general' })
    expect(invoke.mock.calls[2]![1]).toEqual({ assistantId: 'sys-general', meetingFile: 'm.md' })
    expect(invoke.mock.calls[3]![1]).toEqual({ conversationId: CID, before: 's9', limit: 12 })
    expect(invoke.mock.calls[6]![1]).toEqual({ conversationId: CID, text: 'draft' })
  })

  it('replaces a malformed or key-bearing reply, or a thrown call, with a content-free refusal', async () => {
    const leaky = {
      ok: true,
      conversations: [
        {
          id: CID,
          assistantId: 'sys-general',
          status: 'live',
          deadReason: null,
          linkedFrom: null,
          supersededBy: null,
          updatedAt: 1,
          turnCount: 0,
          ownerKey: 'a'.repeat(64)
        }
      ]
    }
    const unavailable = { ok: false, reason: 'unavailable' }
    expect(await createConversationsPreloadApi({ invoke: async () => leaky } as never).conversations.list()).toEqual(
      unavailable
    )
    expect(
      await createConversationsPreloadApi({ invoke: async () => 'nope' } as never).conversations.draftGet(CID)
    ).toEqual(unavailable)
    const boom = async () => {
      throw new Error('private detail')
    }
    expect(
      await createConversationsPreloadApi({ invoke: boom } as never).conversations.history(CID, { limit: 1 })
    ).toEqual(unavailable)
  })

  it('passes a well-formed reply through', async () => {
    const reply = { ok: true, text: 'draft', updatedAt: 5 }
    expect(
      await createConversationsPreloadApi({ invoke: async () => reply } as never).conversations.draftGet(CID)
    ).toEqual(reply)
  })
})
