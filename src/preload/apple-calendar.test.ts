import { describe, expect, it, vi } from 'vitest'
import { APPLE_CALENDAR_IPC } from '../shared/apple-calendar'
import { createAppleCalendarPreloadApi } from './apple-calendar'

const REQUEST = { subject: 'Follow-up', startIso: '2026-10-25T10:00:00Z', endIso: '2026-10-25T10:30:00Z' }
const fake = (reply: unknown) => ({ invoke: vi.fn(async () => reply) })

describe('appleCalendar preload bridge (G65c)', () => {
  it('exposes status, requestAccess and create only', () => {
    expect(Object.keys(createAppleCalendarPreloadApi(fake(undefined)).appleCalendar).sort()).toEqual([
      'create',
      'requestAccess',
      'status'
    ])
  })

  it('status calls only the status channel, so it can never prompt', async () => {
    const ipc = fake({ available: true, permission: 'notDetermined' })
    expect(await createAppleCalendarPreloadApi(ipc).appleCalendar.status()).toEqual({
      available: true,
      permission: 'notDetermined'
    })
    expect(ipc.invoke).toHaveBeenCalledOnce()
    expect(ipc.invoke).toHaveBeenCalledWith(APPLE_CALENDAR_IPC.status)
  })

  it('requestAccess calls the ask channel', async () => {
    const ipc = fake({ available: true, permission: 'fullAccess' })
    await createAppleCalendarPreloadApi(ipc).appleCalendar.requestAccess()
    expect(ipc.invoke).toHaveBeenCalledWith(APPLE_CALENDAR_IPC.ask)
  })

  it('drops a malformed reply and a malformed request', async () => {
    const bad = fake({ available: 'yes' })
    expect(await createAppleCalendarPreloadApi(bad).appleCalendar.status()).toEqual({ available: false })
    const ipc = fake({ ok: true })
    const api = createAppleCalendarPreloadApi(ipc).appleCalendar
    expect(await api.create({ ...REQUEST, body: 'x' } as never)).toMatchObject({ ok: false })
    expect(ipc.invoke).not.toHaveBeenCalled()
    expect(await api.create(REQUEST)).toEqual({ ok: true })
  })
})
