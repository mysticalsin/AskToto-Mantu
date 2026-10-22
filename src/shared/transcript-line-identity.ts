import type { CloudSpeechEvent } from './cloud-speech'
import type { SpeechStreamRef } from './contracts/speech'
import type { TranscriptLedgerEvent, TranscriptLedgerScope } from './kernel/transcript-ledger'

/**
 * Stable utterance identity for transcript lines (Métis 2.12 G03, CAP-03).
 *
 * `utteranceId` and `revision` are additive and optional on a line, so every meeting saved before they existed and
 * every journal record written before them parses and re-encodes byte for byte unchanged. A cloud-final line derives
 * both from the provider segment it carries (the stream, its epoch, the segment index and the segment revision), so
 * the identity is the same on every path that sees the line: live commit, journal record, recovered draft.
 */

type SegmentEvent = Extract<CloudSpeechEvent, { type: 'segment' }>

export interface LineUtteranceIdentity {
  utteranceId: string
  revision: number
}

/** One ledger stream per capture generation and track; the stream epoch is the transport connection within it. */
export const cloudLedgerStreamId = (stream: SpeechStreamRef): string => `${stream.generation}:${stream.track}`

/** Unique within a meeting: generation, track, epoch and segment index (the same string the live commit keys by). */
export const cloudUtteranceId = (stream: SpeechStreamRef, index: number): string =>
  `${stream.generation}:${stream.track}:${stream.epoch}:${index}`

export function lineIdentityFromSpeech(speech: SegmentEvent): LineUtteranceIdentity {
  return {
    utteranceId: cloudUtteranceId(speech.segment.stream, speech.segment.index),
    revision: speech.segment.revision
  }
}

/** True when a line's identity fields are both present or both absent, and agree with the segment it carries. */
export function lineIdentityIsConsistent(line: {
  utteranceId?: string
  revision?: number
  speech?: SegmentEvent
}): boolean {
  if ((line.utteranceId === undefined) !== (line.revision === undefined)) return false
  if (line.utteranceId === undefined || !line.speech) return true
  const derived = lineIdentityFromSpeech(line.speech)
  return line.utteranceId === derived.utteranceId && line.revision === derived.revision
}

/**
 * Maps one delivered provider segment to a ledger event (the adapter the main-owned ledger consumes in G13). The
 * event id is unique per capture, track, epoch and sequence, so a replayed delivery is an exact duplicate.
 */
export function speechSegmentToLedgerEvent(event: SegmentEvent, scope: TranscriptLedgerScope): TranscriptLedgerEvent {
  const { segment } = event
  const mic = segment.stream.track === 'microphone'
  return {
    eventId: `${event.captureId}:${segment.stream.track}:${segment.stream.epoch}:${event.sequence}`,
    scope,
    streamId: cloudLedgerStreamId(segment.stream),
    streamEpoch: segment.stream.epoch,
    utteranceId: cloudUtteranceId(segment.stream, segment.index),
    revision: segment.revision,
    state: segment.final ? 'final' : 'partial',
    text: segment.text,
    startMs: segment.startMs,
    endMs: segment.endMs,
    speakerId: mic ? 'YOU' : 'THEM'
  }
}
