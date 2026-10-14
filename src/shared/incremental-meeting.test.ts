import { describe, expect, it } from 'vitest'
import { parseIncrementalMeetingCommand } from './incremental-meeting'

const meetingId = '64d5a603-0b18-4da5-8a3f-4a42c9d22031'
const recordId = '6370e1cc-43f4-4976-a912-04d0c3ca8f9f'
const localRecord = {
  identity: { kind: 'local', recordId },
  source: 'local-final',
  line: { speaker: 'you', text: 'A short retained sentence.', t: 1_700_000_000_000 }
}

describe('incremental meeting command contract', () => {
  it('accepts one final record and an explicit expected revision', () => {
    expect(
      parseIncrementalMeetingCommand({
        protocol: 1,
        operation: 'append-record',
        meetingId,
        expectedRevision: 0,
        record: localRecord
      })
    ).toEqual({
      ok: true,
      command: {
        protocol: 1,
        operation: 'append-record',
        meetingId,
        expectedRevision: 0,
        record: localRecord
      }
    })
  })

  it('rejects non-monotonic or unsafe revision frontiers', () => {
    for (const expectedRevision of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Number.POSITIVE_INFINITY]) {
      expect(
        parseIncrementalMeetingCommand({
          protocol: 1,
          operation: 'append-record',
          meetingId,
          expectedRevision,
          record: localRecord
        })
      ).toEqual({ ok: false, reason: 'INVALID_COMMAND' })
    }
  })

  it('rejects caller-selected paths, arbitrary fields, provisional and malformed records', () => {
    const base = {
      protocol: 1,
      operation: 'append-record',
      meetingId,
      expectedRevision: 0,
      record: localRecord
    }
    expect(parseIncrementalMeetingCommand({ ...base, path: '/private/meeting.md' })).toEqual({
      ok: false,
      reason: 'INVALID_COMMAND'
    })
    expect(parseIncrementalMeetingCommand({ ...base, credential: 'must-not-be-a-field' })).toEqual({
      ok: false,
      reason: 'INVALID_COMMAND'
    })
    expect(
      parseIncrementalMeetingCommand({
        ...base,
        record: { ...localRecord, line: { ...localRecord.line, provisional: true } }
      })
    ).toEqual({ ok: false, reason: 'INVALID_COMMAND' })
    expect(
      parseIncrementalMeetingCommand({
        ...base,
        record: { ...localRecord, unexpected: true }
      })
    ).toEqual({ ok: false, reason: 'INVALID_COMMAND' })
    expect(
      parseIncrementalMeetingCommand({
        ...base,
        record: { ...localRecord, line: { ...localRecord.line, arbitrary: 'not in the saved line contract' } }
      })
    ).toEqual({ ok: false, reason: 'INVALID_COMMAND' })
  })

  it('binds cloud identities exactly to a final speech line', () => {
    const speech = {
      captureId: '98d9177d-95a1-49f2-8433-22ba7308dc08',
      captureGeneration: 7,
      track: 'microphone',
      epoch: 11,
      segmentIndex: 4
    }
    const cloudRecord = {
      identity: { kind: 'cloud', ...speech },
      source: 'cloud-final',
      line: {
        speaker: 'them',
        text: 'A cloud transcript.',
        t: 1_700_000_000_000,
        speech: {
          captureId: speech.captureId,
          captureGeneration: speech.captureGeneration,
      sequence: 1,
          segment: {
        stream: { generation: 7, track: 'microphone', epoch: 11 },
        engine: 'deepgram-nova3',
            index: 4,
            revision: 1,
            startMs: 0,
            endMs: 500,
            final: true,
            text: 'A cloud transcript.'
          }
        }
      }
    }
    expect(
      parseIncrementalMeetingCommand({
        protocol: 1,
        operation: 'append-record',
        meetingId,
        expectedRevision: 0,
        record: cloudRecord
      }).ok
    ).toBe(true)
    expect(
      parseIncrementalMeetingCommand({
        protocol: 1,
        operation: 'append-record',
        meetingId,
        expectedRevision: 0,
        record: {
          ...cloudRecord,
          identity: { ...cloudRecord.identity, segmentIndex: 5 }
        }
      })
    ).toEqual({ ok: false, reason: 'INVALID_COMMAND' })
  })

  it('provides narrow patch, remove, checkpoint and finalize commands', () => {
    expect(
      parseIncrementalMeetingCommand({
        protocol: 1,
        operation: 'patch-record',
        meetingId,
        expectedRevision: 2,
        patch: { kind: 'speaker-name', target: { kind: 'local', recordId }, name: 'Sam' }
      }).ok
    ).toBe(true)
    expect(
      parseIncrementalMeetingCommand({
        protocol: 1,
        operation: 'remove-record',
        meetingId,
        expectedRevision: 2,
        target: { kind: 'local', recordId }
      }).ok
    ).toBe(true)
    expect(
      parseIncrementalMeetingCommand({ protocol: 1, operation: 'checkpoint', meetingId, frontier: 2 }).ok
    ).toBe(true)
    expect(
      parseIncrementalMeetingCommand({
        protocol: 1,
        operation: 'finalize',
        meetingId,
        frontier: 2,
        metadata: { title: 'Meeting', startedAt: 1_700_000_000_000 }
      }).ok
    ).toBe(true)
    expect(
      parseIncrementalMeetingCommand({
        protocol: 1,
        operation: 'patch-record',
        meetingId,
        expectedRevision: 2,
        patch: { kind: 'replace-all', lines: [] }
      })
    ).toEqual({ ok: false, reason: 'INVALID_COMMAND' })
  })
})
