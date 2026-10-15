import type { TranscriptLine } from '@shared/transcript-line'
import type { SpeechDecoded, SpeechProvenanceLimits } from '@shared/meeting-speech-contract'
import type { CanonicalIncrementalRecord } from '@shared/incremental-meeting'

export interface MeetingSpeechPolicy {
  limits: SpeechProvenanceLimits
  maxInputBytes: number
  maxOutputBytes: number
  operationDeadlineMs: number
  shutdownDeadlineMs: number
}

export type MeetingSpeechOperation =
  | 'render'
  | 'decode'
  | 'rewrite'
  | 'project'
  | 'canonical-record'
  | 'encrypt-v2'
  | 'decrypt-v2'
  | 'rewrap-v2'

export interface MeetingSpeechRequest {
  readonly protocol: 1
  readonly id: number
  readonly generation: number
  readonly operation: MeetingSpeechOperation
  readonly policy: MeetingSpeechPolicy
  readonly input:
    | string
    | TranscriptLine[]
    | { recordJson: Uint8Array }
    | { text: string; lines: TranscriptLine[] }
    | { content: string; contentKey: Uint8Array; iv: Uint8Array; kLocal: string; kEscrow?: string }
    | { envelopeJson: Uint8Array; contentKey: Uint8Array; kLocal: string }
    | { envelopeJson: Uint8Array; kLocal: string }
}

export type MeetingSpeechResult =
  | { ok: true; value: string | null | Uint8Array | SpeechDecoded | CanonicalIncrementalRecord }
  | { ok: false; code: 'INVALID_REQUEST' | 'RESOURCE_LIMIT' | 'CODEC_FAILURE' }

export interface MeetingSpeechReply {
  readonly protocol: 1
  readonly id: number
  readonly generation: number
  readonly result: MeetingSpeechResult
  /** Monotonic worker-thread execution time; reports contain no request or content data. */
  readonly workerDurationMs?: number
}

export type MeetingSpeechFailureCode = 'UNCONFIGURED' | 'RESOURCE_LIMIT' | 'QUEUE_FULL' | 'CANCELLED' | 'WORKER_FAILED'

export function isMeetingSpeechReply(value: unknown): value is MeetingSpeechReply {
  if (!value || typeof value !== 'object') return false
  const reply = value as Partial<MeetingSpeechReply>
  if (reply.protocol !== 1 || !Number.isSafeInteger(reply.id) || !Number.isSafeInteger(reply.generation)) return false
  const result = reply.result
  if (
    reply.workerDurationMs !== undefined &&
    (typeof reply.workerDurationMs !== 'number' ||
      !Number.isFinite(reply.workerDurationMs) ||
      reply.workerDurationMs < 0)
  )
    return false
  if (!result || typeof result !== 'object' || typeof result.ok !== 'boolean') return false
  if (result.ok) return Object.keys(result).sort().join(',') === 'ok,value'
  return (
    Object.keys(result).sort().join(',') === 'code,ok' &&
    ['INVALID_REQUEST', 'RESOURCE_LIMIT', 'CODEC_FAILURE'].includes(result.code)
  )
}
