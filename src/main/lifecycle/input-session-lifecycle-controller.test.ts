import { describe, expect, it, vi } from 'vitest'
import type { InputSessionStopReason } from '@shared/input-session'
import { InputSessionAuthority } from '../input-session-authority'
import { MeetingMicCaptureAuthority } from '../meeting-mic-capture-authority'
import {
  MEETING_START_ACTION,
  MeetingStartActivationAuthority,
  type MeetingStartActivationFrame
} from '../meeting-start-activation-authority'
import { InputSessionLifecycleController } from './input-session-lifecycle-controller'

const URL = 'file:///renderer/index.html'
const FRAME: MeetingStartActivationFrame = {
  webContentsId: 1,
  frameId: '11:22',
  isTopFrame: true,
  url: URL
}
const INPUT_OWNER = {
  webContentsId: 1,
  frameId: '11:22',
  isTopFrame: true,
  authSessionGeneration: 7,
  contextRevision: 0
} as const
const FATAL_REASONS = [
  'auth-revoked',
  'sign-out',
  'owner-replaced',
  'system-suspend',
  'screen-locked',
  'shutdown'
] as const satisfies readonly InputSessionStopReason[]
const NONFATAL_REASONS = [
  'user-stop',
  'cancelled',
  'window-hidden',
  'device-change',
  'renderer-reset',
  'arbitration-preempted'
] as const satisfies readonly InputSessionStopReason[]

interface FixtureOptions {
  reservation?: number | null
  activeSpeakerStartedAt?: number | null
  captureOwnerWebContentsId?: number | null
  windowMode?: 'live' | 'missing' | 'destroyed' | 'mismatched'
  throwOnSend?: boolean
  rejectNativeReleases?: boolean
  /** Enables the owner-session dependency; 'throws' makes revokeAll throw, 'getter-throws' makes the getter throw. */
  ownerSession?: 'live' | 'throws' | 'getter-throws'
}

type OwnerRevokeReason = import('@shared/contracts/owner-session').OwnerSessionRevokeReason

