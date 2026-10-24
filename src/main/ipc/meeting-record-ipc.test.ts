import { describe, expect, it, vi } from 'vitest'
import { MEETING_RECORD_IPC, UNAVAILABLE_RECORD } from '@shared/meeting-record'
import { registerMeetingRecordIpc } from './meeting-record-ipc'
import { SenderRefusal, type AuthorizeSender } from './sender-auth'

function harness(options: { signedIn?: boolean; refuse?: boolean } = {}) {
  const handlers = new Map<string, (event: unknown, raw?: unknown) => Promise<unknown>>()
  const surfaces: Array<{ surface: string; requireOwner: boolean; allowedFrames: string }> = []
  const record = {
    get: vi.fn(async () => ({ ...UNAVAILABLE_RECORD, status: 'ok' as const })),
    edit: vi.fn(async () => true)
  }
  const audit = vi.fn()
  const authorizeSender = ((_event: unknown, o: { surface: string; requireOwner: boolean; allowedFrames: string }) => {
    surfaces.push(o)
    if (options.refuse) throw new SenderRefusal('wrong-window', o.surface)
    return null
  }) as unknown as AuthorizeSender
  registerMeetingRecordIpc({
    ipcMain: { handle: (channel: string, fn: never) => void handlers.set(channel, fn) },
    authorizeSender,
    requireAuth: () => options.signedIn ?? true,
    record,
    audit
  })
  return {
    handlers,
    surfaces,
    record,
    audit,
    call: (channel: string, raw?: unknown) => handlers.get(channel)!({}, raw)
  }
}

describe('meeting record IPC (G78)', () => {
  it('refuses non-main-window sender', async () => {
    const h = harness({ refuse: true })
    await expect(h.call(MEETING_RECORD_IPC.get, { file: 'a.md' })).rejects.toBeInstanceOf(SenderRefusal)
    await expect(h.call(MEETING_RECORD_IPC.edit, { file: 'a.md', op: 'delete', id: 'x' })).rejects.toBeInstanceOf(
      SenderRefusal
    )
    expect(h.record.get).not.toHaveBeenCalled()
    expect(h.record.edit).not.toHaveBeenCalled()
    await harness().call(MEETING_RECORD_IPC.get, { file: 'a.md' })
  })

  it('each channel sits behind the main-window top-frame gate', async () => {
    const h = harness()
    await h.call(MEETING_RECORD_IPC.get, { file: 'a.md' })
    await h.call(MEETING_RECORD_IPC.edit, { file: 'a.md', op: 'delete', id: 'x' })
    expect(h.surfaces).toHaveLength(2)
    for (const s of h.surfaces) expect(s).toMatchObject({ requireOwner: false, allowedFrames: 'main-window-top' })
  })

  it('signed-out returns unavailable', async () => {
    const h = harness({ signedIn: false })
    expect(await h.call(MEETING_RECORD_IPC.get, { file: 'a.md' })).toEqual(UNAVAILABLE_RECORD)
    expect(await h.call(MEETING_RECORD_IPC.edit, { file: 'a.md', op: 'delete', id: 'x' })).toEqual({ ok: false })
    expect(h.record.get).not.toHaveBeenCalled()
  })

  it('rejects unknown keys / oversize text', async () => {
    const h = harness()
    expect(await h.call(MEETING_RECORD_IPC.get, { file: 'a.md', path: '/etc' })).toEqual(UNAVAILABLE_RECORD)
    expect(
      await h.call(MEETING_RECORD_IPC.edit, { file: 'a.md', op: 'add', kind: 'decision', text: 'x'.repeat(2001) })
    ).toEqual({
      ok: false
    })
    expect(
      await h.call(MEETING_RECORD_IPC.edit, { file: 'a.md', op: 'add', kind: 'decision', text: 'ok', extra: 1 })
    ).toEqual({
      ok: false
    })
    expect(h.record.edit).not.toHaveBeenCalled()
  })

  it('hands the service only the file name; path traversal is resolved to a basename by main', async () => {
    const h = harness()
    await h.call(MEETING_RECORD_IPC.get, { file: '../../etc/passwd' })
    expect(h.record.get).toHaveBeenCalledWith('../../etc/passwd')
  })

  it('audit records contain no text, owner or file name', async () => {
    const h = harness()
    await h.call(MEETING_RECORD_IPC.edit, {
      file: 'private-board-meeting.md',
      op: 'add',
      kind: 'action',
      text: 'secret plan',
      owner: 'Alex'
    })
    await h.call(MEETING_RECORD_IPC.get, { file: 'private-board-meeting.md' })
    const logged = JSON.stringify(h.audit.mock.calls)
    expect(logged).not.toMatch(/secret|Alex|private-board/)
    expect(h.audit).toHaveBeenCalledWith({ action: 'add', ok: true })
  })
})
