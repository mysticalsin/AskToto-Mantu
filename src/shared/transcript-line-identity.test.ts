import { describe, expect, it } from 'vitest'
import { IncrementalMeetingRecordSchema } from './incremental-meeting'
import { AppendMeetingJournalSchema } from './live-meeting-contracts'
import { TranscriptLedger } from './kernel/transcript-ledger'
import { TRANSCRIPT_LINE_KEYS, TranscriptLineSchema, type TranscriptLine } from './transcript-line'
import {
  cloudLedgerStreamId,
  cloudUtteranceId,
  lineIdentityFromSpeech,
  lineIdentityIsConsistent,
  speechSegmentToLedgerEvent
} from './transcript-line-identity'

const SCOPE = { tenantId: 'synthetic-tenant', userId: 'synthetic-user', sessionId: 'synthetic-session' }
const CAPTURE = '98d9177d-95a1-49f2-8433-22ba7308dc08'

const speech = (
  overrides: {
    index?: number
    revision?: number
    epoch?: number
    final?: boolean
    text?: string
    sequence?: number
  } = {}
) => ({
  type: 'segment' as const,
  captureId: CAPTURE,
  captureGeneration: 7,
  sequence: overrides.sequence ?? 1,
  segment: {
    stream: { generation: 7, track: 'microphone' as const, epoch: overrides.epoch ?? 2 },
    engine: 'deepgram-nova3' as const,
    index: overrides.index ?? 4,
    revision: overrides.revision ?? 3,
    final: overrides.final ?? true,
    text: overrides.text ?? 'Synthetic words',
    startMs: 1_000,
    endMs: 1_900
  }
})

const cloudLine = (overrides: Partial<TranscriptLine> = {}): TranscriptLine => ({
  speaker: 'you',
  text: 'Synthetic words',
  t: 1_700_000_000_000,
  speech: speech(),
  ...overrides
})

describe('transcript line identity (utteranceId and revision)', () => {
  it('derives one stable id and the provider revision from the segment a line carries', () => {
    expect(cloudUtteranceId({ generation: 7, track: 'microphone', epoch: 2 }, 4)).toBe('7:microphone:2:4')
    expect(lineIdentityFromSpeech(speech())).toEqual({ utteranceId: '7:microphone:2:4', revision: 3 })
    expect(cloudLedgerStreamId({ generation: 7, track: 'system', epoch: 9 })).toBe('7:system')
  })

  it('parses every line saved before the fields existed, unchanged and without guessed identity', () => {
    for (const legacy of [
      { speaker: 'unknown', text: 'imported', t: 5 },
      { speaker: 'you', text: 'named', t: 6, name: 'Sam', lang: 'French' },
      cloudLine()
    ]) {
      const parsed = TranscriptLineSchema.parse(legacy)
      expect(parsed).toEqual(legacy)
      expect('utteranceId' in parsed).toBe(false)
      expect('revision' in parsed).toBe(false)
    }
  })

  it('accepts the identity as a consistent pair and refuses a half, a mismatch or a malformed id', () => {
    const identity = lineIdentityFromSpeech(speech())
    expect(TranscriptLineSchema.safeParse(cloudLine(identity)).success).toBe(true)
    expect(TranscriptLineSchema.safeParse(cloudLine({ utteranceId: identity.utteranceId })).success).toBe(false)
    expect(TranscriptLineSchema.safeParse(cloudLine({ revision: 3 })).success).toBe(false)
    expect(TranscriptLineSchema.safeParse(cloudLine({ ...identity, revision: 4 })).success).toBe(false)
    expect(TranscriptLineSchema.safeParse(cloudLine({ ...identity, utteranceId: '7:microphone:2:5' })).success).toBe(
      false
    )
    expect(
      TranscriptLineSchema.safeParse({ speaker: 'you', text: 'x', t: 1, utteranceId: 'a b', revision: 1 }).success
    ).toBe(false)
    expect(
      TranscriptLineSchema.safeParse({ speaker: 'you', text: 'x', t: 1, utteranceId: 'u1', revision: 0 }).success
    ).toBe(false)
    // a line without provider provenance may still carry an id and a revision
    expect(
      TranscriptLineSchema.safeParse({ speaker: 'you', text: 'x', t: 1, utteranceId: 'u1', revision: 2 }).success
    ).toBe(true)
    expect(lineIdentityIsConsistent(cloudLine(identity))).toBe(true)
  })

  it('shares one key allow-list with the journal contracts, so the fields cross every durable boundary', () => {
    expect([...TRANSCRIPT_LINE_KEYS].sort()).toEqual(
      ['lang', 'name', 'provisional', 'revision', 'speaker', 'speech', 't', 'text', 'utteranceId'].sort()
    )
    const line = cloudLine(lineIdentityFromSpeech(speech()))
    const record = {
      identity: {
        kind: 'cloud',
        captureId: CAPTURE,
        captureGeneration: 7,
        streamGeneration: 7,
        track: 'microphone',
        epoch: 2,
        segmentIndex: 4
      },
      source: 'cloud-final',
      line
    }
    expect(IncrementalMeetingRecordSchema.parse(record).line).toEqual(line)
    expect(IncrementalMeetingRecordSchema.parse({ ...record, line: cloudLine() }).line).toEqual(cloudLine())
    expect(AppendMeetingJournalSchema.parse({ startedAt: 1_700_000_000_000, line }).line).toEqual(line)
    expect(AppendMeetingJournalSchema.safeParse({ startedAt: 1, line: { ...line, extra: 1 } }).success).toBe(false)
  })

  it('maps delivered segments onto the ledger: replays are idempotent and a reconnect retires partials', () => {
    const ledger = new TranscriptLedger(SCOPE)
    const first = speech({ final: false, sequence: 1, revision: 1, text: 'Synthetic wor' })
    ledger.startStream({
      scope: SCOPE,
      streamId: cloudLedgerStreamId(first.segment.stream),
      epoch: first.segment.stream.epoch
    })
    expect(ledger.apply(speechSegmentToLedgerEvent(first, SCOPE)).reason).toBe('partial')
    const final = speech({ sequence: 2, revision: 2 })
    expect(ledger.apply(speechSegmentToLedgerEvent(final, SCOPE)).reason).toBe('final')
    expect(ledger.apply(speechSegmentToLedgerEvent(final, SCOPE)).reason).toBe('duplicate-event')
    expect(ledger.apply(speechSegmentToLedgerEvent({ ...final, sequence: 3 }, SCOPE)).reason).toBe('duplicate-revision')
    expect(ledger.snapshot().segments.map((item) => item.utteranceId)).toEqual(['7:microphone:2:4'])
    // the ledger's utterance id is exactly the one stamped on the line
    expect(ledger.snapshot().segments[0].revision).toBe(lineIdentityFromSpeech(final).revision)
  })
})
