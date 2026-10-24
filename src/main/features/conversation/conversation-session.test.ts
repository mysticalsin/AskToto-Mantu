import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CONVERSATION_LIMITS,
  conversationReasonCopy,
  ConversationSnapshotSchema,
  type ConversationReason,
  type ConversationSnapshot,
  type ConversationStartResult
} from '@shared/conversation/conversation-session'
import type { InputSessionStopReason, TrustedInputOwner } from '@shared/input-session'
import {
  ConversationSession,
  type ConversationReplyToken,
  type ConversationSessionDeps,
  type ConversationUtteranceDispatch
} from './conversation-session'

type Availability = ReturnType<ConversationSessionDeps['gate']['availability']>

const owner: TrustedInputOwner = {
  webContentsId: 51,
  frameId: '1:main',
  isTopFrame: true,
  authSessionGeneration: 2,
  contextRevision: 3
}

function harness(initial: { enabled?: boolean; reply?: boolean } = {}) {
  const config = { enabled: initial.enabled ?? true }
  const gate = {
    signedIn: true,
    meetingReserved: false,
    onboardingActive: false,
    windowVisible: true,
    captureBusy: false,
    availability: { ok: true } as Availability
  }
  const events = {
    states: [] as ConversationSnapshot[],
    audit: [] as Array<{ phase: string; reason?: string }>,
    order: [] as string[],
    ended: [] as Array<{ sessionId: string; reason: ConversationReason }>
  }
  let currentOwner: TrustedInputOwner | null = { ...owner }
  let beginResult: { ok: true } | { ok: false; reason: ConversationReason } = { ok: true }
  const captureDispatches: ConversationUtteranceDispatch[] = []
  let beforeBegin:
    | ((dispatch: ConversationUtteranceDispatch) => { ok: true } | { ok: false; reason: ConversationReason })
    | null = null
  const begin = vi.fn((dispatch: ConversationUtteranceDispatch) => {
    events.order.push(`begin:${dispatch.maxMs}`)
    captureDispatches.push(dispatch)
    const hook = beforeBegin
    beforeBegin = null
    return hook?.(dispatch) ?? beginResult
  })
  const cancel = vi.fn((captureToken: string) => void events.order.push(`utterance-cancel:${captureToken}`))
  const replyCancel = vi.fn(
    (token: ConversationReplyToken) => void events.order.push(`reply-cancel:${token.sessionId}:${token.generation}`)
  )
  const pushState = vi.fn((snapshot: ConversationSnapshot) => void events.states.push(snapshot))
  const audit = vi.fn(
    (phase: string, detail?: { reason?: string }) =>
      void events.audit.push({ phase, ...(detail?.reason ? { reason: detail.reason } : {}) })
  )
  let n = 0
  let session!: ConversationSession
  const onEnded = vi.fn(
    (sessionId: string, reason: ConversationReason) => void events.ended.push({ sessionId, reason })
  )
  const deps: ConversationSessionDeps = {
    owner: () => currentOwner,
    settings: () => ({ enabled: config.enabled }),
    gate: {
      signedIn: () => gate.signedIn,
      meetingReserved: () => gate.meetingReserved,
      onboardingActive: () => gate.onboardingActive,
      windowVisible: () => gate.windowVisible,
      captureBusy: () => gate.captureBusy,
      availability: () => gate.availability
    },
    utterance: { begin, cancel },
    ...(initial.reply === false ? {} : { reply: { cancel: replyCancel } }),
    push: { state: pushState },
    newSessionId: () => `conv-${++n}`,
    now: () => Date.now(),
    onEnded,
    audit
  }
  session = new ConversationSession(deps)
  session.refresh()
  return {
    session,
    gate,
    config,
    events,
    begin,
    cancel,
    replyCancel,
    onEnded,
    pushState,
    audit,
    captureDispatches,
    end(outcome: Parameters<ConversationUtteranceDispatch['onEnded']>[0]) {
      const current = captureDispatches.at(-1)
      if (!current) throw new Error('no capture dispatch')
      current.onEnded(outcome)
    },
    setBegin: (result: typeof beginResult) => void (beginResult = result),
    setBeforeBegin(callback: typeof beforeBegin) {
      beforeBegin = callback
    },
    setOwner(value: TrustedInputOwner | null) {
      currentOwner = value
    },
    last: () => events.states.at(-1)
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1_000_000)
})
afterEach(() => vi.useRealTimers())

const MIN = 60_000

