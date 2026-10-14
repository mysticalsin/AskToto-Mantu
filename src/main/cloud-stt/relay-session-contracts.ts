import type WebSocket from 'ws'
import type {
  BrokerFailureCode,
  CreatedSpeechSession,
  SpeechBrokerOperation,
  SpeechCreateRequest,
  SpeechTrack
} from './broker-client'
import type { BoundedRelayPcmQueue } from './relay-queue'
import type { RelayResultSequence, RelayTerminal, RelayTranscript } from './relay-results'

export type RelayTrackClosure = {
  track: SpeechTrack
  streamEpoch: number
  closeConfirmed: boolean
  tail: 'complete' | 'incomplete'
  lastSequence: number
  reason: RelayTerminal['reason']
}

export type RelaySessionFinish = {
  complete: boolean
  tracks: RelayTrackClosure[]
  reason: 'normal' | 'incomplete' | 'cancelled'
}

export type RelaySessionFailureCode =
  | BrokerFailureCode
  | 'TRACK_OPEN'
  | 'CANCELLED'
  | 'LEASE_DRAINING'
  | 'CLOSURE_UNCONFIRMED'

export type RelaySpeechSessionOptions = {
  client: import('./broker-client').SpeechBrokerClient
  createRequest: SpeechCreateRequest
  expectedSelection: {
    routeId: CreatedSpeechSession['routeId']
    modelId: CreatedSpeechSession['model']
    language: string
  }
  expectedCapability: {
    configVersion: string
    policyVersion: string
  }
  operation?: SpeechBrokerOperation
  expectedContinuation?: {
    configVersion: string
    policyVersion: string
    epochs: Partial<Record<SpeechTrack, number>>
  }
  onAllocated?: (sessionId: string) => void
  initialFrontiers?: Partial<Record<SpeechTrack, { sequence: number; sampleOffset?: number }>>
  isCurrent?: () => boolean
  onTranscript?: (
    event: RelayTranscript,
    context: { timeBase: 'stream'; firstCaptureSampleOffset: number; sessionId: string }
  ) => void
}

/** Per-track mutable state kept private to the session implementation. */
export type RelayTrackRuntime = {
  track: SpeechTrack
  streamEpoch: number
  socket: WebSocket
  queue: BoundedRelayPcmQueue
  results: RelayResultSequence
  maxInputBytes: number
  maxStreamInputBytes: number
  admittedBytes: number
  firstCaptureSampleOffset: number | null
  captureNextSequence: number
  captureNextSampleOffset: number | null
  streamNextSequence: number
  streamNextSampleOffset: number
  terminal: RelayTerminal | null
  closure: Promise<RelayTrackClosure>
  resolveClosure: (value: RelayTrackClosure) => void
  finishPromise: Promise<RelayTrackClosure> | null
  failureReason: RelayTerminal['reason'] | null
  deliveryFailed: boolean
  terminalUnexpected: boolean
  stopped: boolean
}
