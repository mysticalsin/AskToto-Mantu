import type { IpcMain } from 'electron'
import type { Settings, PlatformPermissions } from '@shared/ipc'
import {
  resolveSpeechBrokerAuthority,
  type ManagedSpeechProviders,
  type SpeechBrokerAuthorityResolution
} from './speech-broker-policy'
import { resolveSpeechPolicyIdentity, type SpeechPolicyIdentitySettings } from './speech-policy-authority'
import { getVerifiedSpeechPolicySnapshot, type VerifiedSpeechPolicy } from './model-policy-client'
import { getNativeSpeechPermissions } from './platform-perms'
import {
  SpeechCaptureGrantRegistry,
  type SpeechCaptureContext,
  type SpeechCaptureSource
} from './capture-permissions/speech-capture-grant'
import {
  registerCloudSpeechIpc,
  type CloudSpeechIpcOptions,
  type CloudSpeechIpcRegistration,
  type CloudSpeechMainAuthority
} from './ipc/cloud-speech-ipc'
import type { SpeechIpcEvent, SpeechIpcMain } from './ipc/cloud-speech-ipc-support'
import type { SpeechBrokerClient, SpeechBrokerClientOptions } from './cloud-stt/broker-client'
import type { CloudSpeechStartRequest } from '@shared/cloud-speech'
import type { CaptureDeadlineScheduler } from './infra/scheduler/capture-deadline'

export const SPEECH_DESKTOP_LANGUAGES = ['multi', 'en', 'fr', 'fr-CA', 'pt-BR', 'es'] as const

export type SpeechDesktopRuntimeState = {
  /** Main-process in-memory settings snapshot only. No synchronous store reads are allowed here. */
  settings: Pick<Settings, 'audioSource' | 'operatorUrl' | 'operatorLicenseToken' | 'brokerSpeech'> | null
  /** Value from the already-loaded durable identity cache; null while its refresh is unresolved. */
  durableDeviceId: string | null
  managedProviders: ManagedSpeechProviders
  egressAllowlist: readonly string[] | null
  metadataReady: boolean
  screenDiagnosisState: string | null
}

export type SpeechDesktopRuntimeOptions = {
  ipcMain: SpeechIpcMain | Pick<IpcMain, 'handle' | 'removeHandler'>
  assertMainWindow: (event: SpeechIpcEvent) => void
  readState: () => SpeechDesktopRuntimeState
  readListenContext: () => SpeechCaptureContext | null
  isListening: () => boolean
  requireAuth: () => boolean
  grants: SpeechCaptureGrantRegistry
  platform: NodeJS.Platform | string
  enabled: () => boolean
  readNativePermissions?: () => Pick<PlatformPermissions, 'microphone' | 'screenRecording'>
  readVerifiedPolicy?: () => VerifiedSpeechPolicy | null
  prepareAuthority?: (event: SpeechIpcEvent, request?: CloudSpeechStartRequest) => Promise<void>
  monotonicNow?: () => number
  scheduleCaptureDeadline?: CaptureDeadlineScheduler
  clientFactory?: (credentials: SpeechBrokerClientOptions) => SpeechBrokerClient
  now?: () => number
  onSegmentDelivered?: CloudSpeechIpcOptions['onSegmentDelivered']
}

export type SpeechDesktopRuntime = CloudSpeechIpcRegistration & {
  registration: CloudSpeechIpcRegistration
  readAuthority: (
    event: SpeechIpcEvent,
    request?: CloudSpeechStartRequest,
    captureOwner?: object
  ) => CloudSpeechMainAuthority
}

type Track = 'microphone' | 'system'
type PermissionSnapshot = Pick<PlatformPermissions, 'microphone' | 'screenRecording'>

function tracksForSource(source: SpeechCaptureSource): Track[] | null {
  if (source === 'mic') return ['microphone']
  if (source === 'system') return ['system']
  if (source === 'both') return ['microphone', 'system']
  return null
}