describe('ConversationSession start is explicit and gated', () => {
  it('stays off while the feature is disabled and a start is refused without opening anything', () => {
    const h = harness({ enabled: false })
    expect(h.session.snapshot()).toMatchObject({ state: 'off', enabled: false, active: false })
    expect(h.session.start()).toEqual({ ok: false, reason: 'disabled' })
    expect(h.begin).not.toHaveBeenCalled()
  })

  it('never starts by itself: enabling, refreshing and the passage of time leave it idle', () => {
    const h = harness()
    h.session.refresh()
    vi.advanceTimersByTime(40 * MIN)
    expect(h.session.snapshot()).toMatchObject({ state: 'idle', active: false, sessionId: null })
    expect(h.begin).not.toHaveBeenCalled()
  })

  it('start opens the first listening window and shows the indicator state with deadlines and labelled limits', () => {
    const h = harness()
    expect(h.session.start()).toEqual({ ok: true })
    const s = h.session.snapshot()
    expect(ConversationSnapshotSchema.safeParse(s).success).toBe(true)
    expect(s).toMatchObject({
      state: 'listening',
      active: true,
      stopAvailable: true,
      sessionId: 'conv-1',
      startedAt: 1_000_000,
      idleExpiresAt: 1_000_000 + CONVERSATION_LIMITS.idleMs,
      maxExpiresAt: 1_000_000 + CONVERSATION_LIMITS.maxMs,
      limits: { idleMs: 5 * MIN, maxMs: 30 * MIN, status: 'PROPOSED' }
    })
    expect(h.begin).toHaveBeenCalledWith(expect.objectContaining({ maxMs: CONVERSATION_LIMITS.windowMs }))
    expect(h.events.audit).toEqual([{ phase: 'started' }])
  })

  it('a second start while running is a no-op: one session, one window', () => {
    const h = harness()
    h.session.start()
    expect(h.session.start()).toEqual({ ok: true })
    expect(h.begin).toHaveBeenCalledOnce()
    expect(h.session.snapshot().sessionId).toBe('conv-1')
  })

  it.each([
    ['signedIn', false, 'signed_out'],
    ['meetingReserved', true, 'meeting_recording'],
    ['onboardingActive', true, 'onboarding_active'],
    ['windowVisible', false, 'window_hidden'],
    ['captureBusy', true, 'capture_busy']
  ] as const)('refuses when %s=%s with reason %s and opens no microphone', (key, value, reason) => {
    const h = harness()
    ;(h.gate as Record<string, unknown>)[key] = value
    expect(h.session.start()).toEqual({ ok: false, reason })
    expect(h.begin).not.toHaveBeenCalled()
    expect(h.session.snapshot()).toMatchObject({ state: 'ended', active: false, reason })
    expect(h.session.snapshot().message).toBe(conversationReasonCopy(reason))
    expect(h.events.audit).toEqual([{ phase: 'refused', reason }])
  })

  it.each([
    [{ ok: false, reason: 'policy_blocked' }, 'policy_blocked'],
    [{ ok: false, reason: 'unsupported_engine' }, 'speech_unavailable'],
    [{ ok: false, reason: 'unauthorized' }, 'signed_out']
  ] as const)('speech availability %j refuses with %s', (availability, reason) => {
    const h = harness()
    h.gate.availability = availability as Availability
    expect(h.session.start()).toEqual({ ok: false, reason })
  })

  it('a refused start flashes the reason then returns to idle', () => {
    const h = harness()
    h.gate.meetingReserved = true
    h.session.start()
    expect(h.session.snapshot().state).toBe('ended')
    vi.advanceTimersByTime(5_000)
    expect(h.session.snapshot()).toMatchObject({ state: 'idle', reason: null, message: null })
  })

  it('if the first window cannot open the session never exists', () => {
    const h = harness()
    h.setBegin({ ok: false, reason: 'microphone_unavailable' })
    expect(h.session.start()).toEqual({ ok: false, reason: 'microphone_unavailable' })
    expect(h.session.snapshot()).toMatchObject({ active: false, state: 'ended', reason: 'microphone_unavailable' })
  })
})

