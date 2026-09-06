import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('./auth', () => ({ getGraphToken: vi.fn(async () => 'graph-token') }))
vi.mock('./logger', () => ({ auditLog: vi.fn() }))

import { calendarToday, safeTimeZone } from './calendar'

// MQA-026 — "today's agenda" must be the user's LOCAL day. Graph interprets calendarView's
// startDateTime/endDateTime by the offset carried in the value and ignores Prefer: outlook.timezone for
// the request bounds, so naive "YYYY-MM-DDT00:00:00" bounds silently query a UTC day: a Tokyo user loses
// their own morning standup and inherits tomorrow's early meetings. These tests pin the absolute instants.

/** Run calendarToday at a pinned wall clock and return the bounds Graph actually received. */
async function boundsAt(nowIso: string, tz: string): Promise<{ start: string; end: string; prefer: string }> {
  vi.setSystemTime(new Date(nowIso))
  const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ value: [] }) }))
  vi.stubGlobal('fetch', fetchMock)
  const res = await calendarToday(tz)
  expect(res.ok).toBe(true)
  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { headers: Record<string, string> }]
  const q = new URL(url).searchParams
  return { start: q.get('startDateTime') || '', end: q.get('endDateTime') || '', prefer: init.headers.Prefer }
}

describe('calendarToday — local-day window (MQA-026)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('queries the Tokyo day, not the UTC day, for a user east of UTC', async () => {
    // 2026-08-08T19:15Z is already 2026-08-09 04:15 JST — the naive bounds asked for 09:00 JST → 09:00 JST.
    const { start, end } = await boundsAt('2026-08-08T19:15:00Z', 'Asia/Tokyo')
    expect(start).toBe('2026-08-08T15:00:00.000Z') // 2026-08-09 00:00 JST
    expect(end).toBe('2026-08-09T15:00:00.000Z') // 2026-08-10 00:00 JST
  })

  it('queries the Los Angeles day, not the UTC day, for a user west of UTC', async () => {
    const { start, end } = await boundsAt('2026-08-08T19:15:00Z', 'America/Los_Angeles')
    expect(start).toBe('2026-08-08T07:00:00.000Z') // 2026-08-08 00:00 PDT
    expect(end).toBe('2026-08-09T07:00:00.000Z') // 2026-08-09 00:00 PDT
  })

  it('carries a real offset for a half-hour zone', async () => {
    const { start, end } = await boundsAt('2026-08-08T19:15:00Z', 'Asia/Kolkata')
    expect(start).toBe('2026-08-08T18:30:00.000Z') // 2026-08-09 00:00 IST (+05:30)
    expect(end).toBe('2026-08-09T18:30:00.000Z')
  })

  it('shortens the window to 23h across a spring-forward DST transition', async () => {
    // 2027-03-14 is the US spring-forward: local midnight is still PST (-08:00), the next one is PDT (-07:00).
    const { start, end } = await boundsAt('2027-03-14T18:00:00Z', 'America/Los_Angeles')
    expect(start).toBe('2027-03-14T08:00:00.000Z')
    expect(end).toBe('2027-03-15T07:00:00.000Z')
    expect(Date.parse(end) - Date.parse(start)).toBe(23 * 3600_000)
  })

  it('sends bounds Graph reads as absolute instants, and still asks for responses in the user zone', async () => {
    const { start, end, prefer } = await boundsAt('2026-08-08T19:15:00Z', 'Asia/Tokyo')
    // A naive bound (no Z / no ±HH:MM) is read as UTC by Graph regardless of the Prefer header.
    for (const bound of [start, end]) expect(bound).toMatch(/(Z|[+-]\d{2}:\d{2})$/)
    expect(prefer).toBe('outlook.timezone="Asia/Tokyo"')
  })

  it('falls back to UTC bounds when no timezone is supplied', async () => {
    const { start, end } = await boundsAt('2026-08-08T19:15:00Z', '')
    expect(start).toBe('2026-08-08T00:00:00.000Z')
    expect(end).toBe('2026-08-09T00:00:00.000Z')
  })
})

