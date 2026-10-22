import { describe, expect, it, vi } from 'vitest'
import type { CalendarEvent, CalendarTodayResult } from '@shared/ipc'
import { createMeetingAlert, meetingAlertBody, type MeetingAlertDeps } from './meeting-alert'

function event(subject: string, startMs: number): CalendarEvent {
  return { subject, start: new Date(startMs).toISOString(), allDay: false, attendees: 0 } as unknown as CalendarEvent
}

function harness(over: Partial<MeetingAlertDeps> = {}) {
  let now = 1_700_000_000_000
  const notify = vi.fn()
  const fetchToday = vi.fn<(tz: string) => Promise<CalendarTodayResult>>()
  const deps: MeetingAlertDeps = {
    now: () => now,
    enabled: () => true,
    requireAuth: () => true,
    denyIfLimited: () => false,
    timeZone: () => 'UTC',
    fetchToday,
    notify,
    warn: vi.fn(),
    ...over
  }
  return {
    tick: createMeetingAlert(deps),
    notify,
    fetchToday,
    advance: (ms: number) => {
      now += ms
    },
    at: (ms: number) => now + ms
  }
}

describe('meetingAlertBody (D2-9, D9-5)', () => {
  it('states the real remaining time instead of a fixed minute', () => {
    expect(meetingAlertBody('Sync', 45_000)).toBe('Sync starts in less than a minute')
    expect(meetingAlertBody('Sync', 59_999)).toBe('Sync starts in less than a minute')
  })

  it('says starting now at 5 s or less, including an event that already began', () => {
    expect(meetingAlertBody('Sync', 5_000)).toBe('Sync is starting now')
    expect(meetingAlertBody('Sync', 0)).toBe('Sync is starting now')
    expect(meetingAlertBody('Sync', -20_000)).toBe('Sync is starting now')
  })
})

describe('createMeetingAlert', () => {
  it('notifies once for an event inside its 60 s window and carries the body', async () => {
    const h = harness()
    h.fetchToday.mockResolvedValue({ ok: true, events: [event('Sync', h.at(45_000))] })
    await h.tick()
    await h.tick()
    expect(h.notify).toHaveBeenCalledTimes(1)
    expect(h.notify).toHaveBeenCalledWith('Meeting starting soon', 'Sync starts in less than a minute')
  })

  it('does nothing when disabled, signed out or rate limited', async () => {
    for (const over of [{ enabled: () => false }, { requireAuth: () => false }, { denyIfLimited: () => true }]) {
      const h = harness(over)
      h.fetchToday.mockResolvedValue({ ok: true, events: [event('Sync', h.at(45_000))] })
      await h.tick()
      expect(h.fetchToday).not.toHaveBeenCalled()
      expect(h.notify).not.toHaveBeenCalled()
    }
  })

  it('backs off for five minutes after a consent failure, then tries again', async () => {
    const h = harness()
    h.fetchToday.mockResolvedValue({ ok: false, needsConsent: true })
    await h.tick()
    expect(h.fetchToday).toHaveBeenCalledTimes(1)
    for (let i = 0; i < 9; i += 1) {
      h.advance(30_000)
      await h.tick()
    }
    expect(h.fetchToday).toHaveBeenCalledTimes(1)
    h.advance(30_001)
    await h.tick()
    expect(h.fetchToday).toHaveBeenCalledTimes(2)
  })

  it('backs off after a thrown or error result too', async () => {
    const h = harness()
    h.fetchToday.mockRejectedValueOnce(new Error('network')).mockResolvedValue({ ok: false, error: 'x' })
    await expect(h.tick()).resolves.toBeUndefined()
    h.advance(30_000)
    await h.tick()
    expect(h.fetchToday).toHaveBeenCalledTimes(1)
  })

  it('reuses a warm 30 s cache instead of calling Graph again', async () => {
    const h = harness()
    h.fetchToday.mockResolvedValue({ ok: true, events: [] })
    await h.tick()
    h.advance(10_000)
    await h.tick()
    expect(h.fetchToday).toHaveBeenCalledTimes(1)
    h.advance(30_000)
    await h.tick()
    expect(h.fetchToday).toHaveBeenCalledTimes(2)
  })
})