describe('ConversationSession utterances', () => {
  it('a recognized utterance extends the idle deadline but never the maximum, and the next window follows', () => {
    const h = harness()
    h.session.start()
    vi.advanceTimersByTime(2 * MIN)
    h.end({ kind: 'recognized' })
    expect(h.session.snapshot().idleExpiresAt).toBe(1_000_000 + 2 * MIN + CONVERSATION_LIMITS.idleMs)
    expect(h.session.snapshot().maxExpiresAt).toBe(1_000_000 + CONVERSATION_LIMITS.maxMs)
    vi.advanceTimersByTime(1_000)
    expect(h.begin).toHaveBeenCalledTimes(2)
    expect(h.session.snapshot().state).toBe('listening')
  })

  it('keeps capture closed while the exact recognized turn is pending in Ask', () => {
    const h = harness()
    h.session.start()
    h.end({ kind: 'recognized' })
    const token = h.session.currentReplyToken()
    expect(token).not.toBeNull()
    expect(h.session.isCurrentReply(owner, token!)).toBe(true)
    expect(h.session.replyPending(owner, token!)).toBe(true)
    expect(h.session.snapshot()).toMatchObject({ state: 'thinking', replyGeneration: token!.generation })
    vi.advanceTimersByTime(500)
    expect(h.begin).toHaveBeenCalledOnce()
    expect(h.session.isCurrentReply(owner, token!)).toBe(true)

    h.session.replyStarted(token!)
    expect(h.session.snapshot().state).toBe('replying')
    h.session.replyFinished(token!)
    expect(h.session.currentReplyToken()).toBeNull()
    vi.advanceTimersByTime(400)
    expect(h.begin).toHaveBeenCalledTimes(2)
    expect(h.session.snapshot().state).toBe('listening')
  })

  it('rejects a pending reply for a replaced owner or stale generation', () => {
    const h = harness()
    h.session.start()
    h.end({ kind: 'recognized' })
    const token = h.session.currentReplyToken()!
    expect(h.session.replyPending(owner, { ...token, generation: token.generation + 1 })).toBe(false)
    h.setOwner({ ...owner, contextRevision: owner.contextRevision + 1 })
    expect(h.session.replyPending(owner, token)).toBe(false)
    expect(h.session.snapshot().state).toBe('ended')
    vi.advanceTimersByTime(500)
    expect(h.begin).toHaveBeenCalledOnce()
  })

  it('a silent window does not count as activity and listening continues', () => {
    const h = harness()
    h.session.start()
    const idle = h.session.snapshot().idleExpiresAt
    vi.advanceTimersByTime(10_000)
    h.end({ kind: 'silent' })
    vi.advanceTimersByTime(1_000)
    expect(h.begin).toHaveBeenCalledTimes(2)
    expect(h.session.snapshot().idleExpiresAt).toBe(idle)
    expect(h.session.snapshot().state).toBe('listening')
  })

  it('new input cancels the previous reply and bumps the reply generation, before anything else', () => {
    const h = harness()
    h.session.start()
    expect(h.session.snapshot().replyGeneration).toBe(0)
    h.end({ kind: 'recognized' })
    const replyToken = h.session.currentReplyToken()
    if (!replyToken) throw new Error('expected pending reply token')
    expect(h.replyCancel).not.toHaveBeenCalled()
    expect(h.session.snapshot().replyGeneration).toBe(1)
    vi.advanceTimersByTime(400)
    h.end({ kind: 'recognized' })
    expect(h.replyCancel).toHaveBeenCalledExactlyOnceWith(replyToken)
    expect(h.session.snapshot().replyGeneration).toBe(2)
  })

  it('works with no reply port bound (G27 absent): nothing is spoken and nothing breaks', () => {
    const h = harness({ reply: false })
    h.session.start()
    h.end({ kind: 'recognized' })
    expect(h.session.snapshot().replyGeneration).toBe(1)
  })

  it('a failed window ends the session with the machine reason and its fixed copy', () => {
    const h = harness()
    h.session.start()
    h.end({ kind: 'failed', reason: 'device_lost' })
    expect(h.session.snapshot()).toMatchObject({ state: 'ended', active: false, reason: 'device_lost' })
    expect(h.session.snapshot().message).toBe(conversationReasonCopy('device_lost'))
    expect(h.begin).toHaveBeenCalledOnce()
  })

  it('a cancelled window (another hold took it) is retried, and repeated refusals to reopen end the session', () => {
    const h = harness()
    h.session.start()
    h.end({ kind: 'cancelled' })
    h.setBegin({ ok: false, reason: 'capture_busy' })
    vi.advanceTimersByTime(10_000)
    expect(h.events.ended.at(-1)).toEqual({ sessionId: 'conv-1', reason: 'capture_busy' })
    expect(h.session.snapshot()).toMatchObject({ active: false })
    expect(h.begin.mock.calls.length).toBeGreaterThan(2)
    expect(h.begin.mock.calls.length).toBeLessThanOrEqual(8)
  })

  it('a transient refusal to reopen recovers when the next try succeeds', () => {
    const h = harness()
    h.session.start()
    h.setBegin({ ok: false, reason: 'capture_busy' })
    h.end({ kind: 'silent' })
    vi.advanceTimersByTime(500)
    h.setBegin({ ok: true })
    vi.advanceTimersByTime(1_000)
    expect(h.session.snapshot()).toMatchObject({ state: 'listening', active: true })
  })
})

