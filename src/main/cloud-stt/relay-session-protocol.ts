import type WebSocket from 'ws'
import type { CreatedSpeechSession, SpeechTrack } from './broker-client'
import type { RelayTrackClosure } from './relay-session-contracts'
import type { RelayTerminal } from './relay-results'

export const MAX_CLOUD_FRAME_BYTES = 3_200
export const MAX_FINISH_WAIT_MS = 5_000
export const MAX_STREAM_MS = 60_000
export const MAX_INPUT_BYTES = 1_920_000
export const MAX_OUTPUT_BYTES = 1024 * 1024
export const FINISH_MESSAGE = '{"type":"finish"}'

export type DeadlineResult<T> = { done: true; value: T } | { done: false }

export type EffectiveRelayLimits = {
  maxStreamMs: number
  audioDeadlineAt: number
  maxInputBytesPerTrack: number
  maxClientFrameBytes: number
  maxOutputBytesPerTrack: number
  drainWindowMs: number
}

export function isValidInitialFrontier(frontier: { sequence: number; sampleOffset?: number } | undefined): boolean {
  return (
    frontier === undefined ||
    (Number.isSafeInteger(frontier.sequence) &&
      frontier.sequence >= 1 &&
      (frontier.sequence === 1 || frontier.sampleOffset !== undefined) &&
      (frontier.sampleOffset === undefined ||
        (Number.isSafeInteger(frontier.sampleOffset) && frontier.sampleOffset >= 0)))
  )
}

export function isSessionCurrent(check?: () => boolean): boolean {
  try {
    return check?.() ?? true
  } catch {
    return false
  }
}

/** Applies the relay's local caps to a broker allocation without extending any server deadline. */
export function effectiveRelayLimits(
  created: CreatedSpeechSession,
  allocationAt: number,
  now: number
): EffectiveRelayLimits | null {
  const effectiveMaxStreamMs = Math.min(created.limits.maxStreamMs, MAX_STREAM_MS)
  const audioDeadlineAt = Math.min(
    created.limits.audioDeadlineAt,
    created.leaseExpiresAt,
    allocationAt + effectiveMaxStreamMs
  )
  if (
    now >= created.grantExpiresAt ||
    now >= audioDeadlineAt ||
    created.limits.maxStreamMs < 100 ||
    created.limits.maxInputBytesPerTrack < MAX_CLOUD_FRAME_BYTES ||
    created.limits.maxClientFrameBytes < MAX_CLOUD_FRAME_BYTES
  )
    return null
  return {
    maxStreamMs: effectiveMaxStreamMs,
    audioDeadlineAt,
    maxInputBytesPerTrack: Math.min(created.limits.maxInputBytesPerTrack, MAX_INPUT_BYTES),
    maxClientFrameBytes: Math.min(created.limits.maxClientFrameBytes, MAX_CLOUD_FRAME_BYTES),
    maxOutputBytesPerTrack: Math.min(created.limits.maxOutputBytesPerTrack, MAX_OUTPUT_BYTES),
    drainWindowMs: Math.min(created.limits.drainWindowMs, MAX_FINISH_WAIT_MS)
  }
}

/** Strictly decodes the provider protocol's text and binary frames as UTF-8. */
export function toUtf8Text(data: WebSocket.RawData): string | null {
  try {
    if (typeof data === 'string') return data
    const decoder = new TextDecoder('utf-8', { fatal: true })
    if (Buffer.isBuffer(data)) return decoder.decode(data)
    if (Array.isArray(data)) return decoder.decode(Buffer.concat(data))
    if (data instanceof ArrayBuffer) return decoder.decode(data)
    return null
  } catch {
    return null
  }
}

export function closureFromTerminal(
  track: SpeechTrack,
  streamEpoch: number,
  terminal: RelayTerminal
): RelayTrackClosure {
  return {
    track,
    streamEpoch,
    closeConfirmed: terminal.closeConfirmed,
    tail: terminal.tail,
    lastSequence: terminal.lastSequence,
    reason: terminal.reason
  }
}

export function incompleteClosure(track: SpeechTrack, streamEpoch: number, lastSequence: number): RelayTrackClosure {
  return {
    track,
    streamEpoch,
    closeConfirmed: false,
    tail: 'incomplete',
    lastSequence,
    reason: 'unknown'
  }
}
