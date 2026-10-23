import { describe, expect, it, vi } from 'vitest'
import { ASSISTANT_IPC } from '@shared/assistants'
import { registerAssistantsIpc } from './assistants-ipc'
import { SenderRefusal, type AuthorizeSender } from './sender-auth'
import { harness } from '../features/assistants/__fixtures__/assistant-harness'

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
  const propose = vi.spyOn(service, 'propose')
  registerAssistantsIpc({
    ipcMain: { handle: (channel: string, fn: never) => void handlers.set(channel, fn) },
    authorizeSender,
    requireAuth: () => options.signedIn ?? true,
    service
  })
  return {
    h,
    service,
    propose,
    surfaces,
    call: (channel: string, raw?: unknown) => handlers.get(channel)!({}, raw),
    handlers
  }
}

const DRAFT = { name: 'Coach', base: 'sales', instructions: '' }

describe('assistants IPC (G48)', () => {
  it('registers exactly the six channels, each behind the main-window top-frame sender gate', async () => {
    const t = setup()
    expect([...t.handlers.keys()].sort()).toEqual(Object.values(ASSISTANT_IPC).sort())
    for (const channel of Object.values(ASSISTANT_IPC)) await t.call(channel, {})
    expect(t.surfaces).toHaveLength(6)
    for (const s of t.surfaces) expect(s).toMatchObject({ requireOwner: true, allowedFrames: 'main-window-top' })
  })

  it('propose is always the owner typed command and the renderer cannot say otherwise', async () => {
    const t = setup()
    const ok = await t.call(ASSISTANT_IPC.propose, { drafts: [DRAFT] })
    expect(ok).toMatchObject({ ok: true })
    expect(t.propose.mock.calls[0]![0]).toMatchObject({ origin: 'user-typed', authority: 'instruction' })
    expect(await t.call(ASSISTANT_IPC.propose, { drafts: [DRAFT], origin: 'user-typed' })).toEqual({
      ok: false,
      reason: 'invalid'
    })
    expect(await t.call(ASSISTANT_IPC.propose, { drafts: [{ ...DRAFT, ownerKey: 'a'.repeat(64) }] })).toEqual({
      ok: false,
      reason: 'invalid'
    })
    expect(await t.call(ASSISTANT_IPC.propose, 'drafts')).toEqual({ ok: false, reason: 'invalid' })
  })

  it('full path: propose, confirm, list, update, archive, and a malformed payload is invalid', async () => {
    const t = setup()
    const proposal = (await t.call(ASSISTANT_IPC.propose, { drafts: [DRAFT] })) as {
      proposalId: string
      previewHash: string
    }
    expect(await t.call(ASSISTANT_IPC.confirm, { proposalId: proposal.proposalId })).toEqual({
      ok: false,
      reason: 'invalid'
    })
    const confirmed = (await t.call(ASSISTANT_IPC.confirm, {
      proposalId: proposal.proposalId,
      previewHash: proposal.previewHash
    })) as {
      ok: true
      assistants: Array<{ assistant: { assistantId: string } }>
    }
    const id = confirmed.assistants[0]!.assistant.assistantId
    expect(await t.call(ASSISTANT_IPC.update, { assistantId: id, expectedRevision: 1, name: 'Renamed' })).toMatchObject(
      {
        ok: true,
        assistant: { revision: 2 }
      }
    )
    expect(await t.call(ASSISTANT_IPC.update, { assistantId: id, expectedRevision: 1 })).toEqual({
      ok: false,
      reason: 'invalid'
    })
    expect(await t.call(ASSISTANT_IPC.archive, { assistantId: id, expectedRevision: 2, archived: true })).toMatchObject(
      { ok: true }
    )
    const listed = (await t.call(ASSISTANT_IPC.list)) as { ok: true; assistants: unknown[] }
    expect(listed.assistants).toHaveLength(10)
    expect(JSON.stringify(listed)).not.toMatch(/[0-9a-f]{64}/)
  })

  it('answers a signed-out caller with a typed refusal and never reaches the service', async () => {
    const t = setup({ signedIn: false })
    expect(await t.call(ASSISTANT_IPC.list)).toEqual({ ok: false, reason: 'signed-out' })
    expect(await t.call(ASSISTANT_IPC.propose, { drafts: [DRAFT] })).toEqual({ ok: false, reason: 'signed-out' })
    expect(await t.call(ASSISTANT_IPC.historyMap)).toEqual({ ok: false, reason: 'signed-out' })
    expect(t.propose).not.toHaveBeenCalled()
  })

  it('rejects payloads on methods that take no arguments', async () => {
    const t = setup()
    expect(await t.call(ASSISTANT_IPC.list, {})).toEqual({ ok: false, reason: 'invalid' })
    expect(await t.call(ASSISTANT_IPC.historyMap, { ownerKey: 'a'.repeat(64) })).toEqual({
      ok: false,
      reason: 'invalid'
    })
  })

  it('a sender the gate refuses gets no handler result', async () => {
    const t = setup({ refuse: true })
    await expect(t.call(ASSISTANT_IPC.list)).rejects.toBeInstanceOf(SenderRefusal)
    await expect(t.call(ASSISTANT_IPC.propose, { drafts: [DRAFT] })).rejects.toBeInstanceOf(SenderRefusal)
  })

  it('history map returns the meeting ids unchanged', async () => {
    const t = setup()
    t.h.meetings.push({ file: 'meeting-1.md', mode: 'sales' })
    expect(await t.call(ASSISTANT_IPC.historyMap)).toMatchObject({
      ok: true,
      mapping: [{ meetingId: 'meeting-1.md', assistantId: 'sys-sales', exact: true }]
    })
  })
})
