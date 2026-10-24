import { describe, expect, it, vi } from 'vitest'
import { WORKSPACE_IPC } from '@shared/conversation-workspace'
import { registerConversationWorkspaceIpc } from './conversation-workspace-ipc'
import { SenderRefusal, type AuthorizeSender } from './sender-auth'
import { harness, turn } from '../features/conversations/__fixtures__/conversation-harness'

function setup(options: { signedIn?: boolean; refuse?: boolean } = {}) {
  const h = harness()
  const service = h.newWorkspace()
  const handlers = new Map<string, (event: unknown, raw?: unknown) => Promise<unknown>>()
  const surfaces: Array<{ surface: string; requireOwner: boolean; allowedFrames: string }> = []
  const authorizeSender = ((_event: unknown, o: { surface: string; requireOwner: boolean; allowedFrames: string }) => {
    surfaces.push(o)
    if (options.refuse) throw new SenderRefusal('wrong-window', o.surface)
    return null
  }) as unknown as AuthorizeSender
  registerConversationWorkspaceIpc({
    ipcMain: { handle: (channel: string, fn: never) => void handlers.set(channel, fn) },
    authorizeSender,
    requireAuth: () => options.signedIn ?? true,
    service
  })
  return { h, service, surfaces, handlers, call: (channel: string, raw?: unknown) => handlers.get(channel)!({}, raw) }
}

describe('workspace IPC (G50)', () => {
  it('registers exactly the seven channels, each behind the main-window top-frame sender gate', async () => {
    const t = setup()
    expect([...t.handlers.keys()].sort()).toEqual(Object.values(WORKSPACE_IPC).sort())
    for (const channel of Object.values(WORKSPACE_IPC)) await t.call(channel, {})
    expect(t.surfaces.map((s) => s.surface).sort()).toEqual(
      Object.keys(WORKSPACE_IPC)
        .map((op) => `workspace.${op}`)
        .sort()
    )
    for (const s of t.surfaces) expect(s).toMatchObject({ requireOwner: true, allowedFrames: 'main-window-top' })
  })

  it('rejects non-main-window sender before any work', async () => {
    const t = setup({ refuse: true })
    const get = vi.spyOn(t.service, 'get')
    await expect(t.call(WORKSPACE_IPC.get)).rejects.toBeInstanceOf(SenderRefusal)
    expect(get).not.toHaveBeenCalled()
  })

  it('signed-out short-circuits every channel', async () => {
    const t = setup({ signedIn: false })
    for (const channel of Object.values(WORKSPACE_IPC)) {
      expect(await t.call(channel, {})).toEqual({ ok: false, reason: 'signed-out' })
    }
  })

  it('answers invalid for extra ownerKey, tenantKey or seq fields and bad shapes', async () => {
    const t = setup()
    const opened = await t.h.newService().open({ assistantId: 'sys-general' })
    if (!opened.ok) throw new Error('open failed')
    const conversationId = opened.conversation.id
    const invalid = { ok: false, reason: 'invalid' }
    expect(await t.call(WORKSPACE_IPC.select, { conversationId, ownerKey: 'a'.repeat(64) })).toEqual(invalid)
    expect(await t.call(WORKSPACE_IPC.markUnread, { conversationId, tenantKey: '1'.repeat(64) })).toEqual(invalid)
    expect(
      await t.call(WORKSPACE_IPC.markRead, { conversationId, throughTurnId: `t_${'a'.repeat(32)}`, seq: 3 })
    ).toEqual(invalid)
    expect(await t.call(WORKSPACE_IPC.setArchived, { conversationId })).toEqual(invalid)
    expect(await t.call(WORKSPACE_IPC.setPinned, { kind: 'conversation', id: 'sys-general', pinned: true })).toEqual(
      invalid
    )
    expect(await t.call(WORKSPACE_IPC.search, { query: 'x', limit: 5 })).toEqual(invalid)
    expect(await t.call(WORKSPACE_IPC.search, { query: 'abc', limit: 51 })).toEqual(invalid)
    expect(await t.call(WORKSPACE_IPC.get, { extra: 1 })).toEqual(invalid)
  })

  it('serves a valid round trip and turns a throwing service into unavailable', async () => {
    const t = setup()
    const opened = await t.h.newService().open({ assistantId: 'sys-general' })
    if (!opened.ok) throw new Error('open failed')
    const conversationId = opened.conversation.id
    await t.h
      .newService()
      .append({ conversationId, assistantId: 'sys-general', runId: 'r1', turns: [turn('user', 'hi')] })
    expect(await t.call(WORKSPACE_IPC.select, { conversationId })).toMatchObject({ ok: true, rev: 1 })
    expect(await t.call(WORKSPACE_IPC.get)).toMatchObject({ ok: true, selectedConversationId: conversationId })
    expect(await t.call(WORKSPACE_IPC.search, { query: 'hi', limit: 5 })).toMatchObject({ ok: true })
    vi.spyOn(t.service, 'get').mockRejectedValueOnce(new Error('private detail'))
    expect(await t.call(WORKSPACE_IPC.get)).toEqual({ ok: false, reason: 'unavailable' })
  })
})
