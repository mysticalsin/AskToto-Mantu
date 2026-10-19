import { describe, expect, it } from 'vitest'
import { InputSessionAuthority } from './input-session-authority'

const owner = {
  webContentsId: 7,
  frameId: '12:3',
  isTopFrame: true,
  authSessionGeneration: 3,
  contextRevision: 9
} as const
const otherOwner = {
  webContentsId: 8,
  frameId: '12:3',
  isTopFrame: true,
  authSessionGeneration: 3,
  contextRevision: 9
} as const

function authority() {
  let now = 100
  let token = 0
  return new InputSessionAuthority({ now: () => now++, token: () => (++token).toString(16).padStart(48, '0') })
}

describe('InputSessionAuthority', () => {
  it('fails closed on competing starts without replacing the existing owner', () => {
    const sessions = authority()
    const first = sessions.start(owner, { source: 'push-to-talk', purpose: 'conversation', activation: 'explicit' })
    expect(first.ok).toBe(true)
    const second = sessions.start(otherOwner, { source: 'deliberate-talk', purpose: 'command', activation: 'explicit' })
    expect(second).toEqual({ ok: false, reason: 'busy' })
    expect(sessions.activeLease).toEqual(first.ok ? first.lease : null)
  })

  it('treats renderer source and activation as metadata, never trusted action authority', () => {
    const sessions = authority()
    expect(sessions.start(owner, { source: 'push-to-talk', purpose: 'command', activation: 'ambient' })).toEqual({
      ok: false,
      reason: 'invalid_request'
    })
    const wake = sessions.start(owner, { source: 'wake', purpose: 'conversation', activation: 'ambient' })
    expect(wake.ok && wake.lease.actionAuthority).toBe(false)
    sessions.hardStop('cancelled')
    const talk = sessions.start(owner, { source: 'deliberate-talk', purpose: 'conversation', activation: 'explicit' })
    expect(talk.ok && talk.lease.actionAuthority).toBe(false)
    sessions.hardStop('cancelled')
    const dictation = sessions.start(owner, { source: 'push-to-talk', purpose: 'dictation', activation: 'explicit' })
    expect(dictation.ok && dictation.lease.actionAuthority).toBe(false)
  })

  it('atomically replaces meeting reservations and preempts interactive authority', () => {
    const sessions = authority()
    const interactive = sessions.start(owner, { source: 'push-to-talk', purpose: 'dictation', activation: 'explicit' })
    expect(interactive.ok).toBe(true)
    expect(sessions.reserveMeeting(500)).toBe(true)
    expect(sessions.activeLease).toBeNull()
    expect(sessions.start(owner, { source: 'push-to-talk', purpose: 'dictation', activation: 'explicit' })).toEqual({
      ok: false,
      reason: 'meeting_reserved'
    })
    expect(sessions.reserveMeeting(501)).toBe(true)
    expect(sessions.meetingStartedAt).toBe(501)
    expect(sessions.releaseMeeting(500)).toBe(false)
    expect(sessions.releaseMeeting(501)).toBe(true)
    expect(sessions.reserveMeeting(null)).toBe(true)
    expect(sessions.reserveMeeting(502)).toBe(true)
    expect(sessions.meetingStartedAt).toBe(502)
  })

  it('does not clear the isolated meeting reservation during an interactive hard stop', () => {
    const sessions = authority()
    expect(sessions.reserveMeeting(500)).toBe(true)
    sessions.hardStop('window-hidden')
    expect(sessions.meetingStartedAt).toBe(500)
    expect(sessions.start(owner, { source: 'push-to-talk', purpose: 'command', activation: 'explicit' })).toEqual({
      ok: false,
      reason: 'meeting_reserved'
    })
  })

  it('rejects an old auth/context owner and drops its stale lease on context reconciliation', () => {
    const sessions = authority()
    const started = sessions.start(owner, { source: 'push-to-talk', purpose: 'command', activation: 'explicit' })
    expect(started.ok).toBe(true)
    sessions.reconcileContext({ authSessionGeneration: 4, contextRevision: 9 })
    expect(sessions.activeLease).toBeNull()
    expect(sessions.stop(owner, { sessionId: started.ok ? started.lease.sessionId : '0'.repeat(48) })).toEqual({
      ok: false,
      reason: 'stale_session'
    })
    expect(
      sessions.start(
        { ...owner, authSessionGeneration: 4 },
        {
          source: 'push-to-talk',
          purpose: 'command',
          activation: 'explicit'
        }
      ).ok
    ).toBe(true)
  })

  it('binds stop to both the trusted owner and current session id', () => {
    const sessions = authority()
    const started = sessions.start(owner, {
      source: 'deliberate-talk',
      purpose: 'conversation',
      activation: 'explicit'
    })
    if (!started.ok) throw new Error('expected test session')
    expect(sessions.stop(otherOwner, { sessionId: started.lease.sessionId })).toEqual({
      ok: false,
      reason: 'stale_session'
    })
    expect(sessions.stop(owner, { sessionId: 'f'.repeat(48) })).toEqual({ ok: false, reason: 'stale_session' })
    expect(sessions.stop(owner, { sessionId: started.lease.sessionId })).toEqual({ ok: true })
    expect(sessions.activeLease).toBeNull()
  })

  it('allows only one permission request and requires exact post-capture confirmation', () => {
    const sessions = authority()
    const started = sessions.start(owner, { source: 'push-to-talk', purpose: 'dictation', activation: 'explicit' })
    if (!started.ok) throw new Error('expected test session')
    expect(sessions.hasPermissionCheckOwner(owner)).toBe(false)
    expect(sessions.hasPermissionRequestOwner(owner)).toBe(true)
    expect(sessions.claimPermissionRequest(otherOwner)).toBe(false)
    expect(sessions.claimPermissionRequest(owner)).toBe(true)
    expect(sessions.claimPermissionRequest(owner)).toBe(false)
    expect(sessions.hasPermissionCheckOwner(owner)).toBe(true)
    expect(sessions.confirmCapture(otherOwner, started.lease.sessionId)).toBe(false)
    expect(sessions.confirmCapture(owner, 'f'.repeat(48))).toBe(false)
    expect(sessions.confirmCapture(owner, started.lease.sessionId)).toBe(true)
    expect(sessions.hasPermissionCheckOwner(owner)).toBe(false)
    expect(sessions.claimPermissionRequest(owner)).toBe(false)
  })

  it('invalidates interactive authority on a hard stop and rejects starts after shutdown', () => {
    const sessions = authority()
    expect(sessions.start(owner, { source: 'push-to-talk', purpose: 'command', activation: 'explicit' }).ok).toBe(true)
    sessions.hardStop('device-change')
    expect(sessions.activeLease).toBeNull()
    sessions.shutdown()
    expect(sessions.start(owner, { source: 'push-to-talk', purpose: 'command', activation: 'explicit' })).toEqual({
      ok: false,
      reason: 'shutdown'
    })
  })

  it('closes interactive admission on first quit request while preserving meeting reservation for flush', () => {
    const sessions = authority()
    const interactive = sessions.start(owner, {
      source: 'deliberate-talk',
      purpose: 'conversation',
      activation: 'explicit'
    })
    expect(interactive.ok).toBe(true)
    expect(sessions.reserveMeeting(700)).toBe(true)
    sessions.beginShutdown()
    expect(sessions.activeLease).toBeNull()
    expect(sessions.meetingStartedAt).toBe(700)
    expect(sessions.reserveMeeting(701)).toBe(false)
    expect(sessions.meetingStartedAt).toBe(700)
    expect(sessions.start(owner, { source: 'push-to-talk', purpose: 'command', activation: 'explicit' })).toEqual({
      ok: false,
      reason: 'shutdown'
    })
    sessions.shutdown()
    expect(sessions.meetingStartedAt).toBeNull()
  })
})
