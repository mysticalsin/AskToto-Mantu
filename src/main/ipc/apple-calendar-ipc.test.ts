import { describe, expect, it, vi } from 'vitest'
import { APPLE_CALENDAR_IPC } from '@shared/apple-calendar'
import { registerAppleCalendarIpc } from './apple-calendar-ipc'

type Handler = (event: unknown, payload?: unknown) => unknown
const REQUEST = { subject: 'Follow-up', startIso: '2026-10-25T10:00:00Z', endIso: '2026-10-25T10:30:00Z' }

function setup(
  over: { auth?: boolean; reject?: boolean; platform?: NodeJS.Platform; status?: string | null; create?: unknown } = {}
) {
  const handlers = new Map<string, Handler>()
  const ipcMain = { handle: vi.fn((channel: string, h: Handler) => handlers.set(channel, h)) }
  const assertMainWindow = vi.fn(() => {
    if (over.reject) throw new Error('not the main window')
  })
  const eventKit = {
    status: vi.fn(async () => (over.status === undefined ? 'fullAccess' : over.status)),
    ask: vi.fn(async () => 'fullAccess')
  }
  const create = vi.fn(async () => over.create ?? { ok: true, result: { ok: true } })
  registerAppleCalendarIpc(ipcMain as never, {
    assertMainWindow,
    requireAuth: () => over.auth ?? true,
    platform: over.platform ?? 'darwin',
    eventKit: eventKit as never,
    create: create as never
  })
  const invoke = (channel: string, payload?: unknown, senderId = 7) =>
    handlers.get(channel)?.({ sender: { id: senderId } }, payload)
  return { invoke, assertMainWindow, eventKit, create }
}

describe('Apple Calendar IPC (G65c)', () => {
  it('rejects a non-main window on every channel', async () => {
    const s = setup({ reject: true })
    for (const channel of Object.values(APPLE_CALENDAR_IPC))
      await expect(Promise.resolve().then(() => s.invoke(channel, REQUEST))).rejects.toThrow('not the main window')
    expect(s.create).not.toHaveBeenCalled()
    expect(s.eventKit.status).not.toHaveBeenCalled()
  })

  it('status reads the permission and never prompts', async () => {
    const s = setup({ status: 'denied' })
    expect(await s.invoke(APPLE_CALENDAR_IPC.status)).toEqual({ available: true, permission: 'denied' })
    expect(s.eventKit.ask).not.toHaveBeenCalled()
  })

  it('is unavailable off macOS, when signed out, or when the helper is missing', async () => {
    expect(await setup({ platform: 'win32' }).invoke(APPLE_CALENDAR_IPC.status)).toEqual({ available: false })
    expect(await setup({ auth: false }).invoke(APPLE_CALENDAR_IPC.status)).toEqual({ available: false })
    expect(await setup({ status: null }).invoke(APPLE_CALENDAR_IPC.status)).toEqual({ available: false })
  })

  it('ask raises the prompt only while the system has not asked yet', async () => {
    const fresh = setup({ status: 'notDetermined' })
    expect(await fresh.invoke(APPLE_CALENDAR_IPC.ask)).toEqual({ available: true, permission: 'fullAccess' })
    expect(fresh.eventKit.ask).toHaveBeenCalledOnce()
    const denied = setup({ status: 'denied' })
    expect(await denied.invoke(APPLE_CALENDAR_IPC.ask)).toEqual({ available: true, permission: 'denied' })
    expect(denied.eventKit.ask).not.toHaveBeenCalled()
    const signedOut = setup({ auth: false, status: 'notDetermined' })
    expect(await signedOut.invoke(APPLE_CALENDAR_IPC.ask)).toEqual({ available: false })
    expect(signedOut.eventKit.ask).not.toHaveBeenCalled()
  })

  it('create takes the owner window from the sender and runs the connector write', async () => {
    const s = setup()
    expect(await s.invoke(APPLE_CALENDAR_IPC.create, REQUEST, 9)).toEqual({ ok: true })
    expect(s.create).toHaveBeenCalledWith({ ...REQUEST, body: '' }, 9)
  })

  it('create refuses malformed input, extra fields and signed-out callers before any write', async () => {
    const s = setup()
    expect(await s.invoke(APPLE_CALENDAR_IPC.create, { ...REQUEST, body: 'x' })).toMatchObject({ ok: false })
    expect(await s.invoke(APPLE_CALENDAR_IPC.create, { subject: 'x' })).toMatchObject({ ok: false })
    const out = setup({ auth: false })
    expect(await out.invoke(APPLE_CALENDAR_IPC.create, REQUEST)).toMatchObject({ ok: false })
    expect(s.create).not.toHaveBeenCalled()
    expect(out.create).not.toHaveBeenCalled()
  })

  it('surfaces the typed permission refusal and the uncertain flag, nothing else', async () => {
    const denied = setup({
      create: {
        ok: false,
        error: 'x',
        result: { ok: false, reason: 'os_permission_missing', permission: 'denied', message: 'm' }
      }
    })
    expect(await denied.invoke(APPLE_CALENDAR_IPC.create, REQUEST)).toEqual({
      ok: false,
      error: expect.stringContaining('System Settings'),
      permission: 'denied'
    })
    const unsure = setup({
      create: {
        ok: false,
        uncertain: true,
        error: 'Could not confirm.',
        result: { ok: false, reason: 'effect_uncertain' }
      }
    })
    expect(await unsure.invoke(APPLE_CALENDAR_IPC.create, REQUEST)).toEqual({
      ok: false,
      error: 'Could not confirm.',
      uncertain: true
    })
  })
})
