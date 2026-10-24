import { describe, expect, it, vi } from 'vitest'
import { SUGGESTION_IPC } from '@shared/suggestions'
import { registerSuggestionsIpc } from './suggestions-ipc'
import { SenderRefusal, type AuthorizeSender } from './sender-auth'

const REF = { id: 'a'.repeat(24), revision: 1, nonce: 'b'.repeat(32) }

function setup(options: { signedIn?: boolean; refuse?: boolean; throwing?: boolean } = {}) {
  const handlers = new Map<string, (event: unknown, raw?: unknown) => Promise<unknown>>()
  const surfaces: Array<{ surface: string; requireOwner: boolean; allowedFrames: string }> = []
  const authorizeSender = ((_event: unknown, o: { surface: string; requireOwner: boolean; allowedFrames: string }) => {
    surfaces.push(o)
    if (options.refuse) throw new SenderRefusal('wrong-window', o.surface)
    return null
  }) as unknown as AuthorizeSender
  const reply = options.throwing
    ? vi.fn(async (..._args: unknown[]): Promise<unknown> => {
        throw new Error('internal detail')
      })
    : vi.fn(async (..._args: unknown[]): Promise<unknown> => ({ ok: true }))
  const service = {
    list: reply,
    checkNow: reply,
    shown: reply,
    accept: reply,
    dismiss: reply,
    adjust: reply
  }
  registerSuggestionsIpc({
    ipcMain: { handle: (channel: string, fn: never) => void handlers.set(channel, fn) },
    authorizeSender,
    requireAuth: () => options.signedIn ?? true,
    service: service as never
  })
  return { reply, surfaces, handlers, call: (channel: string, raw?: unknown) => handlers.get(channel)!({}, raw) }
}

describe('suggestions IPC (G67)', () => {
  it('registers exactly the six channels, each behind the main-window top-frame owner gate', async () => {
    const t = setup()
    expect([...t.handlers.keys()].sort()).toEqual(Object.values(SUGGESTION_IPC).sort())
    for (const channel of Object.values(SUGGESTION_IPC)) await t.call(channel, {})
    expect(t.surfaces).toHaveLength(6)
    for (const s of t.surfaces) expect(s).toMatchObject({ requireOwner: true, allowedFrames: 'main-window-top' })
  })

  it('a non-main-window sender is refused', async () => {
    const t = setup({ refuse: true })
    await expect(t.call(SUGGESTION_IPC.list)).rejects.toBeInstanceOf(SenderRefusal)
    await expect(t.call(SUGGESTION_IPC.accept, REF)).rejects.toBeInstanceOf(SenderRefusal)
    expect(t.reply).not.toHaveBeenCalled()
  })

  it('signed out returns signed-out and reaches no service method', async () => {
    const t = setup({ signedIn: false })
    for (const channel of Object.values(SUGGESTION_IPC)) {
      expect(await t.call(channel, REF)).toEqual({ ok: false, reason: 'signed-out' })
    }
    expect(t.reply).not.toHaveBeenCalled()
  })

  it('unknown keys, an owner key, an account ref and bad shapes are invalid', async () => {
    const t = setup()
    expect(await t.call(SUGGESTION_IPC.accept, { ...REF, ownerKey: 'a'.repeat(64) })).toEqual({
      ok: false,
      reason: 'invalid'
    })
    expect(await t.call(SUGGESTION_IPC.accept, { ...REF, accountRef: 'acct_x' })).toEqual({
      ok: false,
      reason: 'invalid'
    })
    expect(await t.call(SUGGESTION_IPC.accept, { ...REF, revision: 0 })).toEqual({ ok: false, reason: 'invalid' })
    expect(await t.call(SUGGESTION_IPC.dismiss, { ...REF, reason: 'because' })).toEqual({
      ok: false,
      reason: 'invalid'
    })
    expect(await t.call(SUGGESTION_IPC.dismiss, REF)).toEqual({ ok: false, reason: 'invalid' })
    expect(await t.call(SUGGESTION_IPC.list, { anything: 1 })).toEqual({ ok: false, reason: 'invalid' })
    expect(await t.call(SUGGESTION_IPC.checkNow, 'now')).toEqual({ ok: false, reason: 'invalid' })
    expect(await t.call(SUGGESTION_IPC.adjust, { ...REF, action: 'draft' })).toEqual({ ok: false, reason: 'invalid' })
    expect(t.reply).not.toHaveBeenCalled()
  })

  it('passes validated requests through unchanged', async () => {
    const t = setup()
    await t.call(SUGGESTION_IPC.list)
    await t.call(SUGGESTION_IPC.checkNow)
    await t.call(SUGGESTION_IPC.shown, REF)
    await t.call(SUGGESTION_IPC.dismiss, { ...REF, reason: 'wrong' })
    await t.call(SUGGESTION_IPC.adjust, { ...REF, action: 'draft', title: 'Prep' })
    expect(t.reply.mock.calls.map((c) => c[0])).toEqual([
      undefined,
      undefined,
      REF,
      { ...REF, reason: 'wrong' },
      { ...REF, action: 'draft', title: 'Prep' }
    ])
  })

  it('unexpected errors settle into typed refusals with no detail', async () => {
    const t = setup({ throwing: true })
    for (const channel of Object.values(SUGGESTION_IPC)) {
      const out = await t.call(
        channel,
        channel === SUGGESTION_IPC.dismiss
          ? { ...REF, reason: 'wrong' }
          : channel === SUGGESTION_IPC.adjust
            ? { ...REF, action: 'cancel' }
            : channel === SUGGESTION_IPC.list || channel === SUGGESTION_IPC.checkNow
              ? undefined
              : REF
      )
      expect(out).toEqual({ ok: false, reason: 'unavailable' })
    }
  })
})
