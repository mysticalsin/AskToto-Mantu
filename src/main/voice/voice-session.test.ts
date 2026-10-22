import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { VoiceBegin, VoiceEnd, VoiceStateSnapshot } from '@shared/voice/voice-turn'
import { VOICE_TURN_MAX_MS, voiceReasonCopy } from '@shared/voice/voice-turn'
import type { ChordWatcherEvent, ChordWatcherStatus } from './chord-watcher'
import { VoiceSession, type VoiceSessionDeps } from './voice-session'

type Availability = ReturnType<VoiceSessionDeps['gate']['availability']>

type ChordInput = 'armed' | 'released' | 'aborted' | 'latched' | 'latch-ended' | ChordWatcherEvent

const toEvent = (input: ChordInput): ChordWatcherEvent => {
  if (typeof input !== 'string') return input
  switch (input) {
    case 'released':
      return { type: 'released', reason: 'release' }
    case 'aborted':
      return { type: 'aborted', reason: 'other-input' }
    case 'latch-ended':
      return { type: 'latch-ended', reason: 'press' }
    default:
      return { type: input }
  }
}

function harness(initial: { enabled?: boolean } = {}) {
  const config = { enabled: initial.enabled ?? true }
  const chordState: { status: ChordWatcherStatus } = { status: 'running' }
  const chord = { refresh: vi.fn(), status: () => chordState.status }
  const gate = {
    signedIn: true,
    meetingReserved: false,
    onboardingActive: false,
    windowVisible: true,
    explicitLeaseActive: false,
    availability: { ok: true } as Availability
  }
  const events = {
    begin: [] as VoiceBegin[],
    end: [] as VoiceEnd[],
    state: [] as VoiceStateSnapshot[],
    audit: [] as Array<{ phase: string; reason?: string }>,
    order: [] as string[]
  }
  let mintResult = true
  const deps: VoiceSessionDeps = {
    settings: () => ({ enabled: config.enabled }),
    chord,
    gate: {
      signedIn: () => gate.signedIn,
      meetingReserved: () => gate.meetingReserved,
      onboardingActive: () => gate.onboardingActive,
      windowVisible: () => gate.windowVisible,
      explicitLeaseActive: () => gate.explicitLeaseActive,
      availability: () => gate.availability
    },
    activation: {
      mint: vi.fn(() => {
        events.order.push('mint')
        return mintResult
      }),
      revoke: vi.fn(() => void events.order.push('revoke'))
    },
    stopVoiceLease: vi.fn((reason: string) => void events.order.push(`stop-lease:${reason}`)),
    speech: { prewarm: vi.fn(async () => {}), releaseIdle: vi.fn(async () => {}) },
    speechBusyElsewhere: vi.fn(() => gate.meetingReserved),
    push: {
      begin: vi.fn((p: VoiceBegin) => {
        events.order.push('begin')
        events.begin.push(p)
      }),
      end: vi.fn((p: VoiceEnd) => {
        events.order.push(p.cancelled ? 'end-cancelled' : 'end')
        events.end.push(p)
      }),
      state: vi.fn((s: VoiceStateSnapshot) => void events.state.push(s))
    },
    newTurnId: (() => {
      let n = 0
      return () => `turn-${++n}`
    })(),
    audit: (phase, detail) => void events.audit.push({ phase, ...(detail?.reason ? { reason: detail.reason } : {}) })
  }
  const session = new VoiceSession(deps)
  const emit = (event: ChordInput): void => session.onChordEvent(toEvent(event))
  return {
    session,
    deps,
    gate,
    config,
    events,
    emit,
    chord,
    chordState,
    setMint: (value: boolean) => void (mintResult = value),
    last: () => events.state.at(-1)
  }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('VoiceSession watcher lifecycle', () => {
  it('stays off while voice actions are disabled, and still tells the watcher so it stops', () => {
    const h = harness({ enabled: false })
    h.session.refresh()
    expect(h.chord.refresh).toHaveBeenCalledOnce()
    expect(h.session.snapshot()).toMatchObject({ state: 'off', enabled: false, shortcut: 'stopped' })
  })

  it('enabling re-aims the watcher and reports the shortcut from its status', () => {
    const h = harness()
    h.session.refresh()
    expect(h.chord.refresh).toHaveBeenCalledOnce()
    expect(h.session.snapshot()).toMatchObject({ state: 'idle', enabled: true, shortcut: 'running' })
  })

  it.each([
    ['running', 'running'],
    ['paused', 'running'],
    ['restarting', 'running'],
    ['inert', 'unavailable'],
    ['failed', 'stopped'],
    ['stopped', 'stopped']
  ] as const)('watcher status %s reads as shortcut %s, and a status change is pushed', (status, shortcut) => {
    const h = harness()
    h.session.refresh()
    const before = h.events.state.length
    h.chordState.status = status
    h.session.onChordStatus()
    expect(h.session.snapshot().shortcut).toBe(shortcut)
    expect(h.events.state.length).toBe(shortcut === 'running' ? before : before + 1)
  })

  it('toggling off stops the watcher and cancels a live turn in the same tick', () => {
    const h = harness()
    h.session.refresh()
    h.emit('armed')
    expect(h.last()?.state).toBe('listening')

    h.config.enabled = false
    h.session.refresh()

    expect(h.chord.refresh).toHaveBeenCalledTimes(2)
    expect(h.events.end).toEqual([{ turnId: 'turn-1', cancelled: true }])
    expect(h.deps.stopVoiceLease).toHaveBeenCalledWith('cancelled')
    expect(h.deps.activation.revoke).toHaveBeenCalled()
    expect(h.session.snapshot()).toMatchObject({ state: 'off', turnId: null, shortcut: 'stopped' })
    h.emit('armed')
    expect(h.events.begin).toHaveLength(1)
  })

  it('toggling back on returns to idle', () => {
    const h = harness()
    h.session.refresh()
    h.config.enabled = false
    h.session.refresh()
    h.config.enabled = true
    h.session.refresh()
    expect(h.session.snapshot().state).toBe('idle')
  })

  it('dispose cancels the turn and ignores later verdicts', () => {
    const h = harness()
    h.session.refresh()
    h.emit('armed')
    h.session.dispose()
    expect(h.events.end.at(-1)).toEqual({ turnId: 'turn-1', cancelled: true })
    h.emit('armed')
    expect(h.events.begin).toHaveLength(1)
  })
})

describe('VoiceSession verdicts the watcher gated itself', () => {
  it('a hold refused because a meeting is recording explains why and opens nothing', () => {
    const h = harness()
    h.session.refresh()
    h.emit({ type: 'refused', reason: 'meeting' })
    expect(h.deps.activation.mint).not.toHaveBeenCalled()
    expect(h.deps.push.begin).not.toHaveBeenCalled()
    expect(h.deps.stopVoiceLease).not.toHaveBeenCalled()
    expect(h.last()).toMatchObject({ state: 'failed', reason: 'meeting_recording' })
    expect(h.events.audit.at(-1)).toEqual({ phase: 'refused', reason: 'meeting_recording' })
  })

  it.each([
    ['lock', 'screen_locked'],
    ['suspend', 'system_suspend'],
    ['sign-out', 'session_ended'],
    ['meeting-started', 'meeting_started'],
    ['helper-lost', 'not_ready']
  ] as const)('a watcher revoke (%s) cuts the open turn with %s copy', (cause, reason) => {
    const h = harness()
    h.session.refresh()
    h.emit('armed')
    h.emit({ type: 'revoked', cause })
    expect(h.events.end).toEqual([{ turnId: 'turn-1', cancelled: true }])
    expect(h.last()).toMatchObject({ state: 'failed', reason })
  })

  it('quit and disable revokes are silent, and a revoke with no turn changes nothing', () => {
    const h = harness()
    h.session.refresh()
    const before = h.events.state.length
    h.emit({ type: 'revoked', cause: 'lock' })
    expect(h.events.state).toHaveLength(before)
    h.emit('armed')
    h.emit({ type: 'revoked', cause: 'quit' })
    expect(h.last()).toMatchObject({ state: 'idle', reason: null })
  })
})

describe('VoiceSession hold-to-talk turn', () => {
  it('a hold mints one hardware activation, begins the turn and prewarms speech', () => {
    const h = harness()
    h.session.refresh()
    h.emit('armed')
    expect(h.deps.activation.mint).toHaveBeenCalledOnce()
    expect(h.events.begin).toEqual([{ turnId: 'turn-1', maxMs: VOICE_TURN_MAX_MS }])
    expect(h.events.order.indexOf('mint')).toBeLessThan(h.events.order.indexOf('begin'))
    expect(h.deps.speech.prewarm).toHaveBeenCalledOnce()
    expect(h.last()).toMatchObject({ state: 'listening', turnId: 'turn-1', reason: null, message: null })
  })

  it('releasing seals the turn and waits for recognition', () => {
    const h = harness()
    h.session.refresh()
    h.emit('armed')
    h.emit('released')
    expect(h.events.end).toEqual([{ turnId: 'turn-1', cancelled: false }])
    expect(h.last()).toMatchObject({ state: 'thinking', turnId: 'turn-1' })
  })

  it('aborting while listening discards the turn silently', () => {
    const h = harness()
    h.session.refresh()
    h.emit('armed')
    h.emit('aborted')
    expect(h.events.end).toEqual([{ turnId: 'turn-1', cancelled: true }])
    expect(h.deps.stopVoiceLease).toHaveBeenCalledWith('cancelled')
    expect(h.deps.activation.revoke).toHaveBeenCalled()
    expect(h.last()).toMatchObject({ state: 'idle', turnId: null, reason: null, message: null })
  })

  it('a double-press latch starts a turn and the latch ending seals it', () => {
    const h = harness()
    h.session.refresh()
    h.emit('latched')
    expect(h.last()?.state).toBe('listening')
    h.emit('latch-ended')
    expect(h.events.end).toEqual([{ turnId: 'turn-1', cancelled: false }])
  })

  it('a duplicate armed while listening is ignored', () => {
    const h = harness()
    h.session.refresh()
    h.emit('armed')
    h.emit('armed')
    expect(h.events.begin).toHaveLength(1)
    expect(h.deps.activation.mint).toHaveBeenCalledOnce()
  })

  it('seals automatically at the fifteen second cap, once', () => {
    const h = harness()
    h.session.refresh()
    h.emit('armed')
    h.session.report({ turnId: 'turn-1', phase: 'capturing' })
    vi.advanceTimersByTime(VOICE_TURN_MAX_MS - 1)
    expect(h.events.end).toHaveLength(0)
    vi.advanceTimersByTime(1)
    expect(h.events.end).toEqual([{ turnId: 'turn-1', cancelled: false }])
    h.emit('released')
    expect(h.events.end).toHaveLength(1)
  })

  it('a successful recognition hands the transcript on and returns to idle, revoking the activation', () => {
    const h = harness()
    h.session.refresh()
    h.emit('armed')
    h.emit('released')
    h.session.onSpeechFinished({ ok: true })
    expect(h.last()).toMatchObject({ state: 'idle', turnId: null, reason: null })
    expect(h.deps.activation.revoke).toHaveBeenCalled()
  })

  it.each([
    [{ ok: false, reason: 'no_speech' }, 'no_speech'],
    [{ ok: false, reason: 'invalid' }, 'no_speech'],
    [{ ok: false, reason: 'recognition_unavailable' }, 'recognition_unavailable'],
    [{ ok: false, reason: 'policy_blocked' }, 'policy_blocked'],
    [{ ok: false, reason: 'unsupported_engine' }, 'speech_unavailable']
  ] as const)('a failed recognition (%j) shows %s copy, then returns to idle', (result, reason) => {
    const h = harness()
    h.session.refresh()
    h.emit('armed')
    h.emit('released')
    h.session.onSpeechFinished(result)
    expect(h.last()).toMatchObject({ state: 'failed', reason, message: voiceReasonCopy(reason) })
    vi.advanceTimersByTime(4_000)
    expect(h.last()).toMatchObject({ state: 'idle', reason: null, message: null })
  })

  it('a stale recognition result is silent', () => {
    const h = harness()
    h.session.refresh()
    h.emit('armed')
    h.emit('released')
    h.session.onSpeechFinished({ ok: false, reason: 'stale' })
    expect(h.last()).toMatchObject({ state: 'idle', reason: null, message: null })
  })

  it('a result that arrives with no turn changes nothing (a panel capture, or a cancelled turn)', () => {
    const h = harness()
    h.session.refresh()
    const before = h.events.state.length
    h.session.onSpeechFinished({ ok: true })
    h.session.onSpeechFinished({ ok: false, reason: 'no_speech' })
    expect(h.events.state).toHaveLength(before)
  })

  it('a new hold while thinking supersedes the old turn and ignores its late result', () => {
    const h = harness()
    h.session.refresh()
    h.emit('armed')
    h.emit('released')
    h.emit('armed')
    expect(h.events.end).toContainEqual({ turnId: 'turn-1', cancelled: true })
    expect(h.events.begin.map((b) => b.turnId)).toEqual(['turn-1', 'turn-2'])
    expect(h.last()).toMatchObject({ state: 'listening', turnId: 'turn-2' })
  })

  it('one turn mints exactly once however many events arrive', () => {
    const h = harness()
    h.session.refresh()
    h.emit('armed')
    h.emit('armed')
    h.emit('released')
    h.emit('released')
    h.session.onSpeechFinished({ ok: true })
    expect(h.deps.activation.mint).toHaveBeenCalledOnce()
  })

  it('a release or abort with no turn does nothing', () => {
    const h = harness()
    h.session.refresh()
    h.emit('released')
    h.emit('aborted')
    h.emit('latch-ended')
    expect(h.events.end).toHaveLength(0)
    expect(h.deps.stopVoiceLease).not.toHaveBeenCalled()
  })
})

describe('VoiceSession renderer reports', () => {
  it('a capture failure from the renderer fails the current turn with the right copy and closes it', () => {
    const h = harness()
    h.session.refresh()
    h.emit('armed')
    h.session.report({ turnId: 'turn-1', phase: 'failed', reason: 'microphone_unavailable' })
    expect(h.last()).toMatchObject({
      state: 'failed',
      reason: 'microphone_unavailable',
      message: voiceReasonCopy('microphone_unavailable')
    })
    expect(h.events.end).toEqual([{ turnId: 'turn-1', cancelled: true }])
    expect(h.deps.activation.revoke).toHaveBeenCalled()
  })

  it('a report for another turn, or an unknown one, is ignored', () => {
    const h = harness()
    h.session.refresh()
    h.emit('armed')
    h.session.report({ turnId: 'turn-9', phase: 'failed', reason: 'microphone_unavailable' })
    expect(h.last()?.state).toBe('listening')
    h.emit('aborted')
    h.session.report({ turnId: 'turn-1', phase: 'failed', reason: 'microphone_unavailable' })
    expect(h.last()?.state).toBe('idle')
  })

  it('fails the turn when the renderer never reports a capture within five seconds', () => {
    const h = harness()
    h.session.refresh()
    h.emit('armed')
    vi.advanceTimersByTime(4_999)
    expect(h.last()?.state).toBe('listening')
    vi.advanceTimersByTime(1)
    expect(h.last()).toMatchObject({ state: 'failed', reason: 'microphone_unavailable' })
  })

  it('a capturing report cancels the start watchdog', () => {
    const h = harness()
    h.session.refresh()
    h.emit('armed')
    h.session.report({ turnId: 'turn-1', phase: 'capturing' })
    vi.advanceTimersByTime(6_000)
    expect(h.last()?.state).toBe('listening')
  })
})

describe('VoiceSession refusals: no microphone, no activation, no lease', () => {
  const expectRefused = (h: ReturnType<typeof harness>, reason: string): void => {
    expect(h.deps.activation.mint).not.toHaveBeenCalled()
    expect(h.deps.push.begin).not.toHaveBeenCalled()
    expect(h.deps.speech.prewarm).not.toHaveBeenCalled()
    expect(h.last()).toMatchObject({ state: 'failed', reason, turnId: null })
    expect(h.last()?.message).toBe(voiceReasonCopy(reason as never))
    vi.advanceTimersByTime(4_000)
    expect(h.last()?.state).toBe('idle')
  }

  it('refuses while Métis records a meeting and never touches capture', () => {
    const h = harness()
    h.session.refresh()
    h.gate.meetingReserved = true
    h.emit('armed')
    expectRefused(h, 'meeting_recording')
    expect(h.deps.stopVoiceLease).not.toHaveBeenCalled()
    expect(h.deps.activation.revoke).not.toHaveBeenCalled()
    expect(voiceReasonCopy('meeting_recording')).toMatch(/paused while Métis records a meeting/)
  })

  it.each([
    ['signed out', { signedIn: false }, 'signed_out'],
    ['onboarding', { onboardingActive: true }, 'onboarding_active'],
    ['hidden window', { windowVisible: false }, 'window_hidden'],
    ['the panel capturing', { explicitLeaseActive: true }, 'panel_active'],
    ['a managed cloud-only profile', { availability: { ok: false, reason: 'policy_blocked' } }, 'policy_blocked'],
    ['no speech model', { availability: { ok: false, reason: 'unsupported_engine' } }, 'speech_unavailable']
  ] as const)('refuses on %s', (_name, patch, reason) => {
    const h = harness()
    h.session.refresh()
    Object.assign(h.gate, patch)
    h.emit('armed')
    expectRefused(h, reason)
  })

  it('refuses when main cannot mint the hardware activation, without telling the renderer to open a microphone', () => {
    const h = harness()
    h.session.refresh()
    h.setMint(false)
    h.emit('armed')
    expect(h.deps.push.begin).not.toHaveBeenCalled()
    expect(h.last()).toMatchObject({ state: 'failed', reason: 'not_ready' })
  })

  it('does not refuse for an ambient lease: the explicit turn preempts it at lease time', () => {
    const h = harness()
    h.session.refresh()
    h.emit('armed')
    expect(h.last()?.state).toBe('listening')
  })

  it('a refusal while thinking supersedes and cancels the previous turn first', () => {
    const h = harness()
    h.session.refresh()
    h.emit('armed')
    h.emit('released')
    h.gate.meetingReserved = true
    h.emit('armed')
    expect(h.events.end).toContainEqual({ turnId: 'turn-1', cancelled: true })
    expect(h.last()).toMatchObject({ state: 'failed', reason: 'meeting_recording' })
  })
})

describe('VoiceSession owner-session lifecycle revocation', () => {
  it.each([
    ['screen-locked', 'screen_locked'],
    ['system-suspend', 'system_suspend'],
    ['sign-out', 'session_ended'],
    ['auth-revoked', 'session_ended'],
    ['window-hidden', 'window_hidden'],
    ['renderer-reset', 'renderer_reset'],
    ['owner-replaced', 'renderer_reset']
  ] as const)('a %s hard stop revokes a listening turn and says why', (stop, reason) => {
    const h = harness()
    h.session.refresh()
    h.emit('armed')
    h.session.onHardStop(stop)
    expect(h.events.end).toEqual([{ turnId: 'turn-1', cancelled: true }])
    expect(h.deps.activation.revoke).toHaveBeenCalled()
    expect(h.last()).toMatchObject({ state: 'failed', reason, turnId: null })
  })

  it('also revokes a turn that has no lease yet and one that is thinking', () => {
    const h = harness()
    h.session.refresh()
    h.emit('armed')
    h.emit('released')
    h.session.onHardStop('screen-locked')
    expect(h.last()).toMatchObject({ state: 'failed', reason: 'screen_locked' })
    h.session.onSpeechFinished({ ok: true })
    expect(h.last()).toMatchObject({ state: 'failed', reason: 'screen_locked' })
  })

  it('quitting is silent', () => {
    const h = harness()
    h.session.refresh()
    h.emit('armed')
    h.session.onHardStop('shutdown')
    expect(h.last()).toMatchObject({ state: 'idle', reason: null, message: null })
    expect(h.events.end).toEqual([{ turnId: 'turn-1', cancelled: true }])
  })

  it('a hard stop with no turn changes nothing', () => {
    const h = harness()
    h.session.refresh()
    const before = h.events.state.length
    h.session.onHardStop('screen-locked')
    expect(h.events.state).toHaveLength(before)
  })

  it('our own cancel does not re-enter through the authority hard stop (one end, one lease stop)', () => {
    const h = harness()
    h.session.refresh()
    ;(h.deps.stopVoiceLease as ReturnType<typeof vi.fn>).mockImplementation(() => {
      h.session.onHardStop('cancelled')
    })
    h.emit('armed')
    h.emit('aborted')
    expect(h.events.end).toHaveLength(1)
    expect(h.deps.stopVoiceLease).toHaveBeenCalledOnce()
    expect(h.last()?.state).toBe('idle')
  })

  it('a hard stop of "cancelled" that we did not issue (the capture timed out) fails the turn as timed out', () => {
    const h = harness()
    h.session.refresh()
    h.emit('armed')
    h.emit('released')
    h.session.onHardStop('cancelled')
    expect(h.last()).toMatchObject({ state: 'failed', reason: 'timeout' })
  })

  it('a meeting that starts during a turn stops it with the meeting copy', () => {
    const h = harness()
    h.session.refresh()
    h.emit('armed')
    h.session.onMeetingReserved()
    expect(h.last()).toMatchObject({
      state: 'failed',
      reason: 'meeting_started',
      message: 'Stopped. A meeting started.'
    })
    expect(h.events.end).toEqual([{ turnId: 'turn-1', cancelled: true }])
  })

  it('a renderer reset revokes the lease under the renderer-reset reason', () => {
    const h = harness()
    h.session.refresh()
    h.emit('armed')
    h.session.onRendererReset()
    expect(h.deps.stopVoiceLease).toHaveBeenCalledWith('renderer-reset')
    expect(h.last()).toMatchObject({ state: 'failed', reason: 'renderer_reset' })
  })

  it('a reset with no turn is a no-op', () => {
    const h = harness()
    h.session.refresh()
    h.session.onRendererReset()
    expect(h.deps.stopVoiceLease).not.toHaveBeenCalled()
  })
})

describe('VoiceSession snapshots, audit and privacy', () => {
  it('pushes every change with a strictly increasing revision, and snapshot() is the latest push', () => {
    const h = harness()
    h.session.refresh()
    h.emit('armed')
    h.emit('released')
    h.session.onSpeechFinished({ ok: true })
    const revisions = h.events.state.map((s) => s.revision)
    expect(revisions).toEqual([...revisions].sort((a, b) => a - b))
    expect(new Set(revisions).size).toBe(revisions.length)
    expect(h.session.snapshot()).toEqual(h.last())
  })

  it('audits only phases and machine reasons, never any text', () => {
    const h = harness()
    h.session.refresh()
    h.emit('armed')
    h.emit('released')
    h.session.onSpeechFinished({ ok: false, reason: 'no_speech' })
    expect(h.events.audit).toEqual([{ phase: 'started' }, { phase: 'finished', reason: 'no_speech' }])
    h.gate.meetingReserved = true
    h.emit('armed')
    expect(h.events.audit.at(-1)).toEqual({ phase: 'refused', reason: 'meeting_recording' })
  })

  it('a snapshot never carries more than the contract fields', () => {
    const h = harness()
    h.session.refresh()
    h.emit('armed')
    expect(Object.keys(h.session.snapshot()).sort()).toEqual(
      ['enabled', 'message', 'reason', 'revision', 'shortcut', 'state', 'turnId'].sort()
    )
  })
})

describe('VoiceSession idle release of the speech helper', () => {
  it('releases the helper ten minutes after the last turn, unless something else is using it', () => {
    const h = harness()
    h.session.refresh()
    h.emit('armed')
    h.emit('released')
    h.session.onSpeechFinished({ ok: true })
    vi.advanceTimersByTime(10 * 60_000 - 1)
    expect(h.deps.speech.releaseIdle).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(h.deps.speech.releaseIdle).toHaveBeenCalledOnce()
  })

  it('a meeting using the speech helper defers the release', () => {
    const h = harness()
    h.session.refresh()
    h.emit('armed')
    h.emit('aborted')
    h.gate.meetingReserved = true
    vi.advanceTimersByTime(10 * 60_000)
    expect(h.deps.speech.releaseIdle).not.toHaveBeenCalled()
    h.gate.meetingReserved = false
    vi.advanceTimersByTime(10 * 60_000)
    expect(h.deps.speech.releaseIdle).toHaveBeenCalledOnce()
  })

  it('a new turn restarts the idle clock', () => {
    const h = harness()
    h.session.refresh()
    h.emit('armed')
    h.emit('aborted')
    vi.advanceTimersByTime(9 * 60_000)
    h.emit('armed')
    h.emit('aborted')
    vi.advanceTimersByTime(9 * 60_000)
    expect(h.deps.speech.releaseIdle).not.toHaveBeenCalled()
  })
})