function sameTracks(left: readonly unknown[], right: readonly Track[]): boolean {
  return left.length === right.length && left.every((track, index) => track === right[index])
}

function sameContext(left: SpeechCaptureContext | null, right: SpeechCaptureContext | null): boolean {
  return (
    left !== null &&
    right !== null &&
    left.webContents === right.webContents &&
    left.frame === right.frame &&
    left.navigationEpoch === right.navigationEpoch &&
    left.listenStartedAt === right.listenStartedAt
  )
}

function currentSpeechIdentity(settings: SpeechPolicyIdentitySettings, durableDeviceId: string | null, now: number) {
  const identity = resolveSpeechPolicyIdentity(settings, durableDeviceId, now)
  if (!identity) return null
  return {
    origin: identity.origin,
    credentialDigest: identity.credentialDigest,
    deviceIdHash: identity.deviceIdHash,
    scopeKey: identity.scopeKey,
    licenseToken: identity.licenseToken
  }
}

function authorityFromResolution(
  state: SpeechDesktopRuntimeState,
  enabled: boolean,
  authenticated: boolean,
  resolution: SpeechBrokerAuthorityResolution | null,
  credential: SpeechBrokerClientOptions | null,
  credentialRevision: string,
  policyRevision: string,
  policyReady: boolean,
  captureAllowed: boolean,
  captureContext: SpeechCaptureContext | null,
  finishAllowed: boolean
): CloudSpeechMainAuthority {
  return {
    enabled,
    authenticated,
    captureAllowed,
    policyReady: state.metadataReady && policyReady && resolution?.ok === true,
    selectedEngine: resolution?.ok ? resolution.engine : null,
    allowedEngines: resolution?.ok ? resolution.allowed.map((pair) => pair.engine) : [],
    allowedLanguages: [...SPEECH_DESKTOP_LANGUAGES],
    credentials: credential,
    credentialRevision,
    policyRevision,
    egressAllowlist: state.egressAllowlist,
    captureContext,
    finishAllowed
  }
}

function nativePermissionsReady(
  tracks: readonly Track[],
  permissions: PermissionSnapshot,
  platform: NodeJS.Platform | string,
  screenDiagnosisState: string | null
): boolean {
  if (
    tracks.includes('microphone') &&
    permissions.microphone !== 'granted' &&
    permissions.microphone !== 'not-required'
  )
    return false
  if (!tracks.includes('system')) return true
  if (platform === 'darwin') return permissions.screenRecording === 'granted' && screenDiagnosisState === 'granted'
  if (platform === 'win32') return true
  return permissions.screenRecording === 'granted'
}

function failedAuthority(enabled: boolean, authenticated: boolean): CloudSpeechMainAuthority {
  return {
    enabled,
    authenticated,
    captureAllowed: false,
    policyReady: false,
    selectedEngine: null,
    allowedEngines: [],
    allowedLanguages: [...SPEECH_DESKTOP_LANGUAGES],
    credentials: null,
    credentialRevision: '',
    policyRevision: '',
    egressAllowlist: []
  }
}

/**
 * Main-only composition of cached identity/policy, current native permissions, and an owned Listen grant.
 * The built-in identity and policy resolution uses in-memory snapshots. The injected legacy authorization guard may still perform its existing reads.
 */