// MQA-189 — the Graph call must carry a deadline. A proxy or captive portal that completes the TLS
// handshake and then silently drops leaves an unbounded fetch waiting on undici's 300 s default, and
// nothing above calendarToday bounds it (the IPC handler, preload and AgendaView all just await), so the
// tray panel sits on "Loading agenda…" for five minutes with no error and no cancel. The already-written
// "Calendar unavailable — try again." branch can only fire if something makes the fetch reject.
describe('calendarToday — bounded Graph fetch (MQA-189)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  it('MQA-189 aborts a black-holed Graph request and reports it as unavailable instead of spinning', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout')
    const stall = new AbortController()
    timeoutSpy.mockReturnValue(stall.signal)

    // The black-holing proxy: the response never arrives, so the signal is the ONLY thing that can end
    // this call — exactly as undici behaves, rejecting with a TimeoutError DOMException on abort.
    const fetchMock = vi.fn(
      (_url: string, init: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))
          )
        })
    )
    vi.stubGlobal('fetch', fetchMock)

    const pending = calendarToday('Europe/Paris')
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, { signal?: AbortSignal }]

    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(timeoutSpy).toHaveBeenCalledWith(10_000) // the same bound license.ts:25 uses for its own POST

    stall.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))
    await expect(pending).resolves.toEqual({ ok: false, error: 'Calendar unavailable — try again.' })
  })
})

describe('calendarToday — join URL allow-list', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('keeps an https Teams join URL and drops javascript:/file: payloads', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          value: [
            {
              subject: 'Standup',
              start: { dateTime: '2026-08-08T10:00:00' },
              end: { dateTime: '2026-08-08T10:30:00' },
              onlineMeeting: { joinUrl: 'https://teams.microsoft.com/l/meetup-join/abc' }
            },
            {
              subject: 'Evil',
              start: { dateTime: '2026-08-08T11:00:00' },
              end: { dateTime: '2026-08-08T11:30:00' },
              onlineMeeting: { joinUrl: 'javascript:alert(1)' }
            }
          ]
        })
      }))
    )
    const res = await calendarToday('UTC')
    expect(res.ok).toBe(true)
    expect(res.events?.[0]?.joinUrl).toMatch(/^https:\/\/teams\.microsoft\.com\//)
    expect(res.events?.[1]?.joinUrl).toBeUndefined()
  })
})

describe('calendarToday — renderer-supplied zone never reaches the Prefer header unchecked', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('safeTimeZone keeps IANA names and falls back to UTC for anything else', () => {
    expect(safeTimeZone('Europe/Brussels')).toBe('Europe/Brussels')
    expect(safeTimeZone('America/Argentina/Buenos_Aires')).toBe('America/Argentina/Buenos_Aires')
    expect(safeTimeZone('Etc/GMT+3')).toBe('Etc/GMT+3')
    expect(safeTimeZone('UTC')).toBe('UTC')
    expect(safeTimeZone('Not/AZone')).toBe('UTC')
    expect(safeTimeZone('Europe/Brussels"\r\nX-Injected: 1')).toBe('UTC')
    expect(safeTimeZone('Europe/Brussels" ; evil')).toBe('UTC')
    expect(safeTimeZone('a'.repeat(200))).toBe('UTC')
    expect(safeTimeZone('')).toBe('UTC')
    expect(safeTimeZone(42)).toBe('UTC')
    expect(safeTimeZone(undefined)).toBe('UTC')
  })

  it('a header-shaped zone is replaced by UTC in the request', async () => {
    const { prefer } = await boundsAt('2026-08-08T19:15:00Z', 'Europe/Brussels"\r\nX-Injected: 1')
    expect(prefer).toBe('outlook.timezone="UTC"')
  })

  it('a valid zone still goes through untouched', async () => {
    const { prefer } = await boundsAt('2026-08-08T19:15:00Z', 'Asia/Tokyo')
    expect(prefer).toBe('outlook.timezone="Asia/Tokyo"')
  })
})
