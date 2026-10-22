import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_VOICE_ACTIONS_SETTINGS } from '@shared/voice-actions-settings'
import { VOICE_ACTIONS_IPC } from '@shared/voice/voice-turn'
import type { InputSessionLease } from '@shared/input-session'
import type { ChordWatcherEvent, ChordWatcherStatus } from './chord-watcher'
import type { VoiceChordWiringDeps } from './chord-wiring'
import type { DictationHostPorts } from '../features/dictation'
import {
  createCommandMicAvailability,
  createVoiceActionsRuntime,
  type VoiceActionsRuntimeDeps
} from './voice-actions-runtime'

vi.mock('../logger', () => ({ auditLog: vi.fn() }))

// The real wiring spawns a helper and registers power events; the runtime test only needs what the runtime hands it.
const wiringCalls: VoiceChordWiringDeps[] = []
const chordFake = {
  start: vi.fn(),
  refresh: vi.fn(),
  onSignedIn: vi.fn(),
  onInputSessionStop: vi.fn(),
  stop: vi.fn(),
  suspendedReason: () => null,
  status: (): ChordWatcherStatus => chordStatus
}
let chordStatus: ChordWatcherStatus = 'running'
// The runtime builds two watchers: the voice hold first, then the dictation chord (G22). Only the first is under
// test here; the dictation chord gets a separate fake so its calls never count toward the voice assertions.
const dictationChordFake = {
  start: vi.fn(),
  refresh: vi.fn(),
  onSignedIn: vi.fn(),
  onInputSessionStop: vi.fn(),
  stop: vi.fn(),
  suspendedReason: () => null,
  status: (): ChordWatcherStatus => 'running'
}
vi.mock('./chord-wiring', () => ({
  createVoiceChordWiring: (deps: VoiceChordWiringDeps) => {
    wiringCalls.push(deps)
    return wiringCalls.length === 1 ? chordFake : dictationChordFake
  }
}))

const toEvent = (input: string): ChordWatcherEvent => {
  switch (input) {
    case 'released':
      return { type: 'released', reason: 'release' }
    case 'aborted':
      return { type: 'aborted', reason: 'other-input' }
    case 'latch-ended':
      return { type: 'latch-ended', reason: 'press' }
    default:
      return { type: input as 'armed' | 'latched' }
  }
}

const frame = { webContentsId: 7, frameId: '12:3', isTopFrame: true, url: 'app://metis/index.html' }

function lease(source: InputSessionLease['source'], purpose: InputSessionLease['purpose'], sessionId = 'a'.repeat(48)) {
  return {
    sessionId,
    source,
    purpose,
    activation: source === 'wake' || source === 'application-probe' ? 'ambient' : 'explicit',
    authSessionGeneration: 1,
    contextRevision: 1,
    revision: 1,
    startedAt: 1,
    actionAuthority: false
  } as InputSessionLease
}

function setup(
  overrides: Partial<VoiceActionsRuntimeDeps> & {
    stored?: Partial<typeof DEFAULT_VOICE_ACTIONS_SETTINGS>
    qaIdentity?: boolean
    platform?: NodeJS.Platform
  } = {}
) {
  const sent: Array<{ channel: string; payload: unknown }> = []
  wiringCalls.length = 0
  chordStatus = 'running'
  for (const fn of [
    dictationChordFake.start,
    dictationChordFake.refresh,
    dictationChordFake.onSignedIn,
    dictationChordFake.onInputSessionStop,
    dictationChordFake.stop,
    chordFake.start,
    chordFake.refresh,
    chordFake.onSignedIn,
    chordFake.onInputSessionStop,
    chordFake.stop
  ])
    fn.mockClear()
  const state = {
    lease: null as InputSessionLease | null,
    meeting: false,
    visible: true,
    frame: frame as typeof frame | null,
    auth: true,
    stored: { ...DEFAULT_VOICE_ACTIONS_SETTINGS, ...overrides.stored }
  }
  const authority = {
    get activeLease() {
      return state.lease
    },
    get hasMeetingReservation() {
      return state.meeting
    },
    hardStop: vi.fn((reason: string) => {
      state.lease = null
      return reason
    })
  }
  const activation = { mintFromHardware: vi.fn(() => true), revokeHardware: vi.fn() }
  const deps: VoiceActionsRuntimeDeps = {
    platform: overrides.platform ?? 'darwin',
    qaIdentity: overrides.qaIdentity ?? true,
    getSettings: () => ({ voiceActions: state.stored }),
    requireAuth: () => state.auth,
    authority: authority as never,
    activation,
    mainFrame: () => state.frame,
    window: () => ({
      isDestroyed: () => false,
      isVisible: () => state.visible,
      webContents: { send: (channel: string, payload: unknown) => void sent.push({ channel, payload }) }
    }),
    onboardingActive: () => false,
    availability: () => ({ ok: true }),
    parakeet: {
      refreshPresence: vi.fn(async () => true),
      ensure: vi.fn(async () => {}),
      release: vi.fn(async () => {})
    },
    speechBusy: () => false,
    audit: vi.fn(),
    ...overrides
  }
  const runtime = createVoiceActionsRuntime(deps)
  const emit = (event: string | ChordWatcherEvent): void =>
    runtime.onChordEvent(typeof event === 'string' ? toEvent(event) : event)
  const wiring = (): VoiceChordWiringDeps => wiringCalls[0] as VoiceChordWiringDeps
  return { runtime, deps, state, authority, activation, sent, emit, wiring, chord: chordFake }
}

