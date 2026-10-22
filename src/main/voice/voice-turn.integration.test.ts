import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_VOICE_ACTIONS_SETTINGS } from '@shared/voice-actions-settings'
import type { TrustedInputOwner } from '@shared/input-session'
import { CommandMicActivationAuthority } from '../command-mic-activation-authority'
import { CommandSpeechCapture } from '../command-speech-capture'
import { InputSessionAuthority } from '../input-session-authority'
import type { ChordWatcherEvent } from './chord-watcher'
import { createVoiceActionsRuntime } from './voice-actions-runtime'

vi.mock('../logger', () => ({ auditLog: vi.fn() }))

const frame = { webContentsId: 7, frameId: '12:3', isTopFrame: true, url: 'app://metis/index.html' }
const owner: TrustedInputOwner = { ...frame, authSessionGeneration: 1, contextRevision: 1 }
const ptt = { source: 'push-to-talk', purpose: 'command', activation: 'explicit' } as const

/** Real authority, activation authority and speech capture wired the way index.ts wires them. */
function rig() {
  const pushed: Array<{ channel: string; payload: unknown }> = []
  let capture: CommandSpeechCapture
  let meetingActive = false
  let stored = DEFAULT_VOICE_ACTIONS_SETTINGS
  const authority: InputSessionAuthority = new InputSessionAuthority({
    onHardStop: (reason) => runtime.onHardStop(reason),
    onMeetingReserved: () => runtime.onMeetingReserved(),
    onRevoked: (_owner, lease) => capture.cancelForLease(lease.sessionId)
  })
  const activation = new CommandMicActivationAuthority({
    state: () => ({
      mainWebContentsId: 7,
      mainFrameId: '12:3',
      currentUrl: frame.url,
      isWindowVisible: true,
      isAuthenticated: true,
      isParakeetSelected: true,
      context: { authSessionGeneration: 1, contextRevision: 1 }
    })
  })
  const transcribed: Float32Array[] = []
  let release!: (text: string) => void
  capture = new CommandSpeechCapture({
    isCurrent: (o, sessionId) => authority.isEstablishedLease(o, sessionId, 'command'),
    transcribe: (samples) => {
      transcribed.push(samples)
      return new Promise<string>((resolve) => void (release = resolve))
    },
    ingestTranscript: () => {},
    onFinished: (sessionId, result) => runtime.onSpeechFinished(sessionId, result)
  })
  const runtime = createVoiceActionsRuntime({
    platform: 'darwin',
    qaIdentity: true,
    getSettings: () => ({ voiceActions: stored }),
    requireAuth: () => true,
    authority,
    activation,
    mainFrame: () => frame,
    window: () => ({
      isDestroyed: () => false,
      isVisible: () => true,
      webContents: { send: (channel: string, payload: unknown) => void pushed.push({ channel, payload }) }
    }),
    onboardingActive: () => false,
    availability: () => ({ ok: true }),
    parakeet: { refreshPresence: async () => true, ensure: async () => {}, release: async () => {} },
    speechBusy: () => false,
    chord: {
      start: () => {},
      refresh: () => {},
      onSignedIn: () => {},
      onInputSessionStop: () => {},
      stop: () => {},
      status: () => 'running',
      suspendedReason: () => null
    },
    audit: () => {}
  })
  runtime.refresh()
  return {
    authority,
    activation,
    capture,
    runtime,
    pushed,
    transcribed,
    release: (text: string) => release(text),
    setEnabled: (enabled: boolean) => void (stored = { ...DEFAULT_VOICE_ACTIONS_SETTINGS, enabled }),
    emit: (event: 'armed' | 'released' | 'aborted' | ChordWatcherEvent) =>
      runtime.onChordEvent(
        event === 'released'
          ? { type: 'released', reason: 'release' }
          : event === 'aborted'
            ? { type: 'aborted', reason: 'other-input' }
            : typeof event === 'string'
              ? { type: event }
              : event
      ),
    meeting: (on: boolean) => {
      meetingActive = on
      if (on) authority.reserveMeeting(500)
      else authority.releaseMeeting(500)
    },
    get meetingActive() {
      return meetingActive
    }
  }
}

/** What the renderer does after a begin: ask main for the push-to-talk lease, then start capturing. */
function renderer(h: ReturnType<typeof rig>) {
  const consumed = h.activation.consume(frame, 'hardware')
  if (!consumed) return { ok: false as const, reason: 'unauthorized' }
  const started = h.authority.start(owner, ptt)
  if (!started.ok) return { ok: false as const, reason: started.reason }
  expect(h.authority.claimPermissionRequest(owner)).toBe(true)
  expect(h.authority.confirmCapture(owner, started.lease.sessionId)).toBe(true)
  expect(h.capture.start(owner, started.lease.sessionId)).toEqual({ ok: true })
  expect(h.capture.frame(owner, started.lease.sessionId, 0, new Float32Array(64).fill(0.5))).toEqual({ ok: true })
  return { ok: true as const, sessionId: started.lease.sessionId }
}