function setup(options: FixtureOptions = {}) {
  const events: string[] = []
  let contextRevision = 0
  let activeSpeakerStartedAt =
    'activeSpeakerStartedAt' in options
      ? options.activeSpeakerStartedAt!
      : typeof options.reservation === 'number'
        ? options.reservation
        : null
  let captureOwnerWebContentsId: number | null =
    'captureOwnerWebContentsId' in options ? options.captureOwnerWebContentsId! : 1
  let captureSequence = 0

  const inputSessionAuthority = new InputSessionAuthority({
    onRevoked: (_owner, _lease, reason) => events.push(`input-revoked:${reason}`)
  })
  if (options.reservation !== undefined) inputSessionAuthority.reserveMeeting(options.reservation)

  const meetingStartActivationAuthority = new MeetingStartActivationAuthority({
    state: () => ({
      mainWebContentsId: 1,
      mainFrameId: FRAME.frameId,
      isWindowVisible: true,
      isAuthenticated: true,
      isStartAllowed: true,
      currentUrl: URL,
      context: { authSessionGeneration: 7, contextRevision }
    })
  })

  const meetingMicCaptureAuthority = new MeetingMicCaptureAuthority({
    currentState: () => ({
      mainWebContentsId: 1,
      isWindowVisible: true,
      isAuthenticated: true,
      currentUrl: URL,
      context: { authSessionGeneration: 7, contextRevision },
      meetingStartedAt: inputSessionAuthority.hasMeetingReservation ? inputSessionAuthority.meetingStartedAt : null
    }),
    createCaptureId: () => `00000000-0000-4000-8000-${String(++captureSequence).padStart(12, '0')}`,
    onRevoked: (_owner, reason) => events.push(`capture-grant-revoked:${reason}`)
  })

  const originalRevokeAll = meetingStartActivationAuthority.revokeAll.bind(meetingStartActivationAuthority)
  vi.spyOn(meetingStartActivationAuthority, 'revokeAll').mockImplementation(() => {
    events.push('activation-revoke-all')
    originalRevokeAll()
  })
  const originalHardStop = inputSessionAuthority.hardStop.bind(inputSessionAuthority)
  vi.spyOn(inputSessionAuthority, 'hardStop').mockImplementation((reason) => {
    events.push(`input-hard-stop:${reason}`)
    originalHardStop(reason)
  })
  const originalRevokeMeeting = meetingMicCaptureAuthority.revokeMeeting.bind(meetingMicCaptureAuthority)
  vi.spyOn(meetingMicCaptureAuthority, 'revokeMeeting').mockImplementation((startedAt, reason) => {
    events.push(`meeting-grants:${String(startedAt)}:${reason}`)
    originalRevokeMeeting(startedAt, reason)
  })
  const originalReleaseMeeting = inputSessionAuthority.releaseMeeting.bind(inputSessionAuthority)
  const releaseMeeting = vi.spyOn(inputSessionAuthority, 'releaseMeeting').mockImplementation((startedAt) => {
    events.push(`release-meeting:${String(startedAt)}`)
    return originalReleaseMeeting(startedAt)
  })

  const send = vi.fn((_channel: string, payload: { startedAt: number; reason: InputSessionStopReason }) => {
    events.push(`renderer-revoked:${payload.startedAt}:${payload.reason}`)
    if (options.throwOnSend) throw new Error('synthetic renderer teardown')
  })
  let destroyed = options.windowMode === 'destroyed'
  const liveWindow = {
    isDestroyed: () => destroyed,
    webContents: { id: options.windowMode === 'mismatched' ? 2 : 1, send }
  }
  let currentWindow: typeof liveWindow | null = options.windowMode === 'missing' ? null : liveWindow

  const setLegacyListeningActive = vi.fn((on: boolean) => events.push(`legacy-listening:${on}`))
  const setListeningActive = vi.fn((on: boolean) => events.push(`listening:${on}`))
  const setTrayRecording = vi.fn((on: boolean) => events.push(`tray-recording:${on}`))
  const setRecordingPowerSaveBlock = vi.fn((on: boolean) => events.push(`power-save:${on}`))
  const parakeetRelease = vi.fn(() => {
    events.push('release-parakeet')
    return options.rejectNativeReleases ? Promise.reject(new Error('synthetic parakeet release')) : Promise.resolve()
  })
  const releaseSpeakerEmbedding = vi.fn(() => {
    events.push('release-speaker-embedding')
    return options.rejectNativeReleases
      ? Promise.reject(new Error('synthetic speaker embedding release'))
      : Promise.resolve()
  })
  const discardActiveLiveSpeakerSession = vi.fn(() => {
    events.push('discard-live-speaker')
    const startedAt = activeSpeakerStartedAt
    activeSpeakerStartedAt = null
    inputSessionAuthority.releaseMeeting(startedAt)
    setLegacyListeningActive(false)
  })

  const ownerRevokeAll = vi.fn((reason: OwnerRevokeReason) => {
    events.push(`owner-revoke-all:${reason}`)
    if (options.ownerSession === 'throws') throw new Error('synthetic owner revocation failure')
  })
  let ownerAuthority: { revokeAll: typeof ownerRevokeAll } | null = { revokeAll: ownerRevokeAll }
  const controller = new InputSessionLifecycleController({
    ...(options.ownerSession
      ? {
          ownerSession: () => {
            if (options.ownerSession === 'getter-throws') throw new Error('synthetic owner lookup failure')
            return ownerAuthority
          }
        }
      : {}),
    inputSessionAuthority,
    meetingStartActivationAuthority,
    meetingMicCaptureAuthority,
    meetingMicCaptureRevokedChannel: 'meeting:mic-capture-revoked',
    incrementInputSessionContextRevision: () => {
      contextRevision += 1
      events.push('context-revision')
    },
    getWindow: () => currentWindow,
    getMeetingCaptureOwnerWebContentsId: () => captureOwnerWebContentsId,
    setMeetingCaptureOwnerWebContentsId: (id) => {
      captureOwnerWebContentsId = id
      events.push(`capture-owner:${String(id)}`)
    },
    getActiveLiveSpeakerStartedAt: () => activeSpeakerStartedAt,
    setActiveLiveSpeakerStartedAt: (startedAt) => {
      activeSpeakerStartedAt = startedAt
      events.push(`active-speaker:${String(startedAt)}`)
    },
    discardActiveLiveSpeakerSession,
    closeLiveSpeakerReceipt: (startedAt) => events.push(`close-live-speaker:${startedAt}`),
    setLegacyListeningActive,
    setListeningActive,
    setTrayRecording,
    setRecordingPowerSaveBlock,
    parakeetRelease,
    releaseSpeakerEmbedding
  })

  return {
    controller,
    events,
    ownerRevokeAll,
    setOwnerAuthority(next: { revokeAll: typeof ownerRevokeAll } | null) {
      ownerAuthority = next
    },
    inputSessionAuthority,
    meetingStartActivationAuthority,
    meetingMicCaptureAuthority,
    releaseMeeting,
    send,
    setWindowMode(mode: 'live' | 'missing' | 'destroyed' | 'mismatched') {
      destroyed = mode === 'destroyed'
      currentWindow =
        mode === 'missing'
          ? null
          : { ...liveWindow, webContents: { ...liveWindow.webContents, id: mode === 'mismatched' ? 2 : 1 } }
    },
    revision: () => contextRevision,
    activeSpeakerStartedAt: () => activeSpeakerStartedAt,
    captureOwnerWebContentsId: () => captureOwnerWebContentsId,
    nativeReleases: { parakeetRelease, releaseSpeakerEmbedding },
    speakerDisposition: {
      discardActiveLiveSpeakerSession,
      setLegacyListeningActive,
      setListeningActive,
      setTrayRecording,
      setRecordingPowerSaveBlock
    }
  }
}

