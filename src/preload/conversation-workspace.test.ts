import { describe, expect, it, vi } from 'vitest'
import { WORKSPACE_IPC } from '../shared/conversation-workspace'
import { createConversationWorkspacePreloadApi } from './conversation-workspace'

const CID = `c_${'a'.repeat(32)}`
const TID = `t_${'b'.repeat(32)}`

describe('workspace preload bridge (G50)', () => {
  it('forwards each call on its channel with only the typed payload', async () => {
    const invoke = vi.fn(async (...args: unknown[]) => {
      void args
      return { ok: false, reason: 'signed-out' }
    })
    const { workspace } = createConversationWorkspacePreloadApi({ invoke } as never)
    await workspace.get()
    await workspace.select(CID)
    await workspace.select(null)
    await workspace.markRead(CID, TID)
    await workspace.markUnread(CID)
    await workspace.setArchived(CID, true)
    await workspace.setPinned('assistant', 'sys-general', true)
    await workspace.search('needle', { limit: 7 })
    await workspace.search('needle', { limit: 7, includeArchived: false })
    expect(invoke.mock.calls.map((c) => c[0])).toEqual([
      WORKSPACE_IPC.get,
      WORKSPACE_IPC.select,
      WORKSPACE_IPC.select,
      WORKSPACE_IPC.markRead,
      WORKSPACE_IPC.markUnread,
      WORKSPACE_IPC.setArchived,
      WORKSPACE_IPC.setPinned,
      WORKSPACE_IPC.search,
      WORKSPACE_IPC.search
    ])
    expect(invoke.mock.calls[2]![1]).toEqual({ conversationId: null })
    expect(invoke.mock.calls[3]![1]).toEqual({ conversationId: CID, throughTurnId: TID })
    expect(invoke.mock.calls[6]![1]).toEqual({ kind: 'assistant', id: 'sys-general', pinned: true })
    expect(invoke.mock.calls[7]![1]).toEqual({ query: 'needle', limit: 7 })
    expect(invoke.mock.calls[8]![1]).toEqual({ query: 'needle', limit: 7, includeArchived: false })
  })

  it('reply carrying ownerKey is dropped to unavailable', async () => {
    const leaky = {
      ok: true,
      rev: 1,
      selectedConversationId: null,
      counts: { unreadConversations: 0, readConversations: 0, archivedConversations: 0 },
      items: [],
      pinnedAssistantIds: [],
      ownerKey: 'a'.repeat(64)
    }
    const { workspace } = createConversationWorkspacePreloadApi({ invoke: async () => leaky } as never)
    expect(await workspace.get()).toEqual({ ok: false, reason: 'unavailable' })
    const withSeq = createConversationWorkspacePreloadApi({
      invoke: async () => ({
        ok: true,
        hits: [{ conversationId: CID, label: 'active', turnId: null, snippet: null, matched: 'turn', seq: 1 }],
        truncated: false
      })
    } as never)
    expect(await withSeq.workspace.search('ab', { limit: 5 })).toEqual({ ok: false, reason: 'unavailable' })
  })

  it('invoke rejection maps to unavailable', async () => {
    const { workspace } = createConversationWorkspacePreloadApi({
      invoke: async () => {
        throw new Error('private detail')
      }
    } as never)
    expect(await workspace.select(CID)).toEqual({ ok: false, reason: 'unavailable' })
  })

  it('passes a well-formed reply through', async () => {
    const reply = { ok: true, rev: 4 }
    const { workspace } = createConversationWorkspacePreloadApi({ invoke: async () => reply } as never)
    expect(await workspace.markUnread(CID)).toEqual(reply)
  })
})
