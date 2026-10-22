import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_VOICE_ACTIONS_SETTINGS } from '@shared/voice-actions-settings'
import { VOICE_ACTIONS_IPC } from '@shared/voice/voice-turn'
import type { InputSessionLease } from '@shared/input-session'
import type { VoiceChordEvent, VoiceChordWatcher } from './chord-watcher-port'
import {
  createCommandMicAvailability,
  createVoiceActionsRuntime,
  type VoiceActionsRuntimeDeps
} from './voice-actions-runtime'

vi.mock('../logger', () => ({ auditLog: vi.fn() }))

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
  const listeners = new Set<(event: VoiceChordEvent) => void>()
  const watcher: VoiceChordWatcher = {
    start: vi.fn(),
    stop: vi.fn(),
    onEvent: (listener) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    }
  }
  const createWatcher = vi.fn(() => watcher)
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
    createWatcher: createWatcher as never,
    audit: vi.fn(),
    ...overrides
  }
  const runtime = createVoiceActionsRuntime(deps)
  const emit = (event: VoiceChordEvent): void => {
    for (const listener of [...listeners]) listener(event)
  }
  return { runtime, deps, state, authority, activation, sent, createWatcher, watcher, emit }
}

describe('effective enabled: ON in QA builds, OFF in release builds until the flag flips', () => {
  it('a QA build with a fresh profile starts the watcher', () => {
    const h = setup({ qaIdentity: true })
    h.runtime.refresh()
    expect(h.createWatcher).toHaveBeenCalledExactlyOnceWith(['rcommand'])
    expect(h.runtime.snapshot()).toMatchObject({ enabled: true, shortcut: 'running' })
  })

  it('a release build with a fresh profile stays off and starts nothing', () => {
    const h = setup({ qaIdentity: false })
    h.runtime.refresh()
    expect(h.createWatcher).not.toHaveBeenCalled()
    expect(h.runtime.snapshot()).toMatchObject({ state: 'off', enabled: false })
  })

  it('an explicit ON in a release build (the Preview toggle) starts it, and an explicit OFF in QA stops it', () => {
    const release = setup({ qaIdentity: false, stored: { enabled: true } })
    release.runtime.refresh()
    expect(release.runtime.snapshot().enabled).toBe(true)
    const qa = setup({ qaIdentity: true, stored: { enabled: false } })
    qa.runtime.refresh()
    expect(qa.runtime.snapshot().enabled).toBe(false)
  })

  it('uses the Windows chord on win32 and no chord, so no watcher, on another platform', () => {
    const win = setup({ platform: 'win32' })
    win.runtime.refresh()
    expect(win.createWatcher).toHaveBeenCalledWith(['rcontrol'])
    const other = setup({ platform: 'linux' })
    other.runtime.refresh()
    expect(other.createWatcher).not.toHaveBeenCalled()
    expect(other.runtime.snapshot().shortcut).toBe('unavailable')
  })

  it('a managed or user change that flips the setting is applied on the next refresh, in one tick', () => {
    const h = setup()
    h.runtime.refresh()
    h.state.stored = { ...h.state.stored, enabled: false }
    h.runtime.refresh()
    expect(h.watcher.stop).toHaveBeenCalled()
    expect(h.runtime.snapshot()).toMatchObject({ state: 'off', enabled: false })
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

describe('renderer IPC', () => {
  function ipc() {
    const h = setup()
    const handlers = new Map<string, (event: unknown, payload?: unknown) => unknown>()
    const assertMainWindow = vi.fn((event: unknown) => {
      if ((event as { trusted?: boolean }).trusted !== true) throw new Error('untrusted sender')
    })
    h.runtime.registerIpc(
      {
        handle: (channel: string, fn: (event: unknown, payload?: unknown) => unknown) => void handlers.set(channel, fn)
      } as never,
      assertMainWindow as never
    )
    const call = (channel: string, payload?: unknown, trusted = true) => handlers.get(channel)?.({ trusted }, payload)
    return { h, handlers, call, assertMainWindow }
  }

  it('registers exactly getState and report, both behind the main-window sender check', () => {
    const { handlers, call } = ipc()
    expect([...handlers.keys()].sort()).toEqual([VOICE_ACTIONS_IPC.getState, VOICE_ACTIONS_IPC.report].sort())
    expect(() => call(VOICE_ACTIONS_IPC.getState, undefined, false)).toThrow('untrusted sender')
    expect(() => call(VOICE_ACTIONS_IPC.report, { turnId: 'x', phase: 'capturing' }, false)).toThrow('untrusted sender')
  })

  it('getState returns the current snapshot', () => {
    const { h, call } = ipc()
    h.runtime.refresh()
    expect(call(VOICE_ACTIONS_IPC.getState)).toEqual(h.runtime.snapshot())
  })

  it('report applies a valid failure to the current turn and ignores malformed payloads', () => {
    const { h, call } = ipc()
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
      expect(call(VOICE_ACTIONS_IPC.report, bad)).toEqual({ ok: false })
    }
    expect(h.runtime.snapshot().state).toBe('listening')
    expect(call(VOICE_ACTIONS_IPC.report, { turnId, phase: 'failed', reason: 'microphone_unavailable' })).toEqual({
      ok: true
    })
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