describe('ConversationSession expiry', () => {
  it('ends after the idle period with the idle reason', () => {
    const h = harness()
    h.session.start()
    vi.advanceTimersByTime(5 * MIN - 1)
    expect(h.session.snapshot().active).toBe(true)
    vi.advanceTimersByTime(2)
    expect(h.session.snapshot()).toMatchObject({ state: 'ended', reason: 'idle_timeout', active: false })
    expect(h.cancel).toHaveBeenCalledOnce()
    expect(h.replyCancel).not.toHaveBeenCalled()
  })

  it('keeps going while utterances arrive, then ends at the 30 minute maximum', () => {
    const h = harness()
    h.session.start()
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(4 * MIN)
      h.end({ kind: 'recognized' })
    }
    expect(h.session.snapshot().active).toBe(true)
    vi.advanceTimersByTime(4 * MIN)
    h.end({ kind: 'recognized' })
    vi.advanceTimersByTime(4 * MIN)
    h.end({ kind: 'recognized' })
    vi.advanceTimersByTime(2 * MIN)
    expect(h.events.ended.at(-1)).toEqual({ sessionId: 'conv-1', reason: 'max_duration' })
    expect(h.session.snapshot()).toMatchObject({ active: false })
  })

  it('honours injected limits', () => {
    const h = harness()
    const short = new ConversationSession({
      ...(h.session as unknown as { deps: ConversationSessionDeps }).deps,
      settings: () => ({ enabled: true }),
      gate: {
        signedIn: () => true,
        meetingReserved: () => false,
        onboardingActive: () => false,
        windowVisible: () => true,
        captureBusy: () => false,
        availability: () => ({ ok: true })
      },
      utterance: {
        begin: (_dispatch: ConversationUtteranceDispatch) => ({ ok: true }),
        cancel: (_captureToken: string) => {}
      },
      push: { state: () => {} },
      newSessionId: () => 'x',
      now: () => Date.now(),
      limits: { idleMs: 1_000, maxMs: 5_000 }
    })
    short.refresh()
    short.start()
    vi.advanceTimersByTime(1_001)
    expect(short.snapshot()).toMatchObject({ reason: 'idle_timeout' })
  })
})

describe('ConversationSession stop and revocation', () => {
  it('stop ends the session, cancels its pending reply, and is idempotent', () => {
    const h = harness()
    h.session.start()
    h.end({ kind: 'recognized' })
    const replyToken = h.session.currentReplyToken()
    if (!replyToken) throw new Error('expected pending reply token')
    expect(h.session.stop()).toEqual({ ok: true })
    expect(h.session.snapshot()).toMatchObject({
      state: 'ended',
      reason: 'user_stop',
      active: false,
      stopAvailable: false
    })
    expect(h.cancel).not.toHaveBeenCalled()
    expect(h.replyCancel).toHaveBeenCalledExactlyOnceWith(replyToken)
    const revision = h.session.snapshot().revision
    expect(h.session.stop()).toEqual({ ok: true })
    expect(h.session.snapshot().revision).toBe(revision)
    // The recognized capture was already consumed, and no next window opened before Stop.
    expect(h.cancel).not.toHaveBeenCalled()
    expect(h.events.ended).toEqual([{ sessionId: 'conv-1', reason: 'user_stop' }])
  })

  it('stop on a conversation that never started is harmless', () => {
    const h = harness()
    expect(h.session.stop()).toEqual({ ok: true })
    expect(h.session.snapshot().state).toBe('idle')
  })

  it('a late utterance outcome after stop cannot reopen the microphone', () => {
    const h = harness()
    h.session.start()
    h.session.stop()
    h.end({ kind: 'recognized' })
    h.end({ kind: 'silent' })
    vi.advanceTimersByTime(10_000)
    expect(h.begin).toHaveBeenCalledOnce()
    expect(h.session.snapshot().replyGeneration).toBe(0)
  })

  it.each([
    ['sign-out', 'session_ended'],
    ['auth-revoked', 'session_ended'],
    ['screen-locked', 'screen_locked'],
    ['system-suspend', 'system_suspend'],
    ['shutdown', 'shutdown'],
    ['renderer-reset', 'renderer_reset'],
    ['owner-replaced', 'renderer_reset'],
    ['window-hidden', 'window_hidden']
  ] as Array<[InputSessionStopReason, ConversationReason]>)('hard stop %s ends the session as %s', (stop, reason) => {
    const h = harness()
    h.session.start()
    h.session.onHardStop(stop)
    expect(h.session.snapshot()).toMatchObject({ state: 'ended', reason, active: false })
    h.session.onHardStop(stop)
    expect(h.events.ended).toEqual([{ sessionId: 'conv-1', reason }])
    vi.advanceTimersByTime(10_000)
    expect(h.begin).toHaveBeenCalledOnce()
  })

  it.each([
    'cancelled',
    'device-change',
    'user-stop',
    'arbitration-preempted'
  ] as InputSessionStopReason[])('a turn-level stop (%s) does not end the session', (stop) => {
    const h = harness()
    h.session.start()
    h.session.onHardStop(stop)
    expect(h.session.snapshot().active).toBe(true)
  })

  it('a meeting starting ends the session and a meeting recording never lets one start', () => {
    const h = harness()
    h.session.start()
    h.session.onMeetingReserved()
    expect(h.session.snapshot()).toMatchObject({ state: 'ended', reason: 'meeting_started' })
    h.gate.meetingReserved = true
    expect(h.session.start()).toEqual({ ok: false, reason: 'meeting_recording' })
  })

  it('a renderer reset ends the session', () => {
    const h = harness()
    h.session.start()
    h.session.onRendererReset()
    expect(h.session.snapshot()).toMatchObject({ state: 'ended', reason: 'renderer_reset' })
  })

  it('disposing (quit) ends the session silently and stops all timers', () => {
    const h = harness()
    h.session.start()
    h.session.dispose()
    expect(h.cancel).toHaveBeenCalled()
    vi.advanceTimersByTime(60 * MIN)
    expect(h.begin).toHaveBeenCalledOnce()
    expect(h.session.start()).toEqual({ ok: false, reason: 'disabled' })
  })

  it('turning the feature off while running ends it and reads off; sign-out or a meeting seen by a poll ends it too', () => {
    const h = harness()
    h.session.start()
    h.config.enabled = false
    h.session.refresh()
    expect(h.session.snapshot()).toMatchObject({ state: 'off', active: false, enabled: false })
    expect(h.cancel).toHaveBeenCalled()

    const g = harness()
    g.session.start()
    g.gate.signedIn = false
    g.session.refresh()
    expect(g.session.snapshot()).toMatchObject({ state: 'ended', reason: 'session_ended' })

    const m = harness()
    m.session.start()
    m.gate.meetingReserved = true
    m.session.refresh()
    expect(m.session.snapshot()).toMatchObject({ state: 'ended', reason: 'meeting_started' })
  })

  it('an ended session flashes its reason then returns to idle, and can be started again', () => {
    const h = harness()
    h.session.start()
    h.session.stop()
    vi.advanceTimersByTime(5_000)
    expect(h.session.snapshot()).toMatchObject({ state: 'idle', reason: null })
    expect(h.session.start()).toEqual({ ok: true })
    expect(h.session.snapshot().sessionId).toBe('conv-2')
  })
})