describe('effective enabled: ON in QA builds, OFF in release builds until the flag flips', () => {
  it('a QA build with a fresh profile is enabled and the watcher is told to reconcile', () => {
    const h = setup({ qaIdentity: true })
    h.runtime.start()
    expect(h.chord.start).toHaveBeenCalledOnce()
    expect(h.wiring().enabled()).toBe(true)
    expect(h.runtime.snapshot()).toMatchObject({ enabled: true, shortcut: 'running', state: 'idle' })
  })

  it('a release build with a fresh profile stays off: the watcher is told it is disabled', () => {
    const h = setup({ qaIdentity: false })
    h.runtime.start()
    expect(h.wiring().enabled()).toBe(false)
    expect(h.runtime.snapshot()).toMatchObject({ state: 'off', enabled: false, shortcut: 'stopped' })
  })

  it('an explicit ON in a release build (the Preview toggle) enables it, and an explicit OFF in QA disables it', () => {
    const release = setup({ qaIdentity: false, stored: { enabled: true } })
    expect(release.wiring().enabled()).toBe(true)
    release.runtime.refresh()
    expect(release.runtime.snapshot().enabled).toBe(true)
    const qa = setup({ qaIdentity: true, stored: { enabled: false } })
    expect(qa.wiring().enabled()).toBe(false)
  })

  it('the watcher reads the one effective setting live: a change applies on the next refresh, in one tick', () => {
    const h = setup()
    h.runtime.refresh()
    h.state.stored = { ...h.state.stored, enabled: false }
    expect(h.wiring().enabled()).toBe(false)
    h.runtime.refresh()
    expect(h.chord.refresh).toHaveBeenCalledTimes(2)
    expect(h.runtime.snapshot()).toMatchObject({ state: 'off', enabled: false })
  })

  it('the chord mask comes from the setting with the watcher vocabulary: Right Command on macOS, Right Control on Windows', () => {
    const mac = setup()
    expect(mac.wiring().chordMask?.()).toBe(32)
    const win = setup({ platform: 'win32' })
    expect(win.wiring().chordMask?.()).toBe(2)
    const rebound = setup({ stored: { holdChord: { mac: ['leftControl', 'leftAlt'], win: ['rightControl'] } } })
    expect(rebound.wiring().chordMask?.()).toBe(1 | 4)
    const other = setup({ platform: 'linux' })
    expect(other.wiring().chordMask?.()).toBe(0)
  })

  it('the double-press latch is off by default and follows the setting', () => {
    const off = setup()
    expect(off.wiring().latchEnabled?.()).toBe(false)
    const on = setup({ stored: { doublePressLatch: true } })
    expect(on.wiring().latchEnabled?.()).toBe(true)
  })

  it('watcher verdicts drive the session and a status change refreshes the snapshot shortcut', () => {
    const h = setup()
    h.runtime.refresh()
    h.wiring().onChordEvent?.({ type: 'armed' })
    expect(h.runtime.snapshot().state).toBe('listening')
    chordStatus = 'failed'
    h.wiring().onStatus?.('failed')
    expect(h.runtime.snapshot().shortcut).toBe('stopped')
  })

  it('a hold refused for a meeting by the watcher stays a refusal: no mint, no begin, no lease touched', () => {
    const h = setup()
    h.runtime.refresh()
    h.emit({ type: 'refused', reason: 'meeting' })
    expect(h.activation.mintFromHardware).not.toHaveBeenCalled()
    expect(h.sent.some((m) => m.channel === VOICE_ACTIONS_IPC.begin)).toBe(false)
    expect(h.authority.hardStop).not.toHaveBeenCalled()
    expect(h.runtime.snapshot().reason).toBe('meeting_recording')
  })

  it('sign-in, hard stops and disposal reach the watcher too', () => {
    const h = setup()
    h.runtime.onSignedIn()
    expect(h.chord.onSignedIn).toHaveBeenCalledOnce()
    h.runtime.onHardStop('sign-out')
    expect(h.chord.onInputSessionStop).toHaveBeenCalledWith('sign-out')
    h.runtime.dispose()
    expect(h.chord.stop).toHaveBeenCalledOnce()
  })
})

