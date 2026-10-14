import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { canonicalizeIncrementalMeetingRecord } from './incremental-record-canonical'

const limits = {
  maxRecords: 8,
  maxWords: 16,
  maxFieldBytes: 256,
  maxRecordBytes: 2_048,
  maxPayloadBytes: 8_192
}
const maxInputBytes = 8_192

const record = {
  identity: { kind: 'local', recordId: '6370e1cc-43f4-4976-a912-04d0c3ca8f9f' },
  source: 'local-final',
  line: { speaker: 'you', text: 'A <safe> & canonical line.', t: 1_700_000_000_000 }
}

describe('incremental record canonicalization', () => {
  it('returns one exact-owned canonical record and its identity digest', () => {
    const result = canonicalizeIncrementalMeetingRecord(record, limits, maxInputBytes)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.wordCount).toBe(0)
    expect(result.value.identityKey).toBe(JSON.stringify(record.identity))
    expect(Buffer.from(result.value.canonicalBytes).toString('utf8')).toBe(
      '{"identity":{"kind":"local","recordId":"6370e1cc-43f4-4976-a912-04d0c3ca8f9f"},"source":"local-final","line":{"speaker":"you","text":"A \\u003csafe\\u003e & canonical line.","t":1700000000000}}'
    )
    expect(result.value.canonicalBytes.byteOffset).toBe(0)
    expect(result.value.canonicalBytes.byteLength).toBe(result.value.canonicalByteLength)
    expect(result.value.sha256).toBe(createHash('sha256').update(result.value.canonicalBytes).digest('hex'))
  })

  it('rejects actual field, record, envelope, and word overages before returning a record', () => {
    expect(canonicalizeIncrementalMeetingRecord(record, { ...limits, maxFieldBytes: 4 }, maxInputBytes)).toEqual({
      ok: false,
      reason: 'RESOURCE_LIMIT'
    })
    expect(canonicalizeIncrementalMeetingRecord(record, { ...limits, maxRecordBytes: 16 }, maxInputBytes)).toEqual({
      ok: false,
      reason: 'RESOURCE_LIMIT'
    })
    expect(canonicalizeIncrementalMeetingRecord(record, limits, 32)).toEqual({
      ok: false,
      reason: 'RESOURCE_LIMIT'
    })
    const worded = {
      ...record,
      source: 'cloud-final',
      identity: {
        kind: 'cloud',
        captureId: '98d9177d-95a1-49f2-8433-22ba7308dc08',
        captureGeneration: 7,
        track: 'microphone',
        epoch: 11,
        segmentIndex: 4
      },
      line: {
        speaker: 'them',
        text: 'Word',
        t: 1_700_000_000_000,
        speech: {
          type: 'segment',
          captureId: '98d9177d-95a1-49f2-8433-22ba7308dc08',
          captureGeneration: 7,
          sequence: 1,
          segment: {
            stream: { generation: 7, track: 'microphone', epoch: 11 },
            engine: 'deepgram-nova3',
            index: 4,
            revision: 1,
            startMs: 0,
            endMs: 500,
            final: true,
            text: 'Word'
          },
          words: [
            { text: 'Word', startMs: 0, endMs: 250 },
            { text: 'Word', startMs: 250, endMs: 500 }
          ]
        }
      }
    }
    expect(canonicalizeIncrementalMeetingRecord(worded, { ...limits, maxWords: 1 }, maxInputBytes).ok).toBe(false)
    expect(canonicalizeIncrementalMeetingRecord(worded, { ...limits, maxWords: 2 }, maxInputBytes).ok).toBe(true)
  })

  it('does not accept a provisional, mismatched, or structurally extended record', () => {
    expect(
      canonicalizeIncrementalMeetingRecord(
        { ...record, line: { ...record.line, provisional: true } },
        limits,
        maxInputBytes
      )
    ).toEqual({ ok: false, reason: 'INVALID_RECORD' })
    expect(canonicalizeIncrementalMeetingRecord({ ...record, unexpected: true }, limits, maxInputBytes)).toEqual({
      ok: false,
      reason: 'INVALID_RECORD'
    })
  })
})
