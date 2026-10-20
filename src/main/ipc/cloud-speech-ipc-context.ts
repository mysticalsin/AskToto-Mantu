import type { Authority, CloudSpeechIpcOptions, Owner, SpeechIpcEvent } from './cloud-speech-ipc-support'
import type { CaptureDeadlineScheduler } from '../infra/scheduler/capture-deadline'
import type { RelayTrackClosure } from '../cloud-stt/relay-session'
import type { CloudSpeechFailure } from '../../shared/cloud-speech'

export type LanguageChangeResult =
  | { ok: true; language: string; changed: boolean }
  | { ok: false; code: CloudSpeechFailure['code'] }

export type CaptureIdentity = { captureId: string; captureGeneration: number }

export type CloudSpeechIpcState = {
  current: Owner | null
  readonly owners: Map<string, Owner>
  acceptingInput: boolean
  shuttingDown: boolean
  authorityPreparationGeneration: number
  capabilityPreparationGeneration: number
  disposed: boolean
}

export type CaptureLifecycleContext = {
  readonly state: Readonly<Pick<CloudSpeechIpcState, 'current'>>
  readonly now: () => number
  readonly monotonicNow: () => number
  readonly schedule: CaptureDeadlineScheduler
  readonly prepareAuthority?: CloudSpeechIpcOptions['prepareAuthority']
  readonly onDelivered?: CloudSpeechIpcOptions['onSegmentDelivered']
  readonly currentAuthority: (owner: Owner, requireCapture: boolean) => Authority | null
  readonly retire: (owner: Owner) => Promise<'confirmed' | 'unknown'>
}

export type CaptureLifecycle = {
  sendEvent: (owner: Owner, value: unknown) => boolean
  makeRelayTranscript: (
    owner: Owner,
    transcript: Parameters<
      NonNullable<import('../cloud-stt/relay-session').RelaySpeechSessionOptions['onTranscript']>
    >[0],
    context: Parameters<NonNullable<import('../cloud-stt/relay-session').RelaySpeechSessionOptions['onTranscript']>>[1]
  ) => void
  setTerminal: (owner: Owner, tracks: RelayTrackClosure[]) => void
  armRotation: (owner: Owner) => void
  rotate: (owner: Owner) => Promise<void>
  failRotation: (owner: Owner) => void
  changeLanguage: (owner: Owner, requested: string) => Promise<LanguageChangeResult>
  startCaptureCeiling: (owner: Owner) => void
  armCaptureCeiling: (owner: Owner) => void
}

export type CaptureHandlersContext = {
  readonly state: Readonly<Pick<CloudSpeechIpcState, 'current' | 'acceptingInput'>>
  readonly now: () => number
  readonly monotonicNow: () => number
  readonly assertMainWindow: CloudSpeechIpcOptions['assertMainWindow']
  readonly ownerFor: (identity: CaptureIdentity) => Owner | null
  readonly currentAuthority: (owner: Owner, requireCapture: boolean) => Authority | null
  readonly retire: (owner: Owner) => Promise<'confirmed' | 'unknown'>
  readonly clearCurrentIf: (owner: Owner) => void
  readonly releaseCaptureOwner: (owner: Owner) => void
  readonly lifecycle: CaptureLifecycle
}

export type CaptureIpcHandlers = {
  frame: (event: SpeechIpcEvent, raw: unknown) => Promise<unknown>
  transitionAck: (event: SpeechIpcEvent, raw: unknown) => unknown
  finishCapture: (event: SpeechIpcEvent, raw: unknown) => Promise<unknown>
  ceilingAck: (event: SpeechIpcEvent, raw: unknown) => Promise<unknown>
  changeLanguage: (event: SpeechIpcEvent, raw: unknown) => Promise<unknown>
}
