import type { SpeechProvenanceLimits } from '@shared/meeting-speech-contract'
import type { MeetingSpeechServiceBounds } from '../../infra/process/meeting-speech-host'
import { configureMeetingSpeechLimits, configureMeetingSpeechReadLimitBytes } from './meeting-speech'

/**
 * The trusted, main-owned speech metadata budget and worker bounds. Approved by the owner 2026-10-21 (Métis 2.12,
 * C09b design section 2); no renderer setting or IPC can change them. Sized from the declared 4 h two-track
 * workload (5,760 finals, 69,120 words, ~11 MB of provenance) with headroom, never guessed per request.
 */
export const MEETING_SPEECH_LIMITS: Readonly<SpeechProvenanceLimits> = Object.freeze({
  /** 2.1x the 4 h workload (5,760 finals). */
  maxRecords: 12_000,
  /** 2.2x the 4 h workload (69,120 words). */
  maxWords: 150_000,
  /** 8,192 characters x 4 bytes UTF-8: a schema-valid segment can never trip it. */
  maxFieldBytes: 32_768,
  /** One provenance record; deliberately generous because an over-cap line refuses the whole save. */
  maxRecordBytes: 131_072,
  /** Whole-meeting provenance payload (64 MiB). */
  maxPayloadBytes: 67_108_864
})

export const MEETING_SPEECH_WORKER_BOUNDS: Readonly<MeetingSpeechServiceBounds> = Object.freeze({
  /** Also the physical cap on any saved meeting file read (128 MiB). */
  maxInputBytes: 134_217_728,
  maxOutputBytes: 134_217_728,
  operationDeadlineMs: 60_000,
  shutdownDeadlineMs: 5_000
})

/** Throws when the shipped numbers contradict each other; a broken policy must fail at boot, not at first save. */
export function validateMeetingSpeechPolicy(
  limits: Readonly<SpeechProvenanceLimits> = MEETING_SPEECH_LIMITS,
  bounds: Readonly<MeetingSpeechServiceBounds> = MEETING_SPEECH_WORKER_BOUNDS
): void {
  const values = [...Object.values(limits), ...Object.values(bounds)]
  if (
    Object.keys(limits).length !== 5 ||
    Object.keys(bounds).length !== 4 ||
    values.some((value) => !Number.isSafeInteger(value) || value <= 0) ||
    limits.maxFieldBytes > limits.maxRecordBytes ||
    limits.maxRecordBytes > limits.maxPayloadBytes ||
    limits.maxPayloadBytes > bounds.maxInputBytes ||
    limits.maxPayloadBytes > bounds.maxOutputBytes ||
    bounds.operationDeadlineMs < bounds.shutdownDeadlineMs
  )
    throw new Error('Meeting speech policy is inconsistent.')
}

/**
 * Installs the trusted budget and the saved-file read cap. Without it a speech-bearing save, draft or read refuses
 * (fail closed). Idempotent: re-installing the same frozen constants changes nothing. Whether the worker thread is
 * used is a separate decision (`meeting-speech-persistence-wiring.ts`); the policy applies either way.
 */
export function installMeetingSpeechPolicy(): void {
  validateMeetingSpeechPolicy()
  configureMeetingSpeechLimits(MEETING_SPEECH_LIMITS)
  configureMeetingSpeechReadLimitBytes(MEETING_SPEECH_WORKER_BOUNDS.maxInputBytes)
}
