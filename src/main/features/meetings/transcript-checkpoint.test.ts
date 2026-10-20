import { describe, expect, it } from 'vitest'
import type { TranscriptSegment } from '@shared/contracts/speech/transcript-revision'
import { parse, readMeetingFields, stripMeetingFrontmatter } from './meeting-document'
import {
  applyRevisionCheckpoint,
  decodeSegmentLanguages,
  encodeSegmentLanguages,
  readRevisionCheckpoint
} from './transcript-checkpoint'

const seg = (seq: number, language: string): TranscriptSegment => ({
  segmentId: `seg-${seq}`,
  seq,
  channel: 'mic',
  startMs: seq * 100,
  endMs: seq * 100 + 90,
  language,
  text: `text ${seq}`,
  state: 'final',
  source: 'provider',
  relaySessionId: 'cap/1/1'
})

const SEGMENTS = [seg(0, 'en-US'), seg(1, 'en-US'), seg(2, 'fr'), seg(3, 'en-US')]

const LF_DOC = '---\ntitle: "A meeting"\ndate: 2024-01-01\n---\n\n# Notes\nfirst line\nsecond line\n'
const CRLF_DOC = LF_DOC.replace(/\n/g, '\r\n')

describe('transcript checkpoint frontmatter', () => {
  it('encodes consecutive languages as seq runs', () => {
    expect(encodeSegmentLanguages({ segments: SEGMENTS })).toBe('en-US@0-1 fr@2 en-US@3')
  })

  it('sorts a copy of unsorted segments', () => {
    const shuffled = [SEGMENTS[3], SEGMENTS[1], SEGMENTS[2], SEGMENTS[0]]
    const before = shuffled.map((s) => s.seq)
    expect(encodeSegmentLanguages({ segments: shuffled })).toBe('en-US@0-1 fr@2 en-US@3')
    expect(shuffled.map((s) => s.seq)).toEqual(before)
  })

  it('replaces an invalid language token with und', () => {
    expect(encodeSegmentLanguages({ segments: [seg(0, 'e')] })).toBe('und@0')
    expect(encodeSegmentLanguages({ segments: [seg(0, 'en_US!')] })).toBe('und@0')
  })

  it('encodes no segments as empty', () => {
    expect(encodeSegmentLanguages({ segments: [] })).toBe('')
  })

  it('decodes what it encodes', () => {
    expect(decodeSegmentLanguages(encodeSegmentLanguages({ segments: SEGMENTS }))).toEqual([
      { language: 'en-US', from: 0, to: 1 },
      { language: 'fr', from: 2, to: 2 },
      { language: 'en-US', from: 3, to: 3 }
    ])
    expect(decodeSegmentLanguages('')).toEqual([])
    expect(decodeSegmentLanguages('  ')).toEqual([])
  })

  it('rejects malformed, overlapping and descending runs', () => {
    for (const bad of ['en@', 'x@1', 'en@3-1', 'en@0-2 fr@2', 'en@5 fr@1', 'en@99999999999999999']) {
      expect(decodeSegmentLanguages(bad)).toBeNull()
    }
  })

  it('stamps an LF document and preserves the body', () => {
    const out = applyRevisionCheckpoint(LF_DOC, { revision: 7, segments: SEGMENTS })
    expect(out).not.toBeNull()
    const text = out as string
    const fields = readMeetingFields(text)
    expect(fields.transcriptRevision).toBe('7')
    expect(fields.revisionSchema).toBe('1')
    expect(fields.segmentLanguages).toBe('en-US@0-1 fr@2 en-US@3')
    expect(fields.title).toBe('A meeting')
    expect(stripMeetingFrontmatter(text)).toBe(stripMeetingFrontmatter(LF_DOC))
    expect(parse(text)?.eol).toBe('\n')
  })

  it('stamps a CRLF document and preserves the body and eol', () => {
    const out = applyRevisionCheckpoint(CRLF_DOC, { revision: 3, segments: SEGMENTS })
    expect(out).not.toBeNull()
    const text = out as string
    const doc = parse(text)
    expect(doc?.eol).toBe('\r\n')
    const fields = readMeetingFields(text)
    expect(fields.transcriptRevision).toBe('3')
    expect(fields.revisionSchema).toBe('1')
    expect(fields.segmentLanguages).toBe('en-US@0-1 fr@2 en-US@3')
    expect(stripMeetingFrontmatter(text)).toBe(stripMeetingFrontmatter(CRLF_DOC))
    const head = text.slice(0, text.length - (doc?.body.length ?? 0))
    expect(/(?<!\r)\n/.test(head)).toBe(false)
  })

  it('replaces existing values and drops duplicates', () => {
    const doc = '---\ntranscriptRevision: 1\ntitle: "x"\ntranscriptRevision: 2\nsegmentLanguages: "en@0"\n---\nbody\n'
    const out = applyRevisionCheckpoint(doc, { revision: 9, segments: SEGMENTS }) as string
    const lines = parse(out)?.lines ?? []
    expect(lines.filter((l) => l.startsWith('transcriptRevision:'))).toEqual(['transcriptRevision: 9'])
    expect(lines.filter((l) => l.startsWith('segmentLanguages:'))).toHaveLength(1)
    expect(readMeetingFields(out).segmentLanguages).toBe('en-US@0-1 fr@2 en-US@3')
  })

  it('removes segmentLanguages when languages is false', () => {
    const withLanguages = applyRevisionCheckpoint(LF_DOC, { revision: 2, segments: SEGMENTS }) as string
    const out = applyRevisionCheckpoint(
      withLanguages,
      { revision: 2, segments: SEGMENTS },
      { languages: false }
    ) as string
    const fields = readMeetingFields(out)
    expect(fields.segmentLanguages).toBeUndefined()
    expect(fields.transcriptRevision).toBe('2')
    expect(fields.revisionSchema).toBe('1')
  })

  it('returns null without a frontmatter block', () => {
    expect(applyRevisionCheckpoint('# just a body\n', { revision: 1, segments: [] })).toBeNull()
  })

  it('is idempotent', () => {
    const once = applyRevisionCheckpoint(CRLF_DOC, { revision: 4, segments: SEGMENTS }) as string
    const twice = applyRevisionCheckpoint(once, { revision: 4, segments: SEGMENTS })
    expect(twice).toBe(once)
  })

  it('reads legacy files as null', () => {
    expect(readRevisionCheckpoint(LF_DOC)).toBeNull()
  })

  it('reads a stamped checkpoint', () => {
    const out = applyRevisionCheckpoint(LF_DOC, { revision: 5, segments: SEGMENTS }) as string
    expect(readRevisionCheckpoint(out)).toEqual({
      revision: 5,
      schema: 1,
      languages: [
        { language: 'en-US', from: 0, to: 1 },
        { language: 'fr', from: 2, to: 2 },
        { language: 'en-US', from: 3, to: 3 }
      ]
    })
  })

  it('reads malformed languages as null and rejects a bad revision', () => {
    const badLanguages = '---\ntranscriptRevision: 2\nsegmentLanguages: "en@3-1"\n---\nbody\n'
    expect(readRevisionCheckpoint(badLanguages)).toEqual({ revision: 2, schema: 1, languages: null })
    const badRevision = '---\ntranscriptRevision: abc\n---\nbody\n'
    expect(readRevisionCheckpoint(badRevision)).toBeNull()
  })
})
