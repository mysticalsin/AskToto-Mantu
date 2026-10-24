import { describe, expect, it, vi } from 'vitest'
import { CONVERSATION_IPC } from '@shared/conversations'
import { registerConversationsIpc } from './conversations-ipc'
import { SenderRefusal, type AuthorizeSender } from './sender-auth'
import { harness, turn } from '../features/conversations/__fixtures__/conversation-harness'

function setup(options: { signedIn?: boolean; refuse?: boolean } = {}) {
  const h = harness()
  const service = h.newService()
  const handlers = new Map<string, (event: unknown, raw?: unknown) => Promise<unknown>>()
  const surfaces: Array<{ surface: string; requireOwner: boolean; allowedFrames: string }> = []
  const authorizeSender = ((_event: unknown, o: { surface: string; requireOwner: boolean; allowedFrames: string }) => {
    surfaces.push(o)
    if (options.refuse) throw new SenderRefusal('wrong-window', o.surface)
    return null
  }) as unknown as AuthorizeSender
  registerConversationsIpc({
    ipcMain: { handle: (channel: string, fn: never) => void handlers.set(channel, fn) },
    authorizeSender,
    requireAuth: () => options.signedIn ?? true,
    service
  })
  return { h, service, surfaces, handlers, call: (channel: string, raw?: unknown) => handlers.get(channel)!({}, raw) }
}

describe('conversations IPC (G49)', () => {
  it('registers exactly the seven channels, each behind the main-window top-frame sender gate', async () => {
    const t = setup()
    expect([...t.handlers.keys()].sort()).toEqual(Object.values(CONVERSATION_IPC).sort())
    for (const channel of Object.values(CONVERSATION_IPC)) await t.call(channel, {})
    expect(t.surfaces).toHaveLength(7)
    for (const s of t.surfaces) expect(s).toMatchObject({ requireOwner: true, allowedFrames: 'main-window-top' })
  })

  it('refuses a sender the gate refuses, before any work', async () => {
    const t = setup({ refuse: true })
    const list = vi.spyOn(t.service, 'list')
    await expect(t.call(CONVERSATION_IPC.list)).rejects.toBeInstanceOf(SenderRefusal)
    expect(list).not.toHaveBeenCalled()
  })

  it('answers signed-out when the person is not signed in', async () => {
    const t = setup({ signedIn: false })
    for (const channel of Object.values(CONVERSATION_IPC)) {
      expect(await t.call(channel, {})).toEqual({ ok: false, reason: 'signed-out' })
    }
  })

  it('answers invalid for unknown keys, oversize text, bad cursors and both cursors at once', async () => {
    const t = setup()
    const opened = (await t.call(CONVERSATION_IPC.open, { assistantId: 'sys-general' })) as {
      conversation: { id: string }
    }
    const conversationId = opened.conversation.id
    const invalid = { ok: false, reason: 'invalid' }
    expect(await t.call(CONVERSATION_IPC.open, { assistantId: 'sys-general', ownerKey: 'a'.repeat(64) })).toEqual(
      invalid
    )
    expect(await t.call(CONVERSATION_IPC.history, { conversationId, limit: 5, seq: 3 })).toEqual(invalid)
    expect(await t.call(CONVERSATION_IPC.history, { conversationId, limit: 5, before: 's0' })).toEqual(invalid)
    expect(await t.call(CONVERSATION_IPC.history, { conversationId, limit: 51 })).toEqual(invalid)
    expect(await t.call(CONVERSATION_IPC.history, { conversationId, limit: 5, before: 's3', after: 's1' })).toEqual(
      invalid
    )
    expect(await t.call(CONVERSATION_IPC.draftSet, { conversationId, text: 'x'.repeat(8001) })).toEqual(invalid)
    expect(await t.call(CONVERSATION_IPC.list, { extra: 1 })).toEqual(invalid)
    expect(
      await t.call(CONVERSATION_IPC.append, {
        conversationId,
        assistantId: 'sys-general',
        runId: 'bad id',
        turns: [turn('user', 'x')]
      })
    ).toEqual(invalid)
    expect(
      await t.call(CONVERSATION_IPC.append, { conversationId, assistantId: 'sys-general', runId: 'r', turns: [] })
    ).toEqual(invalid)
  })

  it('serves a valid round trip and turns a throwing service into unavailable', async () => {
    const t = setup()
    const opened = (await t.call(CONVERSATION_IPC.open, { assistantId: 'sys-general' })) as {
      conversation: { id: string }
    }
    const conversationId = opened.conversation.id
    expect(
      await t.call(CONVERSATION_IPC.append, {
        conversationId,
        assistantId: 'sys-general',
        runId: 'r1',
        turns: [turn('user', 'hi')]
      })
    ).toMatchObject({ ok: true, lastSeq: 1 })
    expect(await t.call(CONVERSATION_IPC.history, { conversationId, limit: 5 })).toMatchObject({
      ok: true,
      latestSeq: 1
    })
    vi.spyOn(t.service, 'list').mockRejectedValueOnce(new Error('private detail'))
    expect(await t.call(CONVERSATION_IPC.list)).toEqual({ ok: false, reason: 'unavailable' })
  })
})
