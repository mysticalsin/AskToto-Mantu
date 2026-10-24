import { describe, expect, it, vi } from 'vitest'
import type { EventKitHost } from '../../infra/process/eventkit-helper-host'
import { createAppleEventCreateHandler } from './apple-calendar-handler'

const INPUT = { subject: 'Board sync', body: '', startIso: '2026-10-25T10:00:00Z', endIso: '2026-10-25T11:00:00Z' }

function fakeHost(over: Partial<EventKitHost> = {}): EventKitHost {
  return {
    status: vi.fn(async () => 'fullAccess' as const),
    ask: vi.fn(async () => 'fullAccess' as const),
    create: vi.fn(async () => ({ kind: 'created' as const, id: 'EK1' })),
    read: vi.fn(async () => ({
      kind: 'found' as const,
      subject: 'Board sync',
      startIso: '2026-10-25T10:00:00Z',
      endIso: '2026-10-25T11:00:00Z',
      cancelled: false
    })),
    ...over
  }
}

describe('apple.calendar.event.create handler', () => {
  it('creates, reads back and returns the verified event', async () => {
    const host = fakeHost()
    expect(await createAppleEventCreateHandler(host)(INPUT)).toEqual({
      ok: true,
      output: { id: 'EK1', verified: true, startIso: INPUT.startIso, endIso: INPUT.endIso }
    })
    expect(host.ask).not.toHaveBeenCalled()
  })

  it.each([
    'denied',
    'restricted',
    'writeOnly'
  ] as const)('%s → os_permission_missing, create never called', async (status) => {
    const host = fakeHost({ status: vi.fn(async () => status) })
    expect(await createAppleEventCreateHandler(host)(INPUT)).toEqual({
      ok: false,
      refusal: 'os_permission_missing',
      permission: status
    })
    expect(host.create).not.toHaveBeenCalled()
    expect(host.ask).not.toHaveBeenCalled()
  })

  it('notDetermined asks once then creates', async () => {
    const host = fakeHost({ status: vi.fn(async () => 'notDetermined' as const) })
    const out = await createAppleEventCreateHandler(host)(INPUT)
    expect(out.ok).toBe(true)
    expect(host.ask).toHaveBeenCalledTimes(1)
    expect(host.create).toHaveBeenCalledTimes(1)
  })

  it('notDetermined and the owner declines → os_permission_missing with the new status', async () => {
    const host = fakeHost({
      status: vi.fn(async () => 'notDetermined' as const),
      ask: vi.fn(async () => 'denied' as const)
    })
    expect(await createAppleEventCreateHandler(host)(INPUT)).toEqual({
      ok: false,
      refusal: 'os_permission_missing',
      permission: 'denied'
    })
    expect(host.create).not.toHaveBeenCalled()
  })

  it('a permission reply from create is still the typed refusal', async () => {
    const host = fakeHost({ create: vi.fn(async () => ({ kind: 'permission' as const })) })
    const out = await createAppleEventCreateHandler(host)(INPUT)
    expect(out).toMatchObject({ ok: false, refusal: 'os_permission_missing' })
  })

  it('readback mismatch → effect_uncertain', async () => {
    const host = fakeHost({
      read: vi.fn(async () => ({
        kind: 'found' as const,
        subject: 'Board sync',
        startIso: '2026-10-25T12:00:00Z',
        endIso: '2026-10-25T13:00:00Z',
        cancelled: false
      }))
    })
    const out = await createAppleEventCreateHandler(host)(INPUT)
    expect(out).toMatchObject({ ok: false, refusal: 'effect_uncertain' })
  })

  it.each([
    { kind: 'missing' as const },
    { kind: 'unknown' as const }
  ])('readback %o → effect_uncertain', async (readback) => {
    const host = fakeHost({ read: vi.fn(async () => readback) })
    expect(await createAppleEventCreateHandler(host)(INPUT)).toMatchObject({ refusal: 'effect_uncertain' })
  })

  it('create timeout → effect_uncertain, no readback, no second create', async () => {
    const host = fakeHost({ create: vi.fn(async () => ({ kind: 'uncertain' as const })) })
    expect(await createAppleEventCreateHandler(host)(INPUT)).toMatchObject({ refusal: 'effect_uncertain' })
    expect(host.read).not.toHaveBeenCalled()
    expect(host.create).toHaveBeenCalledTimes(1)
  })

  it('helper unavailable → plain failure, no refusal claim of an effect', async () => {
    const host = fakeHost({ status: vi.fn(async () => null) })
    const out = await createAppleEventCreateHandler(host)(INPUT)
    expect(out).toMatchObject({ ok: false })
    expect(out).not.toHaveProperty('refusal')
    expect(host.create).not.toHaveBeenCalled()
  })

  it('carries no event text in an error', async () => {
    const host = fakeHost({ create: vi.fn(async () => ({ kind: 'failed' as const })) })
    expect(JSON.stringify(await createAppleEventCreateHandler(host)(INPUT))).not.toContain('Board sync')
  })
})
