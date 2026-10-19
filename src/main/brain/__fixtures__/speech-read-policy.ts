import type { SpeechProvenanceLimits } from '@shared/meeting-speech-contract'
import { configureMeetingSpeechLimits, getMeetingSpeechLimits } from '../../features/meetings/meeting-speech'

/** Test-only bounds for synthetic meeting inputs; production policy remains main-owned. */
export const TEST_SPEECH_READ_LIMITS: Readonly<SpeechProvenanceLimits> = Object.freeze({
  maxRecords: 100,
  maxWords: 1000,
  maxFieldBytes: 10000,
  maxRecordBytes: 50000,
  maxPayloadBytes: 1000000
})

/** Installs a bounded test policy and returns a restoration for the exact prior policy state. */
export function installSpeechReadPolicy(
  limits: Readonly<SpeechProvenanceLimits> = TEST_SPEECH_READ_LIMITS
): () => void {
  const previous = getMeetingSpeechLimits()
  configureMeetingSpeechLimits({ ...limits })
  return () => configureMeetingSpeechLimits(previous ? { ...previous } : undefined)
}
