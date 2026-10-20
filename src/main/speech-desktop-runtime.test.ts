import { beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyModelPolicyEntry, MODEL_POLICY_CAPABILITIES, type ModelPolicyDocument } from '@shared/model-policy'
import type { Settings } from '@shared/ipc'
import { SpeechCaptureGrantRegistry, type SpeechCaptureContext } from './capture-permissions/speech-capture-grant'
import { resolveSpeechPolicyIdentity } from './speech-policy-authority'
import type { VerifiedSpeechPolicy } from './model-policy-client'
import { createSpeechDesktopRuntime, type SpeechDesktopRuntimeState } from './speech-desktop-runtime'
import { authorityRevision } from './ipc/cloud-speech-ipc-support'
import { CLOUD_SPEECH_IPC } from '@shared/cloud-speech'

vi.mock('./model-policy-client', () => ({ getVerifiedSpeechPolicySnapshot: () => null }))
vi.mock('./platform-perms', () => ({
  getNativeSpeechPermissions: () => ({ microphone: 'unknown', screenRecording: 'unknown' })
}))

const NOW = 1_900_000_000_000
const DEVICE_ID = 'durable-speech-device'
const operatorLicenseToken = `METIS-OP-1.0123456789abcdef.${Math.floor(NOW / 1000) - 10}.${Math.floor(NOW / 1000) + 3_600}.AAAAAAAAAAAAAAAAAAAA`
const speaker = { id: 'sender' }
const frame = { id: 'main-frame' }
const context: SpeechCaptureContext = {
  webContents: speaker,
  frame,
  navigationEpoch: 3,
  listenStartedAt: 1_899_999_999_000
}

function speechPolicy(): ModelPolicyDocument {
  const stt = emptyModelPolicyEntry('deepgram-nova3', 'nova-3')
  const capabilities = Object.fromEntries(
    MODEL_POLICY_CAPABILITIES.map((key) => [key, stt])
  ) as ModelPolicyDocument['capabilities']
  return { version: 8, updatedAt: NOW - 1_000, updatedBy: 'runtime-fixture', localSpeechPack: 'offered', capabilities }
}

function verifiedPolicy(): VerifiedSpeechPolicy {
  const identity = resolveSpeechPolicyIdentity(
    { operatorUrl: 'https://operator.test', operatorLicenseToken },
    DEVICE_ID,
    NOW
  )!
  return {
    origin: identity.origin,
    credentialDigest: identity.credentialDigest,
    deviceIdHash: identity.deviceIdHash,
    verifiedAt: NOW - 1_000,
    revision: 'speech-policy-r8',
    policy: speechPolicy()
  }
}

function settings(audioSource: 'mic' | 'system' | 'both' = 'mic'): Settings {
  return {
    audioSource,
    brokerSpeech: { transport: 'broker-v1', engine: 'deepgram-nova3' },
    operatorUrl: 'https://operator.test',
    operatorIngestSecret: 'fleet-secret-is-not-the-seat-credential',
    operatorLicenseToken
  } as Settings
}

function startRequest(
  requestedTracks: Array<'microphone' | 'system'> = ['microphone'],
  capturedTracks: Array<'microphone' | 'system'> = ['microphone']
) {
  return {
    captureId: '8a8e4491-fdb5-4e68-b172-8ea96b435104',
    capture: {
      generation: 4,
      engine: 'deepgram-nova3' as const,
      requestedTracks,
      capturedTracks
    },
    language: 'en',
    consent: { accepted: true as const, disclosureVersion: 'cloud-speech-v1' as const }
  }
}

function makeHarness(
  overrides: {
    state?: Partial<SpeechDesktopRuntimeState>
    auth?: boolean
    listening?: boolean
    native?: {
      microphone: 'granted' | 'denied' | 'unknown' | 'not-required'
      screenRecording: 'granted' | 'denied' | 'unknown' | 'not-required'
    }
    platform?: NodeJS.Platform | string
  } = {}
) {
  const grants = new SpeechCaptureGrantRegistry()
  grants.acceptListenContext(context)
  const current = {
    state: {
      settings: settings(),
      durableDeviceId: DEVICE_ID,
      managedProviders: { state: 'absent' as const },
      egressAllowlist: ['operator.test'],
      metadataReady: true,
      screenDiagnosisState: 'unknown',
      ...overrides.state
    } satisfies SpeechDesktopRuntimeState,
    authenticated: overrides.auth ?? true,
    listening: overrides.listening ?? true,
    native: overrides.native ?? { microphone: 'granted' as const, screenRecording: 'unknown' as const }
  }
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const ipcMain = {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler)),
    removeHandler: vi.fn((channel: string) => handlers.delete(channel))
  }
  const stateReader = vi.fn(() => current.state)
  const policyReader = vi.fn(() => verifiedPolicy())
  const nativeReader = vi.fn(() => current.native)
  const runtime = createSpeechDesktopRuntime({
    ipcMain: ipcMain as never,
    assertMainWindow: vi.fn(),
    readState: stateReader,
    readListenContext: () => grants.getAcceptedListenContext(),
    isListening: () => current.listening,
    requireAuth: () => current.authenticated,
    grants,
    platform: overrides.platform ?? 'darwin',
    enabled: () => true,
    readNativePermissions: nativeReader,
    readVerifiedPolicy: policyReader,
    now: () => NOW
  })
  return { current, grants, handlers, ipcMain, stateReader, policyReader, nativeReader, runtime }
}

