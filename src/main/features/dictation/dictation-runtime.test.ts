import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { InputSessionLease } from '@shared/input-session'
import { DEFAULT_VOICE_ACTIONS_SETTINGS, voiceChordMask } from '@shared/voice-actions-settings'
import { MODIFIER_BITS } from '@shared/voice/modifier-mask'
import { VOICE_ACTIONS_IPC } from '@shared/voice/voice-turn'
import type { ChordWatcherEvent, ChordWatcherStatus } from '../../voice/chord-watcher'
import type { VoiceChordWiringDeps } from '../../voice/chord-wiring'
import type { DictationTarget } from '../desktop-contract'
import { createDictationRuntime, type DictationRuntimeDeps } from './dictation-runtime'
import type { DictationHostPorts } from './dictation-ports'

vi.mock('../../logger', () => ({ auditLog: vi.fn() }))
// The helper gateway is replaced: no test here ever spawns the real metis-mac-helper.
const helper = vi.hoisted(() => ({ present: false, run: vi.fn(async (): Promise<unknown> => null) }))
vi.mock('../../mac-helper', () => ({
  macHelperPresent: () => helper.present,
  macHelperPath: () => '/synthetic/metis-mac-helper',
  runHelperOnce: (...args: unknown[]) => helper.run(...(args as []))
}))

const wiringCalls: VoiceChordWiringDeps[] = []
const chordFake = {
  start: vi.fn(),
  refresh: vi.fn(),
  onSignedIn: vi.fn(),
  onInputSessionStop: vi.fn(),
  stop: vi.fn(),
  suspendedReason: () => null,
  status: (): ChordWatcherStatus => 'running'
}
vi.mock('../../voice/chord-wiring', () => ({
  createVoiceChordWiring: (deps: VoiceChordWiringDeps) => {
    wiringCalls.push(deps)
    return chordFake
  }
}))

const NOW = 9_000_000
const SESSION = 'c'.repeat(48)
const armed: ChordWatcherEvent = { type: 'armed' }

const target = (): DictationTarget => ({
  appId: 'com.example.synthetic-editor',
  processInstanceId: 'pid:7',
  windowId: 'window:1',
  elementId: 'element:1',
  focusRevision: 1,
  selectionRevision: 0,
  documentRevision: 'doc:1',
  editable: true,
  secure: false,
  observedAtMs: NOW
})

const lease = (purpose: InputSessionLease['purpose'], sessionId = SESSION): InputSessionLease =>
  ({
    sessionId,
    source: 'push-to-talk',
    purpose,
    activation: 'explicit',
    authSessionGeneration: 1,
    contextRevision: 1,
    revision: 1,
    startedAt: 1,
    actionAuthority: false
  }) as InputSessionLease

const flush = async (): Promise<void> => {
  for (let i = 0; i < 12; i++) await Promise.resolve()
}

function setup(over: Partial<DictationRuntimeDeps> & { stored?: Partial<typeof DEFAULT_VOICE_ACTIONS_SETTINGS> } = {}) {
  wiringCalls.length = 0
  for (const fn of [
    chordFake.start,
    chordFake.refresh,
    chordFake.onSignedIn,
    chordFake.onInputSessionStop,
    chordFake.stop
  ])
    fn.mockClear()
  const sent: Array<{ channel: string; payload: unknown }> = []
  const state = { lease: null as InputSessionLease | null, meeting: false, voiceBusy: false, recorder: false }
  const authority = {
    get activeLease() {
      return state.lease
    },
    get hasMeetingReservation() {
      return state.meeting
    },
    hardStop: vi.fn(() => {
      state.lease = null
    })
  }
  const activation = { mint: vi.fn(() => true), revoke: vi.fn() }
  const ports: DictationHostPorts = {
    target: { captureTarget: vi.fn(async () => ({ kind: 'target' as const, target: target() })) },
    insertion: { insert: vi.fn(async () => ({ outcome: 'unsupported' as const })) }
  }
  const deps: DictationRuntimeDeps = {
    platform: 'darwin',
    qaIdentity: true,
    getSettings: () => ({ voiceActions: { ...DEFAULT_VOICE_ACTIONS_SETTINGS, ...over.stored } }),
    requireAuth: () => true,
    authority: authority as never,
    activation,
    window: () => ({
      isDestroyed: () => false,
      isVisible: () => true,
      webContents: { send: (channel: string, payload: unknown) => void sent.push({ channel, payload }) }
    }),
    onboardingActive: () => false,
    availability: () => ({ ok: true }),
    parakeet: { ensure: vi.fn(async () => {}) },
    voiceChordMask: () => MODIFIER_BITS.rightCommand,
    voiceTurnBusy: () => state.voiceBusy,
    chordRecorderActive: () => state.recorder,
    ports,
    now: () => NOW,
    newTurnId: () => 'turn-a',
    audit: vi.fn(),
    ...over
  }
  const runtime = createDictationRuntime(deps)
  const wiring = (): VoiceChordWiringDeps => wiringCalls[0] as VoiceChordWiringDeps
  return { runtime, deps, state, authority, activation, ports, sent, wiring }
}

