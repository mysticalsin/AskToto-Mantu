import { describe, expect, it } from 'vitest'
import { checkGestureTarget, type GestureBinding } from './gesture-binding'

const binding = (target: GestureBinding['target']): GestureBinding => ({
  bindingId: 'b1',
  owner: { webContentsId: 7, revision: 3 },
  sessionId: 'command-1',
  target,
  capturedAtMs: 1_000
})
const MAIL = { windowId: 'com.apple.mail', pid: 100, title: 'Inbox' }
const OWN_PID = 999

describe('checkGestureTarget (G34)', () => {
  it('accepts the same app and process that was in front when the gesture started', () => {
    expect(checkGestureTarget(binding(MAIL), { ...MAIL, title: 'Another title' }, OWN_PID)).toEqual({ ok: true })
  })

  it('refuses with target_changed when a different app is in front, rather than retargeting', () => {
    expect(checkGestureTarget(binding(MAIL), { windowId: 'com.apple.notes', pid: 200, title: '' }, OWN_PID)).toEqual({
      ok: false,
      reason: 'target_changed'
    })
  })

  it('refuses when the same bundle id came back as a different process', () => {
    expect(checkGestureTarget(binding(MAIL), { ...MAIL, pid: 101 }, OWN_PID)).toEqual({
      ok: false,
      reason: 'target_changed'
    })
  })

  it('refuses when the foreground can no longer be observed', () => {
    expect(checkGestureTarget(binding(MAIL), null, OWN_PID)).toEqual({ ok: false, reason: 'target_changed' })
  })

  it('treats Métis itself in front (its own confirmation card) as no change', () => {
    expect(
      checkGestureTarget(binding(MAIL), { windowId: 'com.mantu.asktoto', pid: OWN_PID, title: '' }, OWN_PID)
    ).toEqual({
      ok: true
    })
  })

  it('has nothing to retarget from when no foreground app was observed at gesture start', () => {
    expect(checkGestureTarget(binding(null), { windowId: 'x', pid: 1, title: '' }, OWN_PID)).toEqual({ ok: true })
  })
})
