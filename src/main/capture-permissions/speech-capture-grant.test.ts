import { describe, expect, it } from 'vitest'
import { SpeechCaptureGrantRegistry, type SpeechCaptureContext } from './speech-capture-grant'

function context(overrides: Partial<SpeechCaptureContext> = {}): SpeechCaptureContext {
  return {
    webContents: {},
    frame: {},
    navigationEpoch: 4,
    listenStartedAt: 1_893_456_000_000,
    ...overrides
  }
}

function armedRegistry(owner = context()) {
  const registry = new SpeechCaptureGrantRegistry()
  registry.acceptListenContext(owner)
  registry.setArmed(true)
  return { registry, owner }
}

describe('SpeechCaptureGrantRegistry', () => {
  it('reconciles an accepted successor while duplicate context preserves the current issued grant', () => {
    const { registry, owner } = armedRegistry()
    const pending = registry.beginPendingGrant(owner)!
    registry.recordGrantCallbackResult(pending, owner, { callbackSucceeded: true, audioGranted: true })
    expect(registry.reconcileListenContext({ ...owner })).toBe(true)
    expect(registry.hasIssuedLoopbackGrant(owner)).toBe(true)
    const successor = { ...owner, listenStartedAt: owner.listenStartedAt + 1 }
    expect(registry.reconcileListenContext(successor)).toBe(true)
    expect(registry.getAcceptedListenContext()).toEqual(successor)
    expect(registry.hasIssuedLoopbackGrant(owner)).toBe(false)
    expect(registry.hasIssuedLoopbackGrant(successor)).toBe(false)
  })
  it('records only a successful nonempty grant for the exact still-current async context', () => {
    const { registry, owner } = armedRegistry()
    const pending = registry.beginPendingGrant(owner)
    expect(pending).not.toBeNull()
    if (!pending) return
    expect(registry.isPendingGrantCurrent(pending, owner)).toBe(true)
    const replacement = context({ listenStartedAt: owner.listenStartedAt + 1 })
    registry.acceptListenContext(replacement)
    expect(registry.isPendingGrantCurrent(pending, owner)).toBe(false)
    expect(
      registry.recordGrantCallbackResult(pending, owner, { callbackSucceeded: true, audioGranted: true })
    ).toBeNull()
    expect(registry.hasIssuedLoopbackGrant(owner)).toBe(false)
  })

  it('requires callback success and an actual loopback grant before recording the fact', () => {
    const { registry, owner } = armedRegistry()
    const failedCallback = registry.beginPendingGrant(owner)
    expect(failedCallback).not.toBeNull()
    if (!failedCallback) return
    expect(
      registry.recordGrantCallbackResult(failedCallback, owner, { callbackSucceeded: false, audioGranted: true })
    ).toBeNull()
    const denied = registry.beginPendingGrant(owner)
    expect(denied).not.toBeNull()
    if (!denied) return
    expect(
      registry.recordGrantCallbackResult(denied, owner, { callbackSucceeded: true, audioGranted: false })
    ).toBeNull()
    expect(registry.hasIssuedLoopbackGrant(owner)).toBe(false)
  })

  it('arm(false) ends pending requests but preserves an already issued fact for the accepted owner', () => {
    const { registry, owner } = armedRegistry()
    const issuedPending = registry.beginPendingGrant(owner)
    expect(issuedPending).not.toBeNull()
    if (!issuedPending) return
    expect(
      registry.recordGrantCallbackResult(issuedPending, owner, { callbackSucceeded: true, audioGranted: true })
    ).not.toBeNull()
    const latePending = registry.beginPendingGrant(owner)
    expect(latePending).not.toBeNull()
    registry.setArmed(false)
    expect(registry.hasIssuedLoopbackGrant(owner)).toBe(true)
    expect(latePending && registry.isPendingGrantCurrent(latePending, owner)).toBe(false)
  })

  it('normal stop closes new capture admission while preserving only reserved finish owners', () => {
    const { registry, owner } = armedRegistry()
    const pending = registry.beginPendingGrant(owner)
    expect(pending).not.toBeNull()
    if (!pending) return
    registry.recordGrantCallbackResult(pending, owner, { callbackSucceeded: true, audioGranted: true })
    const finishOwner = {}
    expect(registry.reserveFinishingOwner(owner, finishOwner)).toBe(false)
    expect(
      registry.authorizeCapturedTracks({
        context: owner,
        audioSource: 'system',
        capturedTracks: ['system'],
        platform: 'win32',
        microphonePermission: 'unknown',
        screenPermission: 'unknown'
      }).ok
    ).toBe(true)
    expect(registry.reserveFinishingOwner(owner, finishOwner)).toBe(true)
    expect(registry.reserveFinishingOwner(owner, finishOwner)).toBe(true)
    expect(registry.reserveFinishingOwner(owner, {})).toBe(false)
    registry.normalStop(owner)
    expect(registry.hasIssuedLoopbackGrant(owner)).toBe(false)
    expect(registry.canFinish(finishOwner)).toBe(true)
    expect(registry.beginPendingGrant(owner)).toBeNull()
    registry.releaseFinishingOwner(finishOwner)
    expect(registry.canFinish(finishOwner)).toBe(false)
  })

  it('permission revocation, navigation, reentry, and logout clear grant and finish facts', () => {
    const { registry, owner } = armedRegistry()
    const pending = registry.beginPendingGrant(owner)
    expect(pending).not.toBeNull()
    if (!pending) return
    registry.recordGrantCallbackResult(pending, owner, { callbackSucceeded: true, audioGranted: true })
    const finishOwner = {}
    expect(
      registry.authorizeCapturedTracks({
        context: owner,
        audioSource: 'system',
        capturedTracks: ['system'],
        platform: 'win32',
        microphonePermission: 'unknown',
        screenPermission: 'unknown'
      }).ok
    ).toBe(true)
    expect(registry.reserveFinishingOwner(owner, finishOwner)).toBe(true)
    registry.invalidateAll()
    expect(registry.hasIssuedLoopbackGrant(owner)).toBe(false)
    expect(registry.canFinish(finishOwner)).toBe(false)
    expect(registry.getAcceptedListenContext()).toBeNull()
  })

  it('authorizes only actual captured tracks within the requested source and reports honest missing tracks', () => {
    const { registry, owner } = armedRegistry()
    expect(
      registry.authorizeCapturedTracks({
        context: owner,
        audioSource: 'both',
        capturedTracks: ['microphone'],
        platform: 'win32',
        microphonePermission: 'granted',
        screenPermission: 'unknown'
      })
    ).toEqual({ ok: true, tracks: ['microphone'], missingRequested: ['system'] })
    expect(
      registry.authorizeCapturedTracks({
        context: owner,
        audioSource: 'mic',
        capturedTracks: ['system'],
        platform: 'win32',
        microphonePermission: 'granted',
        screenPermission: 'unknown'
      })
    ).toEqual({ ok: false, code: 'TRACK_NOT_REQUESTED' })
  })

  it('requires a matching issued grant for system audio and actual granted microphone permission', () => {
    const { registry, owner } = armedRegistry()
    expect(
      registry.authorizeCapturedTracks({
        context: owner,
        audioSource: 'system',
        capturedTracks: ['system'],
        platform: 'win32',
        microphonePermission: 'unknown',
        screenPermission: 'unknown'
      })
    ).toEqual({ ok: false, code: 'LOOPBACK_GRANT_REQUIRED' })
    const pending = registry.beginPendingGrant(owner)
    expect(pending).not.toBeNull()
    if (!pending) return
    registry.recordGrantCallbackResult(pending, owner, { callbackSucceeded: true, audioGranted: true })
    expect(
      registry.authorizeCapturedTracks({
        context: owner,
        audioSource: 'system',
        capturedTracks: ['system'],
        platform: 'win32',
        microphonePermission: 'unknown',
        screenPermission: 'denied'
      })
    ).toEqual({ ok: true, tracks: ['system'], missingRequested: [] })
    expect(
      registry.authorizeCapturedTracks({
        context: owner,
        audioSource: 'mic',
        capturedTracks: ['microphone'],
        platform: 'darwin',
        microphonePermission: 'unknown',
        screenPermission: 'not-required'
      })
    ).toEqual({ ok: false, code: 'PERMISSION_DENIED' })
  })

  it('requires current macOS screen diagnosis for loopback and rejects empty, duplicate, or invalid track sets', () => {
    const { registry, owner } = armedRegistry()
    const pending = registry.beginPendingGrant(owner)
    expect(pending).not.toBeNull()
    if (!pending) return
    registry.recordGrantCallbackResult(pending, owner, { callbackSucceeded: true, audioGranted: true })
    expect(
      registry.authorizeCapturedTracks({
        context: owner,
        audioSource: 'system',
        capturedTracks: ['system'],
        platform: 'darwin',
        microphonePermission: 'unknown',
        screenPermission: 'denied',
        screenDiagnosis: 'denied'
      })
    ).toEqual({ ok: false, code: 'PERMISSION_DENIED' })
    expect(
      registry.authorizeCapturedTracks({
        context: owner,
        audioSource: 'system',
        capturedTracks: ['system'],
        platform: 'darwin',
        microphonePermission: 'unknown',
        screenPermission: 'granted',
        screenDiagnosis: 'denied'
      })
    ).toEqual({ ok: false, code: 'PERMISSION_DENIED' })
    for (const capturedTracks of [[], ['microphone', 'microphone'], ['loopback']]) {
      expect(
        registry.authorizeCapturedTracks({
          context: owner,
          audioSource: 'both',
          capturedTracks,
          platform: 'win32',
          microphonePermission: 'granted',
          screenPermission: 'unknown'
        })
      ).toMatchObject({ ok: false })
    }
  })
})