beforeEach(() => vi.useFakeTimers())

describe('dictation runtime: a second chord on its own supervised watcher (G22)', () => {
  it('is a Preview feature: ON in QA, OFF in release, an explicit choice wins', () => {
    expect(setup({ qaIdentity: true }).wiring().enabled()).toBe(true)
    expect(setup({ qaIdentity: false }).wiring().enabled()).toBe(false)
    const on = { ...DEFAULT_VOICE_ACTIONS_SETTINGS.dictation, enabled: true }
    expect(
      setup({ qaIdentity: false, stored: { dictation: on } })
        .wiring()
        .enabled()
    ).toBe(true)
    const off = { ...DEFAULT_VOICE_ACTIONS_SETTINGS.dictation, enabled: false }
    expect(
      setup({ qaIdentity: true, stored: { dictation: off } })
        .wiring()
        .enabled()
    ).toBe(false)
  })

  it('listens for Control+Fn on macOS with the double-tap latch, and the PROPOSED Windows chord on Windows', () => {
    const mac = setup()
    expect(mac.wiring().chordMask?.()).toBe(MODIFIER_BITS.leftControl | MODIFIER_BITS.fn)
    expect(mac.wiring().latchEnabled?.()).toBe(true)
    expect(mac.wiring().platform).toBe('darwin')
    const win = setup({ platform: 'win32' })
    expect(win.wiring().chordMask?.()).toBe(MODIFIER_BITS.leftControl | MODIFIER_BITS.leftAlt)
  })

  it('is disabled, with no helper, when its chord equals the voice hold chord', () => {
    const same = setup({ voiceChordMask: () => voiceChordMask(['leftControl', 'fn']) })
    expect(same.wiring().enabled()).toBe(false)
  })

  it('shares the gates of the voice watcher: a meeting, onboarding and the chord recorder block a hold', () => {
    const h = setup()
    expect(h.wiring().meetingReserved()).toBe(false)
    h.state.meeting = true
    expect(h.wiring().meetingReserved()).toBe(true)
    expect(h.wiring().chordRecorderActive?.()).toBe(false)
    h.state.recorder = true
    expect(h.wiring().chordRecorderActive?.()).toBe(true)
  })

  it('start() starts the watcher and the session', () => {
    const h = setup()
    h.runtime.start()
    expect(chordFake.start).toHaveBeenCalledOnce()
    expect(h.runtime.snapshot().state).toBe('idle')
  })
})