export function createSpeechDesktopRuntime(options: SpeechDesktopRuntimeOptions): SpeechDesktopRuntime {
  const now = options.now ?? Date.now
  const readNative = options.readNativePermissions ?? getNativeSpeechPermissions
  const readPolicy = options.readVerifiedPolicy ?? getVerifiedSpeechPolicySnapshot

  const readAuthority = (
    event: SpeechIpcEvent,
    request?: CloudSpeechStartRequest,
    captureOwner?: object
  ): CloudSpeechMainAuthority => {
    let enabled = false
    let authenticated = false
    try {
      enabled = options.enabled()
      authenticated = options.requireAuth()
      const state = options.readState()
      const currentTime = now()
      const native = readNative()
      const source = state.settings?.audioSource
      const selectedTracks = source ? tracksForSource(source) : null
      const captureTracks = request?.capture.capturedTracks ?? selectedTracks ?? []
      const permissionsReady =
        state.metadataReady &&
        !!selectedTracks &&
        captureTracks.length > 0 &&
        nativePermissionsReady(captureTracks, native, options.platform, state.screenDiagnosisState)
      const identity = state.settings
        ? currentSpeechIdentity(
            {
              operatorUrl: state.settings.operatorUrl,
              operatorLicenseToken: state.settings.operatorLicenseToken
            },
            state.durableDeviceId,
            currentTime
          )
        : null
      const snapshot = state.metadataReady ? readPolicy() : null
      const resolution =
        state.settings && state.metadataReady && identity
          ? resolveSpeechBrokerAuthority({
              profile: state.settings.brokerSpeech,
              snapshot,
              currentIdentity: identity,
              managedProviders: state.managedProviders,
              now: currentTime
            })
          : null
      const credential =
        state.settings && identity && state.metadataReady
          ? {
              operatorUrl: identity.origin,
              operatorLicenseToken: identity.licenseToken,
              deviceIdHash: identity.deviceIdHash
            }
          : null
      let captureAllowed = false
      let authorizedCaptureContext: SpeechCaptureContext | null = null
      if (
        request &&
        enabled &&
        authenticated &&
        resolution?.ok === true &&
        state.settings &&
        request.capture.engine === resolution.engine
      ) {
        const expectedRequestedTracks = tracksForSource(state.settings.audioSource)
        const context = options.readListenContext()
        const accepted = options.grants.getAcceptedListenContext()
        const contextMatchesEvent =
          context?.webContents === event.sender && context.frame === event.senderFrame && sameContext(context, accepted)
        const listening = options.isListening()
        if (
          expectedRequestedTracks &&
          sameTracks(request.capture.requestedTracks, expectedRequestedTracks) &&
          contextMatchesEvent &&
          listening
        ) {
          const admission = options.grants.authorizeCapturedTracks({
            context,
            audioSource: state.settings.audioSource,
            capturedTracks: request.capture.capturedTracks,
            platform: options.platform,
            microphonePermission: native.microphone,
            screenPermission: native.screenRecording,
            screenDiagnosis: state.screenDiagnosisState ?? undefined
          })
          captureAllowed = admission.ok && permissionsReady
          if (captureAllowed && captureOwner)
            captureAllowed = options.grants.reserveFinishingOwner(context!, captureOwner)
          if (captureAllowed) authorizedCaptureContext = context
        }
      }
      const finishingContext = captureOwner ? options.grants.getFinishingOwnerContext(captureOwner) : null
      return authorityFromResolution(
        state,
        enabled,
        authenticated,
        resolution,
        credential,
        identity?.scopeKey ?? '',
        snapshot?.revision ?? '',
        state.metadataReady && snapshot !== null && resolution?.ok === true,
        captureAllowed,
        authorizedCaptureContext ?? finishingContext,
        !!captureOwner && options.grants.canFinish(captureOwner)
      )
    } catch {
      return failedAuthority(enabled, authenticated)
    }
  }

  const registration = registerCloudSpeechIpc({
    ipcMain: options.ipcMain,
    assertMainWindow: options.assertMainWindow,
    readAuthority,
    releaseCaptureOwner: (captureOwner) => options.grants.releaseFinishingOwner(captureOwner),
    ...(options.prepareAuthority ? { prepareAuthority: options.prepareAuthority } : {}),
    ...(options.monotonicNow ? { monotonicNow: options.monotonicNow } : {}),
    ...(options.scheduleCaptureDeadline ? { scheduleCaptureDeadline: options.scheduleCaptureDeadline } : {}),
    ...(options.clientFactory ? { clientFactory: options.clientFactory } : {}),
    ...(options.onSegmentDelivered ? { onSegmentDelivered: options.onSegmentDelivered } : {}),
    now
  })
  return { ...registration, registration, readAuthority }
}