const invokeEvent = { sender: speaker, senderFrame: frame } as never

describe('speech desktop runtime authority composition', () => {
  beforeEach(() => vi.clearAllMocks())

  it('registers the actual IPC adapter and resolves exact signed-policy route authority from cached inputs', () => {
    const h = makeHarness()
    expect(h.ipcMain.handle).toHaveBeenCalled()
    // Every invoke channel; `event` is a main-to-renderer push and is never handled.
    expect([...h.handlers.keys()].sort()).toEqual(
      Object.entries(CLOUD_SPEECH_IPC)
        .filter(([key]) => key !== 'event')
        .map(([, channel]) => channel)
        .sort()
    )
    expect(h.handlers.size).toBe(9)
    const authority = h.runtime.readAuthority(invokeEvent, startRequest())
    expect(authority).toMatchObject({
      enabled: true,
      authenticated: true,
      captureAllowed: true,
      policyReady: true,
      selectedEngine: 'deepgram-nova3',
      allowedEngines: ['deepgram-nova3'],
      allowedLanguages: ['multi', 'en', 'fr', 'fr-CA', 'pt-BR', 'es'],
      credentials: {
        operatorUrl: 'https://operator.test',
        operatorLicenseToken,
        deviceIdHash: expect.any(String)
      }
    })
    expect(authority.policyRevision).toBe('speech-policy-r8')
    expect(authority.credentialRevision).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify(authority)).not.toContain('fleet-secret-is-not-the-seat-credential')
    expect(h.stateReader).toHaveBeenCalled()
    expect(h.policyReader).toHaveBeenCalled()
  })

  it('keeps service capability available before native capture permission while Start still requires permission', () => {
    const h = makeHarness({
      native: { microphone: 'unknown', screenRecording: 'unknown' }
    })
    const capability = h.runtime.readAuthority(invokeEvent)
    expect(capability).toMatchObject({ policyReady: true, captureAllowed: false })
    const start = h.runtime.readAuthority(invokeEvent, startRequest())
    expect(start).toMatchObject({ policyReady: true, captureAllowed: false })
  })

  it('binds finishing authority to the original exact Listen context and denies a newer owner', () => {
    const h = makeHarness()
    const owner = {}
    const accepted = h.runtime.readAuthority(invokeEvent, startRequest(), owner)
    expect(accepted).toMatchObject({
      captureAllowed: true,
      finishAllowed: true,
      captureContext: {
        navigationEpoch: context.navigationEpoch,
        listenStartedAt: context.listenStartedAt
      }
    })

    expect(h.grants.normalStop(context)).toBe(true)
    const normalStop = h.runtime.readAuthority(invokeEvent, startRequest(), owner)
    expect(normalStop).toMatchObject({
      captureAllowed: false,
      finishAllowed: true,
      captureContext: {
        navigationEpoch: context.navigationEpoch,
        listenStartedAt: context.listenStartedAt
      }
    })

    const nextContext = { ...context, listenStartedAt: context.listenStartedAt + 1 }
    expect(h.grants.acceptListenContext(nextContext)).toBe(true)
    const newerOwner = h.runtime.readAuthority(invokeEvent, startRequest(), owner)
    expect(newerOwner).toMatchObject({ captureAllowed: true, finishAllowed: true })
    expect(newerOwner.captureContext?.listenStartedAt).toBe(nextContext.listenStartedAt)
    expect(newerOwner.captureContext?.listenStartedAt).not.toBe(accepted.captureContext?.listenStartedAt)
  })

  it('fails closed while durable identity metadata is still loading and avoids stale policy reads', () => {
    const h = makeHarness({ state: { metadataReady: false, durableDeviceId: null } })
    const authority = h.runtime.readAuthority(invokeEvent, startRequest())
    expect(authority).toMatchObject({
      policyReady: false,
      captureAllowed: false,
      selectedEngine: null,
      credentials: null
    })
    expect(h.policyReader).not.toHaveBeenCalled()
    expect(h.nativeReader).toHaveBeenCalledTimes(1)
  })

  it('keeps normal final draining policy-ready after Listen stops while closing new capture admission', () => {
    const h = makeHarness({ listening: false })
    const authority = h.runtime.readAuthority(invokeEvent, startRequest())
    expect(authority.policyReady).toBe(true)
    expect(authority.captureAllowed).toBe(false)
  })

  it('keeps the policy revision stable when the same verified policy snapshot is refreshed', () => {
    const h = makeHarness()
    const before = h.runtime.readAuthority(invokeEvent)
    h.policyReader.mockReturnValue({ ...verifiedPolicy(), verifiedAt: NOW })
    const after = h.runtime.readAuthority(invokeEvent)
    expect(after.policyRevision).toBe(before.policyRevision)
    expect(authorityRevision(after)).toBe(authorityRevision(before))
    expect(after.policyRevision).toBe('speech-policy-r8')
  })

  it('requires the main auth gate and does not admit a capture when it refuses', () => {
    const h = makeHarness({ auth: false })
    const authority = h.runtime.readAuthority(invokeEvent, startRequest())
    expect(authority.authenticated).toBe(false)
    expect(authority.captureAllowed).toBe(false)
    expect(authority.policyReady).toBe(true)
  })

  it('requires exact Settings.audioSource tracks and an actual microphone permission', () => {
    const mismatch = makeHarness()
    const authorize = vi.spyOn(mismatch.grants, 'authorizeCapturedTracks')
    expect(mismatch.runtime.readAuthority(invokeEvent, startRequest(['system'], ['microphone'])).captureAllowed).toBe(
      false
    )
    expect(authorize).not.toHaveBeenCalled()

    const denied = makeHarness({ native: { microphone: 'denied', screenRecording: 'unknown' } })
    expect(denied.runtime.readAuthority(invokeEvent, startRequest()).captureAllowed).toBe(false)
    expect(denied.runtime.readAuthority(invokeEvent, startRequest()).policyReady).toBe(true)
  })

  it('requires current accepted WebContents/frame ownership and an active Listen for admission', () => {
    const h = makeHarness()
    const otherEvent = { sender: { id: 'other' }, senderFrame: frame } as never
    expect(h.runtime.readAuthority(otherEvent, startRequest()).captureAllowed).toBe(false)
    h.current.listening = false
    expect(h.runtime.readAuthority(invokeEvent, startRequest()).captureAllowed).toBe(false)
  })

  it('requires macOS screen TCC and cached diagnosis in addition to an issued loopback grant', () => {
    const state = { settings: settings('system') }
    const h = makeHarness({
      state,
      native: { microphone: 'unknown', screenRecording: 'granted' }
    })
    h.grants.setArmed(true)
    const token = h.grants.beginPendingGrant(context)
    expect(token).not.toBeNull()
    expect(h.grants.recordGrantCallbackResult(token!, context, { callbackSucceeded: true, audioGranted: true })).toBe(
      true
    )
    h.current.state.screenDiagnosisState = null
    expect(h.runtime.readAuthority(invokeEvent, startRequest(['system'], ['system']))).toMatchObject({
      policyReady: true,
      captureAllowed: false
    })
    h.current.state.screenDiagnosisState = 'granted'
    expect(h.runtime.readAuthority(invokeEvent, startRequest(['system'], ['system']))).toMatchObject({
      policyReady: true,
      captureAllowed: true
    })
  })

  it('requires a real loopback grant for Windows system audio despite the unavailable static screen status', () => {
    const h = makeHarness({
      state: { settings: settings('system') },
      native: { microphone: 'unknown', screenRecording: 'unknown' },
      platform: 'win32'
    })
    expect(h.runtime.readAuthority(invokeEvent, startRequest(['system'], ['system'])).captureAllowed).toBe(false)
    h.grants.setArmed(true)
    const token = h.grants.beginPendingGrant(context)
    expect(h.grants.recordGrantCallbackResult(token!, context, { callbackSucceeded: true, audioGranted: true })).toBe(
      true
    )
    expect(h.runtime.readAuthority(invokeEvent, startRequest(['system'], ['system']))).toMatchObject({
      policyReady: true,
      captureAllowed: true
    })
  })

  it('fails closed on malformed cached input without throwing through the IPC registration', () => {
    const h = makeHarness()
    h.current.state = { ...h.current.state, managedProviders: { state: 'invalid' } }
    expect(h.runtime.readAuthority(invokeEvent, startRequest())).toMatchObject({
      policyReady: false,
      captureAllowed: false,
      selectedEngine: null
    })
  })
})