function admitCapture(fixture: ReturnType<typeof setup>, startedAt: number): string {
  const grant = fixture.meetingMicCaptureAuthority.admit(FRAME, startedAt)
  if (!grant) throw new Error('expected real meeting microphone capture admission')
  return grant.captureId
}

type InputPowerLifecycleEvent = 'suspend' | 'lock-screen'

const POWER_HOOK_ERRORS: Record<InputPowerLifecycleEvent, string> = {
  suspend: '[input-session] microphone suspend revocation hook failed:',
  'lock-screen': '[input-session] microphone lock-screen revocation hook failed:'
}
const INCOMPLETE_POWER_HOOKS = '[input-session] microphone admission disabled: OS lifecycle hooks are incomplete'

function installPowerHooks(
  fixture: ReturnType<typeof setup>,
  failures: Partial<Record<InputPowerLifecycleEvent, Error>> = {}
) {
  const trace: string[] = []
  const callbacks = new Map<InputPowerLifecycleEvent, () => void>()
  const register = vi.fn((event: InputPowerLifecycleEvent, callback: () => void) => {
    trace.push(`register:${event}`)
    const failure = failures[event]
    if (failure) throw failure
    callbacks.set(event, callback)
  })
  const setReady = vi.fn((ready: boolean) => trace.push(`ready:${ready}`))
  const logger = {
    error: vi.fn((message: string, error?: unknown) => {
      trace.push(error === undefined ? `error:${message}` : `error:${message}:original`)
    })
  }
  const ready = fixture.controller.installInputPowerLifecycleHooks(register, setReady, logger)
  return { callbacks, logger, ready, register, setReady, trace }
}

function admitInteractiveCapture(fixture: ReturnType<typeof setup>): void {
  fixture.meetingStartActivationAuthority.mint(FRAME, MEETING_START_ACTION)
  expect(
    fixture.inputSessionAuthority.start(INPUT_OWNER, {
      source: 'push-to-talk',
      purpose: 'dictation',
      activation: 'explicit'
    }).ok
  ).toBe(true)
}

function expectInteractivePowerCallbackRevocation(
  fixture: ReturnType<typeof setup>,
  reason: 'system-suspend' | 'screen-locked'
): void {
  expect(fixture.events).toEqual([
    'activation-revoke-all',
    'context-revision',
    `input-hard-stop:${reason}`,
    `input-revoked:${reason}`
  ])
  expect(fixture.meetingStartActivationAuthority.hasPending(FRAME)).toBe(false)
  expect(fixture.inputSessionAuthority.activeLease).toBeNull()
  expect(fixture.revision()).toBe(1)
}

function expectMeetingPowerCallbackRevocation(
  fixture: ReturnType<typeof setup>,
  reason: 'system-suspend' | 'screen-locked',
  captureId: string
): void {
  expect(fixture.events).toEqual([
    'activation-revoke-all',
    'context-revision',
    `input-hard-stop:${reason}`,
    `renderer-revoked:654:${reason}`,
    `meeting-grants:654:${reason}`,
    `capture-grant-revoked:${reason}`,
    'release-meeting:654',
    'close-live-speaker:654',
    'active-speaker:null',
    'context-revision',
    'capture-owner:null',
    'legacy-listening:false',
    'listening:false',
    'tray-recording:false',
    'power-save:false',
    'release-parakeet',
    'release-speaker-embedding'
  ])
  expect(fixture.meetingStartActivationAuthority.hasPending(FRAME)).toBe(false)
  expect(fixture.inputSessionAuthority.activeLease).toBeNull()
  expect(fixture.meetingMicCaptureAuthority.release(1, captureId)).toBe(false)
  expect(fixture.meetingMicCaptureAuthority.revokeMeeting).toHaveBeenCalledWith(654, reason)
  expect(fixture.releaseMeeting).toHaveBeenCalledWith(654)
  expect(fixture.inputSessionAuthority.hasMeetingReservation).toBe(false)
  expect(fixture.activeSpeakerStartedAt()).toBeNull()
  expect(fixture.revision()).toBe(2)
  expect(fixture.captureOwnerWebContentsId()).toBeNull()
  expect(fixture.send).toHaveBeenCalledExactlyOnceWith('meeting:mic-capture-revoked', {
    startedAt: 654,
    reason
  })
  expect(fixture.nativeReleases.parakeetRelease).toHaveBeenCalledTimes(1)
  expect(fixture.nativeReleases.releaseSpeakerEmbedding).toHaveBeenCalledTimes(1)
}

