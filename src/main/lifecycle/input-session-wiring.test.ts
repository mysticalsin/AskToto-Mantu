import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { InputSessionStopReason } from '@shared/input-session'
import { createMainInputSessionWiring } from './input-session-wiring'

const owner = {
  webContentsId: 7,
  frameId: '1:2',
  isTopFrame: true,
  authSessionGeneration: 3,
  contextRevision: 4
}
const request = { source: 'push-to-talk', purpose: 'command', activation: 'explicit' } as const

function setup(windowId = owner.webContentsId) {
  const events: string[] = []
  let trackedLeaseId: string | null = null
  let voiceActions: { onHardStop: (reason: InputSessionStopReason) => void; onMeetingReserved: () => void } | null = {
    onHardStop: vi.fn<(reason: InputSessionStopReason) => void>(),
    onMeetingReserved: vi.fn<() => void>()
  }
  const commandSpeechCapture = { cancelForLease: vi.fn(() => events.push('capture')) }
  const window = {
    isDestroyed: () => false,
    webContents: {
      id: windowId,
      send: vi.fn(() => events.push('notify'))
    }
  }
  const wiring = createMainInputSessionWiring({
    voiceActions: () => voiceActions,
    revokeSpokenReplies: () => events.push('revoke'),
    commandMicActivationLeaseId: () => trackedLeaseId,
    clearCommandMicActivationLeaseId: () => {
      events.push(`lease-cleared-with-${vi.getTimerCount()}-timers`)
      trackedLeaseId = null
    },
    commandSpeechCapture: () => commandSpeechCapture,
    window: () => window
  })
  return {
    ...wiring,
    events,
    window,
    commandSpeechCapture,
    setTrackedLeaseId(id: string | null) {
      trackedLeaseId = id
    },
    getTrackedLeaseId() {
      return trackedLeaseId
    },
    setVoiceActions(value: typeof voiceActions) {
      voiceActions = value
    },
    getVoiceActions() {
      return voiceActions
    }
  }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('main input-session lifecycle wiring', () => {
  it('revokes playback, clears a matching lease timer, cancels capture, then notifies only its owner', () => {
    const context = setup()
    const started = context.inputSessionAuthority.start(owner, request)
    expect(started.ok).toBe(true)
    if (!started.ok) return
    context.setTrackedLeaseId(started.lease.sessionId)
    context.armCommandMicLeaseTimeout(started.lease.sessionId, 60_000)
    expect(vi.getTimerCount()).toBe(1)

    context.inputSessionAuthority.hardStop('auth-revoked')

    expect(context.events).toEqual(['revoke', 'lease-cleared-with-0-timers', 'capture', 'notify'])
    expect(context.getTrackedLeaseId()).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
    expect(context.commandSpeechCapture.cancelForLease).toHaveBeenCalledExactlyOnceWith(started.lease.sessionId)
    expect(context.window.webContents.send).toHaveBeenCalledOnce()
  })

  it('does not clear a newer tracked lease when the revoked lease id no longer matches', () => {
    const context = setup()
    const started = context.inputSessionAuthority.start(owner, request)
    expect(started.ok).toBe(true)
    if (!started.ok) return
    const newerLeaseId = 'b'.repeat(48)
    context.setTrackedLeaseId(newerLeaseId)
    context.armCommandMicLeaseTimeout(started.lease.sessionId, 60_000)

    context.inputSessionAuthority.hardStop('auth-revoked')

    expect(context.getTrackedLeaseId()).toBe(newerLeaseId)
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(60_000)
    expect(vi.getTimerCount()).toBe(0)
    expect(context.window.webContents.send).toHaveBeenCalledOnce()
  })

  it('does not notify a non-owning window, while still cleaning up the revoked lease', () => {
    const context = setup(owner.webContentsId + 1)
    const started = context.inputSessionAuthority.start(owner, request)
    expect(started.ok).toBe(true)
    if (!started.ok) return
    context.setTrackedLeaseId(started.lease.sessionId)
    context.armCommandMicLeaseTimeout(started.lease.sessionId, 60_000)

    context.inputSessionAuthority.hardStop('owner-replaced')

    expect(context.events).toEqual(['revoke', 'lease-cleared-with-0-timers', 'capture'])
    expect(context.window.webContents.send).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('forwards a no-lease hard stop to voice actions without requiring a microphone lease', () => {
    const context = setup()
    context.setVoiceActions(null)
    const lateVoiceActions = {
      onHardStop: vi.fn<(reason: InputSessionStopReason) => void>(),
      onMeetingReserved: vi.fn<() => void>()
    }
    context.setVoiceActions(lateVoiceActions)

    context.inputSessionAuthority.hardStop('auth-revoked')

    expect(context.events).toEqual([])
    expect(context.window.webContents.send).not.toHaveBeenCalled()
    expect(context.commandSpeechCapture.cancelForLease).not.toHaveBeenCalled()
    expect(context.inputSessionAuthority.activeLease).toBeNull()
    // A no-mic hard stop still reaches the voice runtime that owns non-capture speech.
    expect(context.getVoiceActions()).toBe(lateVoiceActions)
    expect(lateVoiceActions.onHardStop).toHaveBeenCalledExactlyOnceWith('auth-revoked')
  })
})