describe('ConversationSession synchronous lifecycle boundaries', () => {
  it('publishes active Stop state before dispatch and honors a synchronous Stop from the observer', () => {
    const h = harness()
    h.pushState.mockImplementationOnce((snapshot) => {
      h.events.states.push(snapshot)
      if (snapshot.state === 'listening') h.session.stop()
    })

    expect(h.session.start()).toEqual({ ok: true })

    expect(h.begin).not.toHaveBeenCalled()
    expect(h.session.snapshot()).toMatchObject({ active: false, state: 'ended', reason: 'user_stop' })
    expect(h.events.ended).toEqual([{ sessionId: 'conv-1', reason: 'user_stop' }])
  })

  it('does not overwrite a synchronous completion delivered by begin', () => {
    const h = harness()
    h.setBeforeBegin((dispatch) => {
      dispatch.onEnded({ kind: 'recognized' })
      return { ok: true }
    })

    expect(h.session.start()).toEqual({ ok: true })

    expect(h.session.snapshot()).toMatchObject({ active: true, state: 'thinking', replyGeneration: 1 })
    expect(h.session.currentReplyToken()).toEqual({ sessionId: 'conv-1', generation: 1 })
    expect(h.begin).toHaveBeenCalledOnce()
  })

  it('preserves a synchronous Stop then explicit restart from begin after session A is invalidated', () => {
    const h = harness()
    h.setBeforeBegin(() => {
      h.session.stop()
      expect(h.session.start()).toEqual({ ok: true })
      return { ok: true }
    })

    expect(h.session.start()).toEqual({ ok: true })

    expect(h.session.snapshot()).toMatchObject({ active: true, state: 'listening', sessionId: 'conv-2' })
    expect(h.begin).toHaveBeenCalledTimes(2)
    expect(h.events.ended).toEqual([{ sessionId: 'conv-1', reason: 'user_stop' }])
  })

  it('honors synchronous disposal from begin without restoring an active snapshot', () => {
    const h = harness()
    h.setBeforeBegin(() => {
      h.session.dispose()
      return { ok: true }
    })

    expect(h.session.start()).toEqual({ ok: true })

    expect(h.session.snapshot()).toMatchObject({ active: false, stopAvailable: false, state: 'ended' })
    expect(h.events.ended).toEqual([{ sessionId: 'conv-1', reason: 'shutdown' }])
  })

  it('rejects reentrant start from cancellation, audit and end hooks while allowing a later deliberate start', () => {
    const h = harness()
    const reentrantStarts: ConversationStartResult[] = []
    h.cancel.mockImplementationOnce(() => {
      reentrantStarts.push(h.session.start())
    })
    h.audit.mockImplementation((phase) => {
      if (phase === 'ended') reentrantStarts.push(h.session.start())
    })
    h.onEnded.mockImplementationOnce(() => {
      reentrantStarts.push(h.session.start())
    })

    h.session.start()
    h.session.stop()

    expect(h.session.snapshot()).toMatchObject({ active: false, state: 'ended', reason: 'user_stop' })
    expect(reentrantStarts).toEqual([
      { ok: false, reason: 'capture_busy' },
      { ok: false, reason: 'capture_busy' },
      { ok: false, reason: 'capture_busy' }
    ])
    expect(h.begin).toHaveBeenCalledOnce()
    expect(h.session.start()).toEqual({ ok: true })
    expect(h.begin).toHaveBeenCalledTimes(2)
  })

  it('does not let a refused-start audit flash hide a new session started reentrantly by the audit hook', () => {
    const h = harness()
    h.gate.captureBusy = true
    let nestedResult: ConversationStartResult | undefined
    h.audit.mockImplementationOnce((phase) => {
      if (phase !== 'refused') return
      h.gate.captureBusy = false
      nestedResult = h.session.start()
    })

    expect(h.session.start()).toEqual({ ok: false, reason: 'capture_busy' })

    expect(nestedResult).toEqual({ ok: true })
    expect(h.session.snapshot()).toMatchObject({ active: true, state: 'listening', sessionId: 'conv-1' })
    expect(h.begin).toHaveBeenCalledOnce()
    expect(h.events.ended).toEqual([])
  })

  it('does not arm a stale refusal flash after its state push starts a new session', () => {
    const h = harness()
    h.gate.captureBusy = true
    let nestedResult: ConversationStartResult | undefined
    h.pushState.mockImplementation((snapshot) => {
      h.events.states.push(snapshot)
      if (snapshot.state === 'ended' && snapshot.reason === 'capture_busy') {
        h.gate.captureBusy = false
        nestedResult = h.session.start()
      }
    })

    expect(h.session.start()).toEqual({ ok: false, reason: 'capture_busy' })

    expect(nestedResult).toEqual({ ok: true })
    expect(h.session.snapshot()).toMatchObject({ active: true, state: 'listening', sessionId: 'conv-1' })
    // Only the active session's expiry timer remains; the rejected attempt owns no flash timer.
    expect(vi.getTimerCount()).toBe(1)
  })

  it('does not install a session when the off-to-idle observer disposes synchronously', () => {
    const h = harness({ enabled: false })
    let disposedFromIdle = false
    h.pushState.mockImplementationOnce((snapshot) => {
      h.events.states.push(snapshot)
      if (snapshot.state === 'idle') {
        disposedFromIdle = true
        h.session.dispose()
      }
    })
    h.config.enabled = true

    expect(h.session.start()).toEqual({ ok: false, reason: 'disabled' })

    expect(disposedFromIdle).toBe(true)
    expect(h.session.snapshot()).toMatchObject({ active: false, stopAvailable: false, state: 'ended' })
    expect(h.begin).not.toHaveBeenCalled()
    expect(h.events.ended).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not arm a reason-flash timer when disposal reenters from the terminal state push', () => {
    const h = harness()
    h.session.start()
    h.pushState.mockImplementationOnce((snapshot) => {
      h.events.states.push(snapshot)
      if (snapshot.state === 'ended') h.session.dispose()
    })

    h.session.stop()

    expect(h.session.snapshot()).toMatchObject({
      active: false,
      stopAvailable: false,
      state: 'ended',
      reason: 'user_stop'
    })
    expect(h.events.ended).toEqual([{ sessionId: 'conv-1', reason: 'user_stop' }])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('ends exactly once when the initial capture dispatch fails', () => {
    const h = harness()
    h.setBegin({ ok: false, reason: 'not_ready' })

    expect(h.session.start()).toEqual({ ok: false, reason: 'not_ready' })
    h.captureDispatches[0].onEnded({ kind: 'recognized' })

    expect(h.events.ended).toEqual([{ sessionId: 'conv-1', reason: 'not_ready' }])
    expect(h.session.snapshot()).toMatchObject({ active: false, reason: 'not_ready' })
  })
})

describe('ConversationSession captured callback identity regressions', () => {
  it('captures a frozen main-owned owner copy in each capture dispatch', () => {
    const h = harness()
    h.session.start()
    expect(h.captureDispatches[0].owner).toEqual(owner)
    expect(h.captureDispatches[0].owner).not.toBe(owner)
    expect(Object.isFrozen(h.captureDispatches[0].owner)).toBe(true)
  })

  it('ignores a held utterance completion from stopped session A after session B starts', () => {
    const h = harness()
    h.session.start()
    const dispatchA = h.captureDispatches[0]

    h.session.stop()
    h.session.start()
    dispatchA.onEnded({ kind: 'recognized' })

    expect(h.session.snapshot()).toMatchObject({
      state: 'listening',
      active: true,
      sessionId: 'conv-2',
      replyGeneration: 0
    })
    expect(h.begin).toHaveBeenCalledTimes(2)
  })

  it('ignores late reply-start and reply-finish tokens from stopped session A', () => {
    const h = harness()
    h.session.start()
    h.end({ kind: 'recognized' })
    const replyA = h.session.currentReplyToken()
    if (!replyA) throw new Error('expected reply token for session A')

    h.session.stop()
    h.session.start()
    h.session.replyStarted(replyA)
    h.session.replyFinished(replyA)

    expect(h.session.snapshot()).toMatchObject({
      state: 'listening',
      active: true,
      sessionId: 'conv-2',
      // Reply generations are session-service-wide and never move backwards.
      replyGeneration: 1
    })
    expect(h.cancel).not.toHaveBeenCalled()
  })

  it('consumes one capture completion at most once', () => {
    const h = harness()
    h.session.start()
    const dispatch = h.captureDispatches[0]

    dispatch.onEnded({ kind: 'recognized' })
    dispatch.onEnded({ kind: 'recognized' })

    expect(h.session.snapshot().replyGeneration).toBe(1)
    expect(h.session.snapshot().state).toBe('thinking')
  })

  it.each([
    ['window owner', { ...owner, webContentsId: owner.webContentsId + 1 }],
    ['auth generation', { ...owner, authSessionGeneration: owner.authSessionGeneration + 1 }],
    ['context revision', { ...owner, contextRevision: owner.contextRevision + 1 }]
  ] as const)('rejects a completion after the same session owner %s changes', (_label, nextOwner) => {
    const h = harness()
    h.session.start()
    const dispatch = h.captureDispatches[0]
    h.setOwner(nextOwner)

    dispatch.onEnded({ kind: 'recognized' })

    expect(h.session.snapshot()).toMatchObject({
      state: 'ended',
      active: false,
      reason: 'renderer_reset',
      replyGeneration: 0
    })
    expect(h.begin).toHaveBeenCalledOnce()
    expect(h.events.ended).toEqual([{ sessionId: 'conv-1', reason: 'renderer_reset' }])
  })

  it('expires instead of accepting a queued completion after its captured idle deadline', () => {
    const h = harness()
    h.session.start()
    const dispatch = h.captureDispatches[0]
    const deadline = h.session.snapshot().idleExpiresAt
    if (deadline === null) throw new Error('expected active idle deadline')

    vi.setSystemTime(deadline + 1)
    dispatch.onEnded({ kind: 'recognized' })

    expect(h.session.snapshot()).toMatchObject({
      state: 'ended',
      active: false,
      reason: 'idle_timeout',
      replyGeneration: 0
    })
    expect(h.session.snapshot().idleExpiresAt).toBeNull()
    expect(h.begin).toHaveBeenCalledOnce()
  })

  it('honors an effective setting change immediately without waiting for refresh', () => {
    const h = harness()
    h.session.start()
    const dispatch = h.captureDispatches[0]
    h.config.enabled = false

    dispatch.onEnded({ kind: 'recognized' })

    expect(h.session.snapshot()).toMatchObject({ state: 'off', active: false, enabled: false, replyGeneration: 0 })
    expect(h.begin).toHaveBeenCalledOnce()
    expect(h.events.ended).toEqual([{ sessionId: 'conv-1', reason: 'disabled' }])
  })

  it('refuses a direct start immediately after the effective setting changes off', () => {
    const h = harness()
    h.config.enabled = false

    expect(h.session.start()).toEqual({ ok: false, reason: 'disabled' })

    expect(h.session.snapshot()).toMatchObject({ state: 'off', active: false, enabled: false })
    expect(h.begin).not.toHaveBeenCalled()
  })

  it('does not open a scheduled relisten after the effective setting changes off', () => {
    const h = harness()
    h.session.start()
    h.end({ kind: 'cancelled' })
    h.config.enabled = false

    vi.advanceTimersByTime(500)

    expect(h.session.snapshot()).toMatchObject({ state: 'off', active: false, enabled: false })
    expect(h.begin).toHaveBeenCalledOnce()
    expect(h.events.ended).toEqual([{ sessionId: 'conv-1', reason: 'disabled' }])
  })

  it('cannot leave an active snapshot when disposal cancellation reenters start', () => {
    const h = harness()
    h.session.start()
    h.cancel.mockImplementationOnce(() => {
      h.session.start()
    })

    h.session.dispose()

    expect(h.session.snapshot()).toMatchObject({ active: false, stopAvailable: false })
    expect(h.session.start()).toEqual({ ok: false, reason: 'disabled' })
    expect(h.begin).toHaveBeenCalledOnce()
  })
})

describe('ConversationSession replies (the G27 seam)', () => {
  it('while a reply plays the microphone window is closed and idle does not run out; finishing resumes listening', () => {
    const h = harness()
    h.session.start()
    h.end({ kind: 'recognized' })
    vi.advanceTimersByTime(400)
    const token = h.session.currentReplyToken()
    if (!token) throw new Error('expected pending reply token')
    h.session.replyStarted(token)
    expect(h.session.snapshot().state).toBe('replying')
    expect(h.cancel).toHaveBeenCalledExactlyOnceWith(h.captureDispatches[1].captureToken)
    vi.advanceTimersByTime(6 * MIN)
    expect(h.session.snapshot()).toMatchObject({ state: 'replying', active: true })
    h.session.replyFinished(token)
    vi.advanceTimersByTime(1_000)
    expect(h.session.snapshot().state).toBe('listening')
    expect(h.session.snapshot().idleExpiresAt).toBeGreaterThan(Date.now())
  })

  it('keeps a relistened window when its pending reply finishes and Stop cancels that exact window', () => {
    const h = harness()
    h.session.start()
    h.end({ kind: 'recognized' })
    const token = h.session.currentReplyToken()
    if (!token) throw new Error('expected pending reply token')

    vi.advanceTimersByTime(400)
    const relistened = h.captureDispatches[1]
    if (!relistened) throw new Error('expected relistened capture dispatch')
    h.session.replyFinished(token)
    vi.advanceTimersByTime(400)

    expect(h.begin).toHaveBeenCalledTimes(2)
    expect(h.session.snapshot()).toMatchObject({ state: 'listening', active: true })
    h.session.stop()
    expect(h.cancel).toHaveBeenCalledExactlyOnceWith(relistened.captureToken)
  })

  it('accepts completion from the retained relistened window before opening its successor', () => {
    const h = harness()
    h.session.start()
    h.end({ kind: 'recognized' })
    const token = h.session.currentReplyToken()
    if (!token) throw new Error('expected pending reply token')
    vi.advanceTimersByTime(400)
    const relistened = h.captureDispatches[1]
    if (!relistened) throw new Error('expected relistened capture dispatch')

    h.session.replyFinished(token)
    vi.advanceTimersByTime(400)
    expect(h.begin).toHaveBeenCalledTimes(2)
    relistened.onEnded({ kind: 'silent' })
    vi.advanceTimersByTime(400)

    expect(h.begin).toHaveBeenCalledTimes(3)
    expect(h.session.snapshot()).toMatchObject({ active: true, state: 'listening' })
    const successor = h.captureDispatches[2]
    if (!successor) throw new Error('expected successor capture dispatch')
    h.session.stop()
    expect(h.cancel).toHaveBeenCalledExactlyOnceWith(successor.captureToken)
  })

  it('a muted or unavailable reply may finish before playback starts, and a late start is ignored', () => {
    const h = harness()
    h.session.start()
    h.end({ kind: 'recognized' })
    const token = h.session.currentReplyToken()
    if (!token) throw new Error('expected pending reply token')

    h.session.replyFinished(token)
    h.session.replyStarted(token)

    expect(h.session.snapshot().state).toBe('thinking')
    expect(h.session.currentReplyToken()).toBeNull()
    expect(h.cancel).not.toHaveBeenCalled()
  })

  it('ignores an older reply token after a newer recognized turn supersedes it', () => {
    const h = harness()
    h.session.start()
    h.end({ kind: 'recognized' })
    const oldToken = h.session.currentReplyToken()
    if (!oldToken) throw new Error('expected first pending reply token')
    vi.advanceTimersByTime(400)
    h.end({ kind: 'recognized' })
    const currentToken = h.session.currentReplyToken()
    if (!currentToken) throw new Error('expected replacement reply token')

    h.session.replyStarted(oldToken)
    h.session.replyFinished(oldToken)

    expect(h.session.snapshot()).toMatchObject({ state: 'thinking', replyGeneration: 2 })
    expect(h.session.currentReplyToken()).toEqual(currentToken)
  })

  it('consumes a valid reply terminal once and ignores its duplicate', () => {
    const h = harness()
    h.session.start()
    h.end({ kind: 'recognized' })
    const token = h.session.currentReplyToken()
    if (!token) throw new Error('expected pending reply token')

    h.session.replyFinished(token)
    h.session.replyFinished(token)

    expect(h.session.currentReplyToken()).toBeNull()
    expect(h.session.snapshot().state).toBe('thinking')
    expect(h.begin).toHaveBeenCalledOnce()
  })

  it('the hard maximum still ends a session that is replying', () => {
    const h = harness()
    h.session.start()
    h.end({ kind: 'recognized' })
    const token = h.session.currentReplyToken()
    if (!token) throw new Error('expected pending reply token')
    h.session.replyStarted(token)
    vi.advanceTimersByTime(31 * MIN)
    expect(h.events.ended.at(-1)).toEqual({ sessionId: 'conv-1', reason: 'max_duration' })
    expect(h.session.snapshot()).toMatchObject({ active: false })
  })

  it('reply signals with no matching session or generation are ignored', () => {
    const h = harness()
    h.session.replyStarted({ sessionId: 'missing', generation: 1 })
    h.session.replyFinished({ sessionId: 'missing', generation: 1 })
    expect(h.session.snapshot().state).toBe('idle')
  })
})

describe('ConversationSession privacy and publishing', () => {
  it('snapshots and audit carry ids, states, reasons and fixed copy only', () => {
    const h = harness()
    h.session.start()
    h.end({ kind: 'recognized' })
    h.session.stop()
    const text = JSON.stringify([h.events.states, h.events.audit])
    expect(text).not.toMatch(/transcript|utterance text|audio/i)
    for (const s of h.events.states) expect(ConversationSnapshotSchema.safeParse(s).success).toBe(true)
  })

  it('revisions only move forward and identical snapshots are not re-pushed', () => {
    const h = harness()
    h.session.start()
    const revisions = h.events.states.map((s) => s.revision)
    expect([...revisions].sort((a, b) => a - b)).toEqual(revisions)
    expect(new Set(revisions).size).toBe(revisions.length)
  })

  it('a throwing push does not break the session', () => {
    const h = harness()
    ;(h.session as unknown as { deps: ConversationSessionDeps }).deps.push.state = () => {
      throw new Error('renderer gone')
    }
    expect(h.session.start()).toEqual({ ok: true })
  })
})