describe('the Settings chord recorder pauses the hold (V06)', () => {
  it('an open recorder blocks a hold from opening a turn, and closing it lets the next hold through', () => {
    const h = setup()
    expect(h.wiring().chordRecorderActive?.()).toBe(false)
    expect(h.runtime.setChordRecorderActive({ active: true })).toEqual({ ok: true })
    expect(h.wiring().chordRecorderActive?.()).toBe(true)
    h.runtime.setChordRecorderActive({ active: false })
    expect(h.wiring().chordRecorderActive?.()).toBe(false)
  })

  it('refuses a payload that is not exactly { active: boolean }', () => {
    const h = setup()
    expect(h.runtime.setChordRecorderActive({ active: 'yes' })).toEqual({ ok: false })
    expect(h.runtime.setChordRecorderActive({ active: true, extra: 1 })).toEqual({ ok: false })
    expect(h.runtime.setChordRecorderActive(undefined)).toEqual({ ok: false })
    expect(h.wiring().chordRecorderActive?.()).toBe(false)
  })

  it('a recorder left open by a renderer that went away stops blocking: reset clears it, and so does time', () => {
    vi.useFakeTimers()
    try {
      const h = setup()
      h.runtime.setChordRecorderActive({ active: true })
      h.runtime.onRendererReset()
      expect(h.wiring().chordRecorderActive?.()).toBe(false)
      h.runtime.setChordRecorderActive({ active: true })
      vi.advanceTimersByTime(121_000)
      expect(h.wiring().chordRecorderActive?.()).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('hardware activation is minted by main from its own window frame', () => {
  it('a hold mints from main frame and tells the renderer to begin', () => {
    const h = setup()
    h.runtime.refresh()
    h.emit('armed')
    expect(h.activation.mintFromHardware).toHaveBeenCalledExactlyOnceWith(frame)
    const begin = h.sent.find((s) => s.channel === VOICE_ACTIONS_IPC.begin)
    expect(begin?.payload).toMatchObject({ maxMs: 15_000 })
  })

  it('with no main window frame the hold is refused as not ready and nothing is pushed to begin', () => {
    const h = setup()
    h.runtime.refresh()
    h.state.frame = null
    h.emit('armed')
    expect(h.activation.mintFromHardware).not.toHaveBeenCalled()
    expect(h.sent.some((s) => s.channel === VOICE_ACTIONS_IPC.begin)).toBe(false)
    expect(h.runtime.snapshot()).toMatchObject({ state: 'failed', reason: 'not_ready' })
  })

  it('ending a turn revokes only the hardware activation', () => {
    const h = setup()
    h.runtime.refresh()
    h.emit('armed')
    h.emit('aborted')
    expect(h.activation.revokeHardware).toHaveBeenCalled()
  })
})

describe('a meeting that is recording refuses the hold and touches nothing', () => {
  it('no mint, no begin, no lease stop, copy for the pill', () => {
    const h = setup()
    h.runtime.refresh()
    h.state.meeting = true
    h.emit('armed')
    expect(h.activation.mintFromHardware).not.toHaveBeenCalled()
    expect(h.sent.some((s) => s.channel === VOICE_ACTIONS_IPC.begin)).toBe(false)
    expect(h.authority.hardStop).not.toHaveBeenCalled()
    expect(h.runtime.snapshot()).toMatchObject({ state: 'failed', reason: 'meeting_recording' })
    expect(h.runtime.snapshot().message).toMatch(/Métis records a meeting/)
  })

  it('a meeting reserved mid-turn stops the turn and the renderer is told to discard it', () => {
    const h = setup()
    h.runtime.refresh()
    h.emit('armed')
    h.runtime.onMeetingReserved()
    expect(h.sent.filter((s) => s.channel === VOICE_ACTIONS_IPC.end).at(-1)?.payload).toMatchObject({ cancelled: true })
    expect(h.runtime.snapshot().reason).toBe('meeting_started')
  })
})

describe('lease handling is limited to the voice lease', () => {
  it('an active panel lease refuses the hold; an ambient lease and a voice lease do not', () => {
    const panel = setup()
    panel.runtime.refresh()
    panel.state.lease = lease('deliberate-talk', 'command')
    panel.emit('armed')
    expect(panel.runtime.snapshot().reason).toBe('panel_active')

    const ambient = setup()
    ambient.runtime.refresh()
    ambient.state.lease = lease('wake', 'conversation')
    ambient.emit('armed')
    expect(ambient.runtime.snapshot().state).toBe('listening')

    const voice = setup()
    voice.runtime.refresh()
    voice.state.lease = lease('push-to-talk', 'command')
    voice.emit('armed')
    expect(voice.runtime.snapshot().state).toBe('listening')
  })

  it('cancelling stops the push-to-talk command lease and leaves every other lease alone', () => {
    const own = setup()
    own.runtime.refresh()
    own.emit('armed')
    own.state.lease = lease('push-to-talk', 'command')
    own.emit('aborted')
    expect(own.authority.hardStop).toHaveBeenCalledWith('cancelled')

    for (const other of [
      lease('deliberate-talk', 'command'),
      lease('wake', 'conversation'),
      lease('push-to-talk', 'dictation')
    ]) {
      const h = setup()
      h.runtime.refresh()
      h.emit('armed')
      h.state.lease = other
      h.emit('aborted')
      expect(h.authority.hardStop).not.toHaveBeenCalled()
    }
  })

  it('a renderer reset hard-stops the voice lease under the renderer-reset reason', () => {
    const h = setup()
    h.runtime.refresh()
    h.emit('armed')
    h.state.lease = lease('push-to-talk', 'command')
    h.runtime.onRendererReset()
    expect(h.authority.hardStop).toHaveBeenCalledWith('renderer-reset')
    expect(h.runtime.snapshot().reason).toBe('renderer_reset')
  })

  it('a speech result only reaches the turn when it belongs to the voice lease', () => {
    const h = setup()
    h.runtime.refresh()
    h.emit('armed')
    h.emit('released')
    h.state.lease = lease('deliberate-talk', 'command', 'b'.repeat(48))
    h.runtime.onSpeechFinished('b'.repeat(48), { ok: false, reason: 'no_speech' })
    expect(h.runtime.snapshot().state).toBe('thinking')
    h.state.lease = lease('push-to-talk', 'command', 'c'.repeat(48))
    h.runtime.onSpeechFinished('d'.repeat(48), { ok: false, reason: 'no_speech' })
    expect(h.runtime.snapshot().state).toBe('thinking')
    h.runtime.onSpeechFinished('c'.repeat(48), { ok: false, reason: 'no_speech' })
    expect(h.runtime.snapshot()).toMatchObject({ state: 'failed', reason: 'no_speech' })
  })

  it('a hard stop reaches the turn even when no lease exists yet (lock, sign-out, quit)', () => {
    const h = setup()
    h.runtime.refresh()
    h.emit('armed')
    h.runtime.onHardStop('screen-locked')
    expect(h.runtime.snapshot()).toMatchObject({ state: 'failed', reason: 'screen_locked' })
  })
})

describe('speech helper handling', () => {
  it('prewarms Parakeet while the user speaks, and probes model presence at most every 30 seconds', async () => {
    vi.useFakeTimers()
    try {
      const probed = setup()
      probed.runtime.refresh()
      probed.runtime.refresh()
      probed.runtime.refresh()
      expect(probed.deps.parakeet.refreshPresence).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(30_000)
      probed.runtime.refresh()
      expect(probed.deps.parakeet.refreshPresence).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
    const h = setup()
    h.runtime.refresh()
    h.emit('armed')
    await Promise.resolve()
    expect(h.deps.parakeet.ensure).toHaveBeenCalledOnce()
  })

  it('idle release is deferred while a meeting, a live session or an import uses the helper', async () => {
    vi.useFakeTimers()
    try {
      const busy = setup({ speechBusy: () => true })
      busy.runtime.refresh()
      busy.emit('armed')
      busy.emit('aborted')
      await vi.advanceTimersByTimeAsync(10 * 60_000)
      expect(busy.deps.parakeet.release).not.toHaveBeenCalled()

      const idle = setup()
      idle.runtime.refresh()
      idle.emit('armed')
      idle.emit('aborted')
      await vi.advanceTimersByTimeAsync(10 * 60_000)
      expect(idle.deps.parakeet.release).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('renderer reports and state pushes', () => {
  it('report applies a valid failure to the current turn and ignores malformed payloads', () => {
    const h = setup()
    h.runtime.refresh()
    h.emit('armed')
    const turnId = (h.sent.find((s) => s.channel === VOICE_ACTIONS_IPC.begin)?.payload as { turnId: string }).turnId
    for (const bad of [
      null,
      'x',
      {},
      { turnId, phase: 'failed' },
      { turnId, phase: 'failed', reason: 'meeting_started' },
      { turnId, phase: 'capturing', extra: 1 }
    ]) {
      expect(h.runtime.report(bad)).toEqual({ ok: false })
    }
    expect(h.runtime.snapshot().state).toBe('listening')
    expect(h.runtime.report({ turnId, phase: 'failed', reason: 'microphone_unavailable' })).toEqual({ ok: true })
    expect(h.runtime.snapshot()).toMatchObject({ state: 'failed', reason: 'microphone_unavailable' })
  })

  it('pushes each state change to the renderer on the state channel', () => {
    const h = setup()
    h.runtime.refresh()
    h.emit('armed')
    const states = h.sent
      .filter((s) => s.channel === VOICE_ACTIONS_IPC.state)
      .map((s) => (s.payload as { state: string }).state)
    expect(states).toEqual(['idle', 'listening'])
  })
})

describe('window binding', () => {
  it('a renderer crash, destroy or main-frame navigation resets the turn; an in-place navigation does not', () => {
    const h = setup()
    h.runtime.refresh()
    h.emit('armed')
    const handlers = new Map<string, (...args: unknown[]) => void>()
    h.runtime.bindWebContents({
      on: (event: string, fn: (...args: unknown[]) => void) => void handlers.set(event, fn)
    } as never)
    handlers.get('did-start-navigation')?.({}, 'app://x', true, true)
    expect(h.runtime.snapshot().state).toBe('listening')
    handlers.get('did-start-navigation')?.({}, 'app://x', false, false)
    expect(h.runtime.snapshot().state).toBe('listening')
    handlers.get('did-start-navigation')?.({}, 'app://x', false, true)
    expect(h.runtime.snapshot()).toMatchObject({ state: 'failed', reason: 'renderer_reset' })
    expect([...handlers.keys()].sort()).toEqual(['destroyed', 'did-start-navigation', 'render-process-gone'])
  })
})

describe('createCommandMicAvailability (the engine-decoupled availability main shares)', () => {
  const make = (settings: { asrEngine: string; enterpriseLive?: object }, ready = true) =>
    createCommandMicAvailability({
      requireAuth: () => true,
      getSettings: () => settings as never,
      modelReady: async () => ready
    })

  it('Apple Speech as the meeting engine allows voice actions once the Parakeet model is seen present', async () => {
    const gate = make({ asrEngine: 'apple' })
    expect(gate.availability()).toEqual({ ok: false, reason: 'unsupported_engine' })
    await gate.refreshPresence()
    expect(gate.availability()).toEqual({ ok: true })
  })

  it('without the model, Apple Speech stays unavailable', async () => {
    const gate = make({ asrEngine: 'apple' }, false)
    await gate.refreshPresence()
    expect(gate.availability()).toEqual({ ok: false, reason: 'unsupported_engine' })
  })

  it('the Parakeet engine is available as before', () => {
    expect(make({ asrEngine: 'parakeet' }).availability()).toEqual({ ok: true })
  })

  it('a managed cloud-only profile blocks local speech whatever the engine', async () => {
    const gate = make({ asrEngine: 'parakeet', enterpriseLive: { managed: true, inferenceMode: 'cloud-only' } })
    await gate.refreshPresence()
    expect(gate.availability()).toEqual({ ok: false, reason: 'policy_blocked' })
  })
})

describe("recognized text (V03): only a voice turn's text reaches the action pipeline", () => {
  const sealedTurn = (h: ReturnType<typeof setup>) => {
    h.runtime.refresh()
    h.emit('armed')
    h.state.lease = lease('push-to-talk', 'command')
    h.emit('released')
  }

  it("hands a voice turn's text and a claim to the pipeline and keeps it from the command panel", () => {
    const handle = vi.fn()
    const h = setup({ turns: { handle } })
    sealedTurn(h)
    expect(h.runtime.onTranscript('open notes')).toBe(true)
    expect(handle).toHaveBeenCalledTimes(1)
    expect(handle.mock.calls[0][0]).toBe('open notes')
    expect(handle.mock.calls[0][1]).toMatchObject({ turnId: expect.any(String) })
    expect(handle.mock.calls[0][1].valid()).toBe(true)
  })

  it('text from any other capture (the panel, an ambient lease, no lease) is not a voice action', () => {
    const handle = vi.fn()
    for (const other of [null, lease('deliberate-talk', 'command'), lease('wake', 'conversation')]) {
      const h = setup({ turns: { handle } })
      h.runtime.refresh()
      h.state.lease = other
      expect(h.runtime.onTranscript('open notes')).toBe(false)
    }
    expect(handle).not.toHaveBeenCalled()
  })

  it('a second delivery for the same turn is consumed and dropped, never routed twice or to the panel', () => {
    const handle = vi.fn()
    const h = setup({ turns: { handle } })
    sealedTurn(h)
    expect(h.runtime.onTranscript('open notes')).toBe(true)
    expect(h.runtime.onTranscript('open notes')).toBe(true)
    expect(handle).toHaveBeenCalledTimes(1)
  })

  it('text for a turn that is still listening or already cancelled is dropped, not given to the panel', () => {
    const handle = vi.fn()
    const h = setup({ turns: { handle } })
    h.runtime.refresh()
    h.emit('armed')
    h.state.lease = lease('push-to-talk', 'command')
    expect(h.runtime.onTranscript('open notes')).toBe(true) // listening: nothing sealed yet
    h.emit('aborted')
    h.runtime.onTranscript('open notes') // the voice lease was stopped with the turn, so there is nothing to claim
    expect(handle).not.toHaveBeenCalled()
  })

  it('a throwing pipeline never reaches the capture, and a missing pipeline drops the text', () => {
    const h = setup({
      turns: {
        handle: () => {
          throw new Error('boom')
        }
      }
    })
    sealedTurn(h)
    expect(() => h.runtime.onTranscript('open notes')).not.toThrow()
    const bare = setup()
    sealedTurn(bare)
    expect(bare.runtime.onTranscript('open notes')).toBe(true)
  })

  it('the claim dies on a lock that arrives after the turn ended', () => {
    const handle = vi.fn()
    const h = setup({ turns: { handle } })
    sealedTurn(h)
    h.runtime.onTranscript('open notes')
    const claim = handle.mock.calls[0][1]
    h.runtime.onSpeechFinished('a'.repeat(48), { ok: true })
    expect(claim.valid()).toBe(true)
    h.runtime.onHardStop('screen-locked')
    expect(claim.valid()).toBe(false)
  })
})

describe('dictation inside the voice actions runtime (G22)', () => {
  const synthetic = (over: Partial<DictationHostPorts['insertion']> = {}): DictationHostPorts => ({
    target: {
      captureTarget: vi.fn(async () => ({
        kind: 'target' as const,
        target: {
          appId: 'com.example.synthetic-editor',
          processInstanceId: 'pid:5',
          windowId: 'window:1',
          elementId: 'element:1',
          focusRevision: 1,
          selectionRevision: 0,
          documentRevision: 'doc:1',
          editable: true,
          secure: false,
          observedAtMs: Date.now()
        }
      }))
    },
    insertion: { insert: vi.fn(async () => ({ outcome: 'unsupported' as const })), ...over }
  })
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 12; i++) await Promise.resolve()
  }
  const dictationWiring = (): VoiceChordWiringDeps => wiringCalls[1] as VoiceChordWiringDeps

  it('builds a second watcher for the dictation chord, after the voice hold', () => {
    setup()
    expect(wiringCalls).toHaveLength(2)
    expect(wiringCalls[1]?.chordMask?.()).not.toBe(wiringCalls[0]?.chordMask?.())
  })

  it('start, refresh, sign-in and dispose reach the dictation watcher too', () => {
    const h = setup()
    h.runtime.start()
    expect(dictationChordFake.start).toHaveBeenCalledOnce()
    h.runtime.onSignedIn()
    expect(dictationChordFake.onSignedIn).toHaveBeenCalledOnce()
    h.runtime.dispose()
    expect(dictationChordFake.stop).toHaveBeenCalled()
  })

  it('a dictation hold mints a dictation-kind activation and asks the renderer for a dictation capture', async () => {
    const h = setup({ dictation: { ports: synthetic() } } as never)
    h.runtime.start()
    dictationWiring().onChordEvent?.({ type: 'armed' })
    await flush()
    expect(h.activation.mintFromHardware).toHaveBeenCalledWith(frame, 'hardware-dictation')
    const begin = h.sent.find((m) => m.channel === VOICE_ACTIONS_IPC.begin)
    expect(begin?.payload).toMatchObject({ purpose: 'dictation', maxMs: 15_000 })
  })

  it('text from a dictation lease is owned by dictation: never the voice pipeline, never the command panel', async () => {
    const handle = vi.fn()
    const h = setup({ turns: { handle }, dictation: { ports: synthetic() } } as never)
    h.runtime.start()
    h.state.lease = lease('push-to-talk', 'dictation')
    expect(h.runtime.onTranscript('synthetic words')).toBe(true)
    expect(handle).not.toHaveBeenCalled()
  })

  it('a renderer report for the dictation turn is applied to dictation and not to the voice turn', async () => {
    const h = setup({ dictation: { ports: synthetic() } } as never)
    h.runtime.start()
    dictationWiring().onChordEvent?.({ type: 'armed' })
    await flush()
    const begin = h.sent.find((m) => m.channel === VOICE_ACTIONS_IPC.begin)?.payload as { turnId: string }
    expect(h.runtime.report({ turnId: begin.turnId, phase: 'failed', reason: 'microphone_unavailable' })).toEqual({
      ok: true
    })
    expect(h.runtime.snapshot().state).not.toBe('failed') // the voice snapshot is untouched
  })

  it('while dictation owns the microphone, a voice hold is refused instead of racing it for the activation', async () => {
    const h = setup({ dictation: { ports: synthetic() } } as never)
    h.runtime.start()
    dictationWiring().onChordEvent?.({ type: 'armed' })
    await flush()
    h.emit('armed')
    expect(h.runtime.snapshot()).toMatchObject({ state: 'failed', reason: 'panel_active' })
  })

  it('a hard stop, a meeting and a renderer reset end a dictation turn', async () => {
    for (const end of ['hard', 'meeting', 'reset'] as const) {
      const h = setup({ dictation: { ports: synthetic() } } as never)
      h.runtime.start()
      dictationWiring().onChordEvent?.({ type: 'armed' })
      await flush()
      h.sent.length = 0
      if (end === 'hard') h.runtime.onHardStop('sign-out')
      else if (end === 'meeting') h.runtime.onMeetingReserved()
      else h.runtime.onRendererReset()
      expect(
        h.sent.some((m) => m.channel === VOICE_ACTIONS_IPC.end),
        end
      ).toBe(true)
    }
  })

  it('with no native port (production until G23) a dictation hold is refused as unsupported', async () => {
    const h = setup()
    h.runtime.start()
    dictationWiring().onChordEvent?.({ type: 'armed' })
    await flush()
    expect(h.sent.find((m) => m.channel === VOICE_ACTIONS_IPC.begin)).toBeUndefined()
    expect(h.activation.mintFromHardware).not.toHaveBeenCalled()
  })
})