describe('InputSessionLifecycleController', () => {
  it('registers suspend and lock-screen hooks before marking lifecycle readiness', () => {
    const fixture = setup()

    const hooks = installPowerHooks(fixture)

    expect(hooks.ready).toBe(true)
    expect(hooks.register.mock.calls.map(([event]) => event)).toEqual(['suspend', 'lock-screen'])
    expect(hooks.trace).toEqual(['register:suspend', 'register:lock-screen', 'ready:true'])
    expect(hooks.setReady).toHaveBeenCalledExactlyOnceWith(true)
    expect(hooks.logger.error).not.toHaveBeenCalled()
  })

  it('continues to register lock-screen when suspend registration throws', () => {
    const fixture = setup()
    const suspendError = new Error('suspend registration failed')

    const hooks = installPowerHooks(fixture, { suspend: suspendError })

    expect(hooks.ready).toBe(false)
    expect(hooks.register.mock.calls.map(([event]) => event)).toEqual(['suspend', 'lock-screen'])
    expect(hooks.trace).toEqual([
      'register:suspend',
      'error:[input-session] microphone suspend revocation hook failed::original',
      'register:lock-screen',
      'ready:false',
      `error:${INCOMPLETE_POWER_HOOKS}`
    ])
    expect(hooks.setReady).toHaveBeenCalledExactlyOnceWith(false)
    expect(hooks.logger.error.mock.calls).toEqual([[POWER_HOOK_ERRORS.suspend, suspendError], [INCOMPLETE_POWER_HOOKS]])
  })

  it('keeps suspend registration when lock-screen registration throws', () => {
    const fixture = setup()
    const lockError = new Error('lock-screen registration failed')

    const hooks = installPowerHooks(fixture, { 'lock-screen': lockError })

    expect(hooks.ready).toBe(false)
    expect(hooks.register.mock.calls.map(([event]) => event)).toEqual(['suspend', 'lock-screen'])
    expect(hooks.trace).toEqual([
      'register:suspend',
      'register:lock-screen',
      'error:[input-session] microphone lock-screen revocation hook failed::original',
      'ready:false',
      `error:${INCOMPLETE_POWER_HOOKS}`
    ])
    expect(hooks.setReady).toHaveBeenCalledExactlyOnceWith(false)
    expect(hooks.logger.error.mock.calls).toEqual([
      [POWER_HOOK_ERRORS['lock-screen'], lockError],
      [INCOMPLETE_POWER_HOOKS]
    ])
  })

  it('attempts both registrations and preserves both errors when both throw', () => {
    const fixture = setup()
    const suspendError = new Error('suspend registration failed')
    const lockError = new Error('lock-screen registration failed')

    const hooks = installPowerHooks(fixture, { suspend: suspendError, 'lock-screen': lockError })

    expect(hooks.ready).toBe(false)
    expect(hooks.register.mock.calls.map(([event]) => event)).toEqual(['suspend', 'lock-screen'])
    expect(hooks.trace).toEqual([
      'register:suspend',
      'error:[input-session] microphone suspend revocation hook failed::original',
      'register:lock-screen',
      'error:[input-session] microphone lock-screen revocation hook failed::original',
      'ready:false',
      `error:${INCOMPLETE_POWER_HOOKS}`
    ])
    expect(hooks.setReady).toHaveBeenCalledExactlyOnceWith(false)
    expect(hooks.logger.error.mock.calls).toEqual([
      [POWER_HOOK_ERRORS.suspend, suspendError],
      [POWER_HOOK_ERRORS['lock-screen'], lockError],
      [INCOMPLETE_POWER_HOOKS]
    ])
  })

  it.each([
    ['suspend', 'system-suspend'],
    ['lock-screen', 'screen-locked']
  ] as const)('runs the registered %s callback through the real hard-stop chain', (event, reason) => {
    const interactive = setup()
    admitInteractiveCapture(interactive)
    const interactiveHooks = installPowerHooks(interactive)

    interactiveHooks.callbacks.get(event)?.()
    expectInteractivePowerCallbackRevocation(interactive, reason)

    const meeting = setup({ reservation: 654, activeSpeakerStartedAt: 654 })
    const captureId = admitCapture(meeting, 654)
    const meetingHooks = installPowerHooks(meeting)
    meetingHooks.callbacks.get(event)?.()
    expectMeetingPowerCallbackRevocation(meeting, reason, captureId)
  })

  it.each([
    ['suspend', 'lock-screen', 'screen-locked'],
    ['lock-screen', 'suspend', 'system-suspend']
  ] as const)('keeps the %s listener live when %s registration fails', (failedEvent, liveEvent, reason) => {
    const fixture = setup({ reservation: 654, activeSpeakerStartedAt: 654 })
    const captureId = admitCapture(fixture, 654)
    const failure = new Error(`${failedEvent} registration failed`)
    const hooks = installPowerHooks(fixture, { [failedEvent]: failure })

    expect(hooks.ready).toBe(false)
    hooks.callbacks.get(liveEvent)?.()

    expect(hooks.trace.indexOf('ready:false')).toBeGreaterThan(hooks.trace.indexOf(`register:${liveEvent}`))
    expectMeetingPowerCallbackRevocation(fixture, reason, captureId)
  })

  it('revokes activations, advances context, then stops interactive authority', () => {
    const fixture = setup()
    fixture.meetingStartActivationAuthority.mint(FRAME, MEETING_START_ACTION)
    expect(
      fixture.inputSessionAuthority.start(INPUT_OWNER, {
        source: 'push-to-talk',
        purpose: 'dictation',
        activation: 'explicit'
      }).ok
    ).toBe(true)

    fixture.controller.hardStopInputSession('window-hidden')

    expect(fixture.events).toEqual([
      'activation-revoke-all',
      'context-revision',
      'input-hard-stop:window-hidden',
      'input-revoked:window-hidden'
    ])
    expect(fixture.meetingStartActivationAuthority.hasPending(FRAME)).toBe(false)
    expect(fixture.inputSessionAuthority.activeLease).toBeNull()
    expect(fixture.revision()).toBe(1)
  })

  it('advances context on an input hard stop even when no interactive lease exists', () => {
    const fixture = setup()

    fixture.controller.hardStopInputSession('device-change')

    expect(fixture.inputSessionAuthority.activeLease).toBeNull()
    expect(fixture.revision()).toBe(1)
    expect(fixture.events.slice(0, 3)).toEqual([
      'activation-revoke-all',
      'context-revision',
      'input-hard-stop:device-change'
    ])
  })

  it.each(FATAL_REASONS)('tears down the admitted meeting for fatal input stop reason %s', (reason) => {
    const fixture = setup({ reservation: 654, activeSpeakerStartedAt: 654 })

    fixture.controller.hardStopInputSession(reason)

    expect(fixture.events.indexOf(`activation-revoke-all`)).toBeLessThan(
      fixture.events.indexOf(`input-hard-stop:${reason}`)
    )
    expect(fixture.events.indexOf(`input-hard-stop:${reason}`)).toBeLessThan(
      fixture.events.indexOf(`meeting-grants:654:${reason}`)
    )
    expect(fixture.meetingMicCaptureAuthority.revokeMeeting).toHaveBeenCalledWith(654, reason)
    expect(fixture.releaseMeeting).toHaveBeenCalledWith(654)
    expect(fixture.inputSessionAuthority.hasMeetingReservation).toBe(false)
    expect(fixture.revision()).toBe(2)
    expect(fixture.captureOwnerWebContentsId()).toBeNull()
  })

  it.each(NONFATAL_REASONS)('keeps the meeting reservation on nonfatal input stop reason %s', (reason) => {
    const fixture = setup({ reservation: 654, activeSpeakerStartedAt: 654 })
    const captureId = admitCapture(fixture, 654)

    fixture.controller.hardStopInputSession(reason)

    expect(fixture.inputSessionAuthority.meetingStartedAt).toBe(654)
    expect(fixture.meetingMicCaptureAuthority.revokeMeeting).not.toHaveBeenCalled()
    expect(fixture.releaseMeeting).not.toHaveBeenCalled()
    expect(
      fixture.meetingMicCaptureAuthority.hasPermissionRequestOwner(
        1,
        654,
        { authSessionGeneration: 7, contextRevision: 0 },
        URL
      )
    ).toBe(true)
    expect(fixture.meetingMicCaptureAuthority.release(1, captureId)).toBe(true)
    expect(fixture.revision()).toBe(1)
    expect(fixture.nativeReleases.parakeetRelease).not.toHaveBeenCalled()
  })

  it('keeps pending-grant cleanup separate and preserves established meeting capture', () => {
    const pending = setup({ reservation: 654 })
    const pendingId = admitCapture(pending, 654)
    pending.controller.hardStopInputSession('window-hidden')
    pending.meetingMicCaptureAuthority.revokePending('window-hidden')
    expect(pending.meetingMicCaptureAuthority.release(1, pendingId)).toBe(false)
    expect(pending.inputSessionAuthority.meetingStartedAt).toBe(654)

    const permissionAuthorized = setup({ reservation: 656 })
    const permissionAuthorizedId = admitCapture(permissionAuthorized, 656)
    expect(permissionAuthorized.meetingMicCaptureAuthority.claimPermissionRequest(FRAME)).toBe(true)
    permissionAuthorized.controller.hardStopInputSession('window-hidden')
    permissionAuthorized.meetingMicCaptureAuthority.revokePending('window-hidden')
    expect(permissionAuthorized.meetingMicCaptureAuthority.release(1, permissionAuthorizedId)).toBe(false)
    expect(permissionAuthorized.inputSessionAuthority.meetingStartedAt).toBe(656)

    const established = setup({ reservation: 655 })
    const establishedId = admitCapture(established, 655)
    expect(established.meetingMicCaptureAuthority.claimPermissionRequest(FRAME)).toBe(true)
    expect(established.meetingMicCaptureAuthority.confirm(FRAME, establishedId, 655)).toBe(true)
    established.controller.hardStopInputSession('window-hidden')
    established.meetingMicCaptureAuthority.revokePending('window-hidden')
    expect(established.meetingMicCaptureAuthority.release(1, establishedId)).toBe(true)
    expect(established.inputSessionAuthority.meetingStartedAt).toBe(655)
  })

  it('notifies the matching live owner, revokes exact grants, then closes the matching speaker receipt', () => {
    const fixture = setup({ reservation: 654, activeSpeakerStartedAt: 654 })
    const captureId = admitCapture(fixture, 654)

    fixture.controller.hardStopMeetingCapture('owner-replaced')

    expect(fixture.send).toHaveBeenCalledWith('meeting:mic-capture-revoked', {
      startedAt: 654,
      reason: 'owner-replaced'
    })
    expect(fixture.events.indexOf('renderer-revoked:654:owner-replaced')).toBeLessThan(
      fixture.events.indexOf('meeting-grants:654:owner-replaced')
    )
    expect(fixture.events.indexOf('meeting-grants:654:owner-replaced')).toBeLessThan(
      fixture.events.indexOf('release-meeting:654')
    )
    expect(fixture.events.indexOf('release-meeting:654')).toBeLessThan(fixture.events.indexOf('close-live-speaker:654'))
    expect(fixture.meetingMicCaptureAuthority.release(1, captureId)).toBe(false)
    expect(fixture.inputSessionAuthority.hasMeetingReservation).toBe(false)
    expect(fixture.activeSpeakerStartedAt()).toBeNull()
    expect(fixture.revision()).toBe(1)
    expect(fixture.speakerDisposition.setLegacyListeningActive).toHaveBeenCalledWith(false)
    expect(fixture.speakerDisposition.setListeningActive).toHaveBeenCalledWith(false)
    expect(fixture.speakerDisposition.setTrayRecording).toHaveBeenCalledWith(false)
    expect(fixture.speakerDisposition.setRecordingPowerSaveBlock).toHaveBeenCalledWith(false)
    expect(fixture.events.slice(-2)).toEqual(['release-parakeet', 'release-speaker-embedding'])
  })

  it('does not close a different active speaker identity', () => {
    const fixture = setup({ reservation: 654, activeSpeakerStartedAt: 655 })

    fixture.controller.hardStopMeetingCapture('owner-replaced')

    expect(fixture.events).not.toContain('close-live-speaker:654')
    expect(fixture.activeSpeakerStartedAt()).toBe(655)
    expect(fixture.inputSessionAuthority.hasMeetingReservation).toBe(false)
  })

  it.each([
    'missing',
    'destroyed',
    'mismatched'
  ] as const)('continues teardown without notifying a %s capture window', (windowMode) => {
    const fixture = setup({ reservation: 654, activeSpeakerStartedAt: 654, windowMode })

    fixture.controller.hardStopMeetingCapture('owner-replaced')

    expect(fixture.send).not.toHaveBeenCalled()
    expect(fixture.inputSessionAuthority.hasMeetingReservation).toBe(false)
    expect(fixture.nativeReleases.parakeetRelease).toHaveBeenCalledTimes(1)
  })

  it('continues teardown when sending the renderer notification throws', () => {
    const fixture = setup({ reservation: 654, activeSpeakerStartedAt: 654, throwOnSend: true })

    expect(() => fixture.controller.hardStopMeetingCapture('owner-replaced')).not.toThrow()

    expect(fixture.send).toHaveBeenCalledTimes(1)
    expect(fixture.meetingMicCaptureAuthority.revokeMeeting).toHaveBeenCalledWith(654, 'owner-replaced')
    expect(fixture.inputSessionAuthority.hasMeetingReservation).toBe(false)
    expect(fixture.nativeReleases.parakeetRelease).toHaveBeenCalledTimes(1)
  })

  it('keeps null legacy identity unnotified while still releasing its reservation', () => {
    const fixture = setup({ reservation: null })

    fixture.controller.hardStopMeetingCapture('user-stop')

    expect(fixture.send).not.toHaveBeenCalled()
    expect(fixture.releaseMeeting).toHaveBeenCalledWith(null)
    expect(fixture.inputSessionAuthority.hasMeetingReservation).toBe(false)
    expect(fixture.nativeReleases.releaseSpeakerEmbedding).toHaveBeenCalledTimes(1)
  })

  it('discards an exact crashed speaker identity and lets discard own reservation release', () => {
    const fixture = setup({ reservation: 654, activeSpeakerStartedAt: 654 })

    fixture.controller.hardStopMeetingCapture('owner-replaced', 'discard')

    expect(fixture.speakerDisposition.discardActiveLiveSpeakerSession).toHaveBeenCalledTimes(1)
    expect(fixture.events).not.toContain('close-live-speaker:654')
    expect(fixture.releaseMeeting).toHaveBeenCalledTimes(1)
    expect(fixture.inputSessionAuthority.hasMeetingReservation).toBe(false)
    expect(fixture.activeSpeakerStartedAt()).toBeNull()
    expect(fixture.nativeReleases.parakeetRelease).toHaveBeenCalledTimes(1)
  })

  it('does nothing without a reservation and makes completed teardown idempotent', () => {
    const empty = setup()
    empty.controller.hardStopMeetingCapture('owner-replaced')
    expect(empty.events).toEqual([])

    const fixture = setup({ reservation: 654, activeSpeakerStartedAt: 654 })
    fixture.controller.hardStopMeetingCapture('owner-replaced')
    const completedEvents = [...fixture.events]
    fixture.controller.hardStopMeetingCapture('owner-replaced')
    expect(fixture.events).toEqual(completedEvents)
    expect(fixture.releaseMeeting).toHaveBeenCalledTimes(1)
    expect(fixture.nativeReleases.parakeetRelease).toHaveBeenCalledTimes(1)
    expect(fixture.nativeReleases.releaseSpeakerEmbedding).toHaveBeenCalledTimes(1)
  })

  it('attaches rejection handlers to both fire-and-forget native release promises', async () => {
    const fixture = setup({ reservation: 654, rejectNativeReleases: true })
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)

    try {
      fixture.controller.hardStopMeetingCapture('owner-replaced')
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      expect(fixture.nativeReleases.parakeetRelease).toHaveBeenCalledTimes(1)
      expect(fixture.nativeReleases.releaseSpeakerEmbedding).toHaveBeenCalledTimes(1)
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})

describe('InputSessionLifecycleController owner-session revocation', () => {
  const GLOBAL_BOUNDARIES = [
    ['sign-out', 'sign-out'],
    ['auth-revoked', 'auth-changed'],
    ['system-suspend', 'suspend'],
    ['screen-locked', 'lock-screen'],
    ['shutdown', 'quit']
  ] as const satisfies ReadonlyArray<readonly [InputSessionStopReason, OwnerRevokeReason]>

  it.each(GLOBAL_BOUNDARIES)('%s revokes every owner session as %s exactly once, after teardown', (reason, owner) => {
    const fixture = setup({ reservation: 654, activeSpeakerStartedAt: 654, ownerSession: 'live' })
    admitCapture(fixture, 654)

    fixture.controller.hardStopInputSession(reason)

    expect(fixture.ownerRevokeAll).toHaveBeenCalledExactlyOnceWith(owner)
    expect(fixture.events.at(-1)).toBe(`owner-revoke-all:${owner}`)
    expect(fixture.events.indexOf(`owner-revoke-all:${owner}`)).toBeGreaterThan(
      fixture.events.indexOf('release-speaker-embedding')
    )
    expect(fixture.events.filter((event) => event.startsWith('owner-revoke-all'))).toHaveLength(1)
  })

  it.each(GLOBAL_BOUNDARIES)('%s revokes owner sessions even with no meeting reservation', (reason, owner) => {
    const fixture = setup({ ownerSession: 'live' })
    fixture.controller.hardStopInputSession(reason)
    expect(fixture.ownerRevokeAll).toHaveBeenCalledExactlyOnceWith(owner)
  })

  it.each([
    'user-stop',
    'cancelled',
    'window-hidden',
    'device-change',
    'renderer-reset',
    'arbitration-preempted',
    'owner-replaced'
  ] as const satisfies readonly InputSessionStopReason[])('%s never revokes owner sessions globally', (reason) => {
    const fixture = setup({ reservation: 654, activeSpeakerStartedAt: 654, ownerSession: 'live' })
    fixture.controller.hardStopInputSession(reason)
    expect(fixture.ownerRevokeAll).not.toHaveBeenCalled()
  })

  it('does not revoke owner sessions when only the meeting capture stops', () => {
    const fixture = setup({ reservation: 654, activeSpeakerStartedAt: 654, ownerSession: 'live' })
    fixture.controller.hardStopMeetingCapture('sign-out')
    expect(fixture.ownerRevokeAll).not.toHaveBeenCalled()
  })

  it.each([
    ['suspend', 'suspend'],
    ['lock-screen', 'lock-screen']
  ] as const)('the registered %s power callback revokes owner sessions as %s', (event, owner) => {
    const fixture = setup({ reservation: 654, activeSpeakerStartedAt: 654, ownerSession: 'live' })
    const hooks = installPowerHooks(fixture)
    hooks.callbacks.get(event)?.()
    expect(fixture.ownerRevokeAll).toHaveBeenCalledExactlyOnceWith(owner)
  })

  it.each([
    ['suspend', 'lock-screen', 'lock-screen'],
    ['lock-screen', 'suspend', 'suspend']
  ] as const)('the surviving %s-failed %s listener still revokes owner sessions', (failed, live, owner) => {
    const fixture = setup({ ownerSession: 'live' })
    const hooks = installPowerHooks(fixture, { [failed]: new Error('registration failed') })
    expect(hooks.callbacks.has(failed)).toBe(false)
    hooks.callbacks.get(live)?.()
    expect(fixture.ownerRevokeAll).toHaveBeenCalledExactlyOnceWith(owner)
  })

  it('resolves the authority lazily on each stop, so a later-created authority is covered', () => {
    const fixture = setup({ ownerSession: 'live' })
    fixture.setOwnerAuthority(null)
    expect(() => fixture.controller.hardStopInputSession('sign-out')).not.toThrow()
    expect(fixture.ownerRevokeAll).not.toHaveBeenCalled()

    fixture.setOwnerAuthority({ revokeAll: fixture.ownerRevokeAll })
    fixture.controller.hardStopInputSession('sign-out')
    expect(fixture.ownerRevokeAll).toHaveBeenCalledExactlyOnceWith('sign-out')
  })

  it('a later boundary revokes again after an earlier one (no stale once-only latch)', () => {
    const fixture = setup({ ownerSession: 'live' })
    fixture.controller.hardStopInputSession('screen-locked')
    fixture.controller.hardStopInputSession('sign-out')
    expect(fixture.ownerRevokeAll.mock.calls).toEqual([['lock-screen'], ['sign-out']])
  })

  it.each([
    'throws',
    'getter-throws'
  ] as const)('finishes the whole teardown when owner revocation fails (%s)', (mode) => {
    const fixture = setup({ reservation: 654, activeSpeakerStartedAt: 654, ownerSession: mode })
    const captureId = admitCapture(fixture, 654)

    expect(() => fixture.controller.hardStopInputSession('sign-out')).not.toThrow()

    expect(fixture.nativeReleases.releaseSpeakerEmbedding).toHaveBeenCalledTimes(1)
    expect(fixture.inputSessionAuthority.hasMeetingReservation).toBe(false)
    expect(fixture.meetingMicCaptureAuthority.release(1, captureId)).toBe(false)
  })

  it('still revokes owner sessions when meeting teardown throws', () => {
    const fixture = setup({ reservation: 654, activeSpeakerStartedAt: 654, ownerSession: 'live' })
    fixture.nativeReleases.parakeetRelease.mockImplementationOnce(() => {
      throw new Error('synthetic native release failure')
    })
    expect(() => fixture.controller.hardStopInputSession('shutdown')).toThrow('synthetic native release failure')
    expect(fixture.ownerRevokeAll).toHaveBeenCalledExactlyOnceWith('quit')
  })

  it('keeps existing construction without an owner-session dependency working', () => {
    const fixture = setup({ reservation: 654, activeSpeakerStartedAt: 654 })
    expect(() => fixture.controller.hardStopInputSession('sign-out')).not.toThrow()
    expect(fixture.ownerRevokeAll).not.toHaveBeenCalled()
  })
})
