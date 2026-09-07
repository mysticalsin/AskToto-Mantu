import { describe, expect, it } from 'vitest'
import { applyPulse, averageSessionDurationMs, isSessionOpen, isSessionStale, sessionDurationMs, SESSION_GAP_MS, type SessionRow } from './sessions'

function session(partial: Partial<SessionRow> = {}): SessionRow {
  return {
    id: 's1',
    device_id: 'dev-a',
    started_at: 0,
    last_pulse_at: 0,
    ended_at: null,
    pulses: 1,
    asks: 0,
    recaps: 0,
    country: 'CA',
    city: 'Longueuil',
    os: 'darwin',
    app_version: '1.8.5',
    ...partial
  }
}

describe('applyPulse: 2-minute-gap session math', () => {
  it('opens a new session when there is no existing one', () => {
    const { session: s, closed, opened } = applyPulse(
      null,
      { deviceId: 'dev-a', ts: 1000, kind: 'heartbeat', country: 'CA', city: 'Longueuil', os: 'darwin', appVersion: '1.8.5' },
      () => 'new-id'
    )
    expect(opened).toBe(true)
    expect(closed).toBeNull()
    expect(s).toMatchObject({ id: 'new-id', device_id: 'dev-a', started_at: 1000, last_pulse_at: 1000, pulses: 1, asks: 0, recaps: 0 })
  })

  it('continues an open session in place when the gap is under 2 minutes', () => {
    const existing = session({ last_pulse_at: 0, pulses: 1 })
    const { session: s, closed, opened } = applyPulse(
      existing,
      { deviceId: 'dev-a', ts: SESSION_GAP_MS - 1, kind: 'ask', country: 'CA', city: 'Longueuil', os: 'darwin', appVersion: '1.8.5' },
      () => 'unused'
    )
    expect(opened).toBe(false)
    expect(closed).toBeNull()
    expect(s.id).toBe('s1')
    expect(s.last_pulse_at).toBe(SESSION_GAP_MS - 1)
    expect(s.pulses).toBe(2)
    expect(s.asks).toBe(1)
  })

  it('closes the stale session and opens a fresh one when the gap exceeds 2 minutes', () => {
    const existing = session({ last_pulse_at: 0, pulses: 3 })
    const { session: s, closed, opened } = applyPulse(
      existing,
      { deviceId: 'dev-a', ts: SESSION_GAP_MS + 1, kind: 'recap', country: 'CA', city: 'Longueuil', os: 'darwin', appVersion: '1.8.5' },
      () => 'new-id-2'
    )
    expect(opened).toBe(true)
    expect(closed).toEqual({ ...existing, ended_at: 0 })
    expect(s.id).toBe('new-id-2')
    expect(s.started_at).toBe(SESSION_GAP_MS + 1)
    expect(s.pulses).toBe(1)
    expect(s.recaps).toBe(1)
  })

  it('never continues a session that is already ended', () => {
    const existing = session({ ended_at: 10, last_pulse_at: 10 })
    const { opened, closed } = applyPulse(
      existing,
      { deviceId: 'dev-a', ts: 20, kind: 'heartbeat', country: 'CA', city: 'Longueuil', os: 'darwin', appVersion: '1.8.5' },
      () => 'new-id-3'
    )
    expect(opened).toBe(true)
    expect(closed).toBeNull() // already ended, nothing new to close
  })

  it('carries forward geo/os/version with newest-non-null semantics like upsertSeat', () => {
    const existing = session({ country: 'CA', city: 'Longueuil', os: 'darwin', app_version: '1.8.4' })
    const { session: s } = applyPulse(
      existing,
      { deviceId: 'dev-a', ts: 1000, kind: 'heartbeat', country: null, city: null, os: null, appVersion: '1.8.5' },
      () => 'unused'
    )
    expect(s.country).toBe('CA')
    expect(s.city).toBe('Longueuil')
    expect(s.os).toBe('darwin')
    expect(s.app_version).toBe('1.8.5')
  })
})

describe('isSessionOpen / isSessionStale', () => {
  it('open means ended_at is null', () => {
    expect(isSessionOpen(session({ ended_at: null }))).toBe(true)
    expect(isSessionOpen(session({ ended_at: 5 }))).toBe(false)
  })

  it('stale means open and the gap since last_pulse_at exceeds the window', () => {
    expect(isSessionStale(session({ ended_at: null, last_pulse_at: 0 }), SESSION_GAP_MS + 1)).toBe(true)
    expect(isSessionStale(session({ ended_at: null, last_pulse_at: 0 }), SESSION_GAP_MS)).toBe(false)
    expect(isSessionStale(session({ ended_at: 0, last_pulse_at: 0 }), SESSION_GAP_MS + 1)).toBe(false)
  })
})

describe('sessionDurationMs / averageSessionDurationMs', () => {
  it('uses ended_at when present, else last_pulse_at', () => {
    expect(sessionDurationMs(session({ started_at: 0, last_pulse_at: 100, ended_at: 90 }))).toBe(90)
    expect(sessionDurationMs(session({ started_at: 0, last_pulse_at: 100, ended_at: null }))).toBe(100)
  })

  it('averages across sessions, null when empty', () => {
    expect(averageSessionDurationMs([])).toBeNull()
    expect(
      averageSessionDurationMs([
        session({ started_at: 0, last_pulse_at: 100, ended_at: 100 }),
        session({ started_at: 0, last_pulse_at: 200, ended_at: 200 })
      ])
    ).toBe(150)
  })
})