describe('dictation runtime: a held chord opens a dictation capture, never a voice turn (G22)', () => {
  it('binds the target, mints a dictation activation and asks the renderer for a dictation-purpose capture', async () => {
    const h = setup()
    h.runtime.start()
    h.wiring().onChordEvent?.(armed)
    await flush()
    expect(h.activation.mint).toHaveBeenCalledOnce()
    expect(h.sent).toEqual([
      { channel: VOICE_ACTIONS_IPC.begin, payload: { turnId: 'turn-a', maxMs: 15_000, purpose: 'dictation' } }
    ])
    expect(h.runtime.active()).toBe(true)
  })

  it('without a native port (any platform but macOS) a hold is refused as unsupported and opens nothing', async () => {
    const h = setup({ ports: undefined, platform: 'win32' })
    h.runtime.start()
    h.wiring().onChordEvent?.(armed)
    await flush()
    expect(h.sent).toEqual([])
    expect(h.activation.mint).not.toHaveBeenCalled()
    expect(h.runtime.snapshot()).toMatchObject({ state: 'failed', reason: 'target_unsupported' })
  })

  it('on macOS the default ports are the Accessibility adapter (G23): no helper is unsupported, a focused field binds', async () => {
    helper.present = false
    const missing = setup({ ports: undefined, platform: 'darwin' })
    missing.runtime.start()
    missing.wiring().onChordEvent?.(armed)
    await flush()
    expect(missing.runtime.snapshot()).toMatchObject({ state: 'failed', reason: 'target_unsupported' })
    expect(helper.run).not.toHaveBeenCalled()

    helper.present = true
    const focused = JSON.stringify({
      status: 'ok',
      pid: 4242,
      bundleId: 'com.example.synthetic-editor',
      processStartMs: 1,
      windowId: 'wsynthetic01',
      role: 'AXTextArea',
      subrole: null,
      token: 'tok0123456789abcdef',
      secure: false,
      editable: true,
      terminal: false,
      valueHash: 'a'.repeat(64),
      valueLength: 3,
      valueTooLarge: false,
      selection: { location: 3, length: 0 }
    })
    helper.run.mockImplementation(async (...args: unknown[]) => (args[1] as (stdout: string) => unknown)(focused))
    const bound = setup({ ports: undefined, platform: 'darwin' })
    bound.runtime.start()
    bound.wiring().onChordEvent?.(armed)
    await flush()
    expect(helper.run).toHaveBeenCalledTimes(1)
    expect(bound.runtime.snapshot().state).toBe('listening')
    helper.present = false
    helper.run.mockReset()
  })

  it('is refused while a meeting records and nothing is captured', async () => {
    const h = setup()
    h.runtime.start()
    h.state.meeting = true
    h.wiring().onChordEvent?.(armed)
    await flush()
    expect(h.sent).toEqual([])
    expect(h.ports.target.captureTarget).not.toHaveBeenCalled()
    expect(h.runtime.snapshot()).toMatchObject({ reason: 'meeting_recording' })
  })

  it('is refused while any other capture holds the microphone, or a voice turn is running', async () => {
    const lease1 = setup()
    lease1.runtime.start()
    lease1.state.lease = lease('command')
    lease1.wiring().onChordEvent?.(armed)
    await flush()
    expect(lease1.sent).toEqual([])
    const voice = setup()
    voice.runtime.start()
    voice.state.voiceBusy = true
    voice.wiring().onChordEvent?.(armed)
    await flush()
    expect(voice.sent).toEqual([])
  })
})

describe('dictation runtime: the recognized text (G22)', () => {
  it('only a dictation lease owns the transcript; a command lease or no lease leaves it to the caller', async () => {
    const h = setup()
    h.runtime.start()
    expect(h.runtime.onTranscript('synthetic words')).toBe(false)
    h.state.lease = lease('command')
    expect(h.runtime.onTranscript('synthetic words')).toBe(false)
    h.state.lease = lease('dictation')
    expect(h.runtime.onTranscript('synthetic words')).toBe(true)
    await flush()
    expect(h.ports.insertion.insert).not.toHaveBeenCalled() // no sealed turn: dropped, never forwarded
  })

  it('hands the text and the bound target to the insertion port when the dictation turn is sealed', async () => {
    const h = setup()
    h.runtime.start()
    h.wiring().onChordEvent?.(armed)
    await flush()
    h.state.lease = lease('dictation')
    h.runtime.report({ turnId: 'turn-a', phase: 'capturing' })
    h.wiring().onChordEvent?.({ type: 'released', reason: 'release' })
    expect(h.runtime.onTranscript('synthetic words')).toBe(true)
    await flush()
    expect(h.ports.insertion.insert).toHaveBeenCalledTimes(1)
    expect(h.ports.insertion.insert).toHaveBeenCalledWith(
      expect.objectContaining({ args: expect.objectContaining({ text: 'synthetic words' }) })
    )
    expect(h.runtime.snapshot()).toMatchObject({ state: 'failed', reason: 'insertion_unsupported' })
  })

  it('speech-finished is taken only for the matching dictation lease', async () => {
    const h = setup()
    h.runtime.start()
    h.wiring().onChordEvent?.(armed)
    await flush()
    h.state.lease = lease('dictation')
    h.runtime.onSpeechFinished('d'.repeat(48), { ok: false, reason: 'no_speech' })
    expect(h.runtime.active()).toBe(true)
    h.wiring().onChordEvent?.({ type: 'released', reason: 'release' })
    h.runtime.onSpeechFinished(SESSION, { ok: false, reason: 'no_speech' })
    expect(h.runtime.active()).toBe(false)
    expect(h.runtime.snapshot()).toMatchObject({ reason: 'no_speech' })
  })

  it('a renderer report is consumed only for the dictation turn id', async () => {
    const h = setup()
    h.runtime.start()
    h.wiring().onChordEvent?.(armed)
    await flush()
    expect(h.runtime.report({ turnId: 'someone-else', phase: 'failed', reason: 'microphone_unavailable' })).toBe(false)
    expect(h.runtime.active()).toBe(true)
    expect(h.runtime.report({ turnId: 'turn-a', phase: 'failed', reason: 'microphone_unavailable' })).toBe(true)
    expect(h.runtime.active()).toBe(false)
  })
})