describe('a voice turn against the real authorities', () => {
  it('a hold yields exactly one hardware grant that a push-to-talk command lease consumes once', () => {
    const h = rig()
    h.emit('armed')
    expect(h.runtime.snapshot().state).toBe('listening')
    const first = renderer(h)
    expect(first.ok).toBe(true)
    expect(h.authority.activeLease).toMatchObject({
      source: 'push-to-talk',
      purpose: 'command',
      activation: 'explicit'
    })
    expect(h.activation.consume(frame, 'hardware')).toBe(false)
  })

  it('without a hold the renderer cannot obtain a voice lease', () => {
    const h = rig()
    expect(renderer(h)).toEqual({ ok: false, reason: 'unauthorized' })
    expect(h.authority.activeLease).toBeNull()
  })

  it('a meeting that is recording refuses the hold: no grant, no lease, and the reservation is untouched', () => {
    const h = rig()
    h.meeting(true)
    h.emit('armed')
    expect(h.runtime.snapshot()).toMatchObject({ state: 'failed', reason: 'meeting_recording' })
    expect(renderer(h)).toEqual({ ok: false, reason: 'unauthorized' })
    expect(h.authority.activeLease).toBeNull()
    expect(h.authority.hasMeetingReservation).toBe(true)
    expect(h.authority.meetingStartedAt).toBe(500)
    expect(h.pushed.some((p) => p.channel === 'voiceActions:begin')).toBe(false)
  })

  it('a meeting that starts during the turn revokes the lease, zeroes the PCM and stops the turn', async () => {
    const h = rig()
    h.emit('armed')
    const { sessionId } = renderer(h) as { sessionId: string }
    h.emit('released')
    const pending = h.capture.finish(owner, sessionId, 1)
    h.meeting(true)
    expect(h.authority.activeLease).toBeNull()
    expect(h.runtime.snapshot()).toMatchObject({ state: 'failed', reason: 'meeting_started' })
    h.release('open notes')
    await expect(pending).resolves.toEqual({ ok: false, reason: 'stale' })
    expect(h.transcribed[0]?.every((v) => v === 0)).toBe(true)
    expect(h.authority.hasMeetingReservation).toBe(true)
  })

  it.each([
    ['screen-locked', 'screen_locked'],
    ['sign-out', 'session_ended'],
    ['system-suspend', 'system_suspend']
  ] as const)('a %s hard stop revokes the lease, zeroes the PCM and ends the turn', async (stop, reason) => {
    const h = rig()
    h.emit('armed')
    const { sessionId } = renderer(h) as { sessionId: string }
    h.emit('released')
    const pending = h.capture.finish(owner, sessionId, 1)
    h.authority.hardStop(stop)
    expect(h.authority.activeLease).toBeNull()
    expect(h.runtime.snapshot()).toMatchObject({ state: 'failed', reason })
    h.release('open notes')
    await expect(pending).resolves.toEqual({ ok: false, reason: 'stale' })
    expect(h.transcribed[0]?.every((v) => v === 0)).toBe(true)
  })

  it('a renderer reset revokes the voice lease under renderer-reset and zeroes the PCM', async () => {
    const h = rig()
    h.emit('armed')
    const { sessionId } = renderer(h) as { sessionId: string }
    h.emit('released')
    const pending = h.capture.finish(owner, sessionId, 1)
    h.runtime.onRendererReset()
    expect(h.authority.activeLease).toBeNull()
    expect(h.runtime.snapshot()).toMatchObject({ state: 'failed', reason: 'renderer_reset' })
    h.release('open notes')
    await expect(pending).resolves.toEqual({ ok: false, reason: 'stale' })
    expect(h.transcribed[0]?.every((v) => v === 0)).toBe(true)
  })

  it('a released turn that recognizes speech returns to idle and consumes nothing else', async () => {
    const h = rig()
    h.emit('armed')
    const { sessionId } = renderer(h) as { sessionId: string }
    h.emit('released')
    const pending = h.capture.finish(owner, sessionId, 1)
    h.release('open notes')
    await expect(pending).resolves.toEqual({ ok: true })
    expect(h.runtime.snapshot()).toMatchObject({ state: 'idle', reason: null })
  })

  it('toggling off in settings revokes a live lease and the turn in the same tick', () => {
    const h = rig()
    h.emit('armed')
    renderer(h)
    expect(h.authority.activeLease).not.toBeNull()
    h.setEnabled(false)
    h.runtime.refresh()
    expect(h.authority.activeLease).toBeNull()
    expect(h.runtime.snapshot()).toMatchObject({ state: 'off', enabled: false, shortcut: 'stopped' })
    h.emit('armed')
    expect(h.runtime.snapshot().state).toBe('off')
  })

  it('an explicit voice turn preempts an ambient lease and an ambient start cannot preempt it', () => {
    const h = rig()
    expect(h.authority.start(owner, { source: 'wake', purpose: 'conversation', activation: 'ambient' }).ok).toBe(true)
    h.emit('armed')
    expect(renderer(h).ok).toBe(true)
    expect(h.authority.activeLease?.source).toBe('push-to-talk')
    expect(h.authority.start(owner, { source: 'wake', purpose: 'conversation', activation: 'ambient' })).toEqual({
      ok: false,
      reason: 'busy'
    })
  })
})