describe('dictation runtime: lifecycle (G22)', () => {
  it('a hard stop, a meeting and a renderer reset end the turn; refresh re-reads the setting', async () => {
    for (const end of ['hard', 'meeting', 'reset'] as const) {
      const h = setup()
      h.runtime.start()
      h.wiring().onChordEvent?.(armed)
      await flush()
      if (end === 'hard') h.runtime.onHardStop('sign-out')
      else if (end === 'meeting') h.runtime.onMeetingReserved()
      else h.runtime.onRendererReset()
      expect(h.runtime.active(), end).toBe(false)
    }
  })

  it('a sign-out reaches the watcher; sign-in lets it start again', () => {
    const h = setup()
    h.runtime.onHardStop('sign-out')
    expect(chordFake.onInputSessionStop).toHaveBeenCalledWith('sign-out')
    h.runtime.onSignedIn()
    expect(chordFake.onSignedIn).toHaveBeenCalledOnce()
  })

  it('dispose stops the watcher and ends the turn; a second dispose is safe', async () => {
    const h = setup()
    h.runtime.start()
    h.wiring().onChordEvent?.(armed)
    await flush()
    h.runtime.dispose()
    h.runtime.dispose()
    expect(chordFake.stop).toHaveBeenCalled()
    expect(h.runtime.active()).toBe(false)
  })
})

describe('dictation runtime: the encrypted segment journal (G26)', () => {
  const sinkFake = () => ({
    segmentRecognized: vi.fn(),
    draftPreserved: vi.fn(),
    inserted: vi.fn(),
    turnEnded: vi.fn()
  })

  async function dictate(h: ReturnType<typeof setup>): Promise<void> {
    h.runtime.start()
    h.wiring().onChordEvent?.(armed)
    await flush()
    h.state.lease = lease('dictation')
    h.runtime.report({ turnId: 'turn-a', phase: 'capturing' })
    h.wiring().onChordEvent?.({ type: 'released', reason: 'release' })
    h.runtime.onTranscript('synthetic words')
    await flush()
  }

  it('resolves the memory on every use, so a memory installed after the runtime was built still journals', async () => {
    const sink = sinkFake()
    const current: { value: { sink: ReturnType<typeof sinkFake> } | null } = { value: null }
    const h = setup({ memory: () => current.value as never })
    current.value = { sink }
    await dictate(h)
    expect(sink.segmentRecognized).toHaveBeenCalledWith('turn-a', 'synthetic words')
    expect(sink.draftPreserved).not.toHaveBeenCalled()
    expect(sink.turnEnded).toHaveBeenCalledWith('turn-a')
  })

  it('a runtime with no memory installed dictates exactly as before', async () => {
    const h = setup({ memory: () => null })
    await dictate(h)
    expect(h.ports.insertion.insert).toHaveBeenCalledTimes(1)
  })

  it('a kept draft reaches the journal through the guard sink when the runtime is disposed', async () => {
    const sink = sinkFake()
    const h = setup({ memory: () => ({ sink }) as never })
    await dictate(h)
    h.runtime.dispose()
    expect(sink.draftPreserved).toHaveBeenCalledWith('turn-a', expect.objectContaining({ text: 'synthetic words' }))
  })
})
