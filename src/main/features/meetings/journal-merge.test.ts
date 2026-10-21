import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TranscriptLine } from '@shared/transcript-line'
import { cloudLine } from './__fixtures__/live-journal-fixtures'
import { mergeJournalIntoDraft, mergeLinesByTime, selectJournalTail } from './journal-merge'
import { lineIdentityKey, type JournalRecord } from './journal-reader'
import { decodeStoredMeetingSpeech, renderMeetingTranscript } from './meeting-speech'
import { installMeetingSpeechPolicy } from './meeting-speech-policy'
import { buildDraftTranscriptDocument } from './draft-transcript-document'

vi.mock('electron')

const STARTED_AT = Date.parse('2026-10-21T15:00:00.000Z')
const line = (index: number): TranscriptLine => cloudLine(STARTED_AT, index)
const record = (revision: number, index: number): JournalRecord => {
  const l = line(index)
  return { revision, identityKey: lineIdentityKey(l), line: l }
}
const indexOf = (l: TranscriptLine): number => (l.speech?.type === 'segment' ? l.speech.segment.index : -1)

beforeEach(() => installMeetingSpeechPolicy())

describe('selectJournalTail', () => {
  it('is every record when the draft holds none of them', () => {
    expect(selectJournalTail([], [record(1, 1), record(2, 2)]).map((r) => r.revision)).toEqual([1, 2])
  })

  it('is only the records newer than the newest one the draft already holds', () => {
    const tail = selectJournalTail(
      [line(1), line(2)],
      [1, 2, 3, 4].map((n) => record(n, n))
    )
    expect(tail.map((r) => r.revision)).toEqual([3, 4])
  })

  it('does not resurrect a record the draft dropped before a record it kept', () => {
    // draft kept 1 and 4, dropped 2 and 3 (user deleted them earlier); 5 and 6 landed after the last autosave
    const tail = selectJournalTail(
      [line(1), line(4)],
      [1, 2, 3, 4, 5, 6].map((n) => record(n, n))
    )
    expect(tail.map((r) => r.revision)).toEqual([5, 6])
  })

  it('is empty when the draft already holds the newest record', () => {
    expect(
      selectJournalTail(
        [line(1), line(2), line(3)],
        [1, 2, 3].map((n) => record(n, n))
      )
    ).toEqual([])
  })

  it('orders by revision whatever order the records arrive in', () => {
    expect(selectJournalTail([], [record(3, 3), record(1, 1), record(2, 2)]).map((r) => r.revision)).toEqual([1, 2, 3])
  })
})

describe('mergeLinesByTime', () => {
  it('keeps both sequences in order and puts the draft first on a tie', () => {
    const draft = [
      { ...line(1), text: 'draft@5' },
      { ...line(3), text: 'draft@15' }
    ]
    const tail = [
      { ...line(1), text: 'tail@5' },
      { ...line(2), text: 'tail@10' },
      { ...line(4), text: 'tail@20' }
    ]
    expect(mergeLinesByTime(draft, tail).map((l) => l.text)).toEqual([
      'draft@5',
      'tail@5',
      'tail@10',
      'draft@15',
      'tail@20'
    ])
  })

  it('never reorders a draft that is not sorted by time', () => {
    const draft = [line(3), line(1)]
    expect(mergeLinesByTime(draft, []).map(indexOf)).toEqual([3, 1])
  })
})

describe('mergeJournalIntoDraft', () => {
  const draftText = (lines: TranscriptLine[]): string =>
    buildDraftTranscriptDocument(
      { title: 'Planning', mode: 'meeting', startedAt: STARTED_AT, lines, recap: '' } as never,
      STARTED_AT,
      'Planning',
      lines.length ? renderMeetingTranscript(lines) : ''
    )

  it('adds the tail and keeps the draft header, clocks and speech frame valid', async () => {
    const text = draftText([line(1), line(2)])
    const result = await mergeJournalIntoDraft(
      text,
      STARTED_AT,
      [1, 2, 3, 4].map((n) => record(n, n))
    )
    expect(result.status).toBe('merged')
    if (result.status !== 'merged') return
    expect(result.added).toBe(2)
    const decoded = decodeStoredMeetingSpeech(result.text)
    expect(decoded.ok && decoded.status === 'valid' && decoded.lines.map(indexOf)).toEqual([1, 2, 3, 4])
    expect(result.text.startsWith('---\ntype: meeting-transcript-draft\n')).toBe(true)
    expect(result.text).toContain('status: interrupted')
  })

  it('reports nothing to add when the draft already holds everything or the journal is empty', async () => {
    const text = draftText([line(1), line(2)])
    await expect(mergeJournalIntoDraft(text, STARTED_AT, [record(1, 1), record(2, 2)])).resolves.toEqual({
      status: 'nothing-to-add'
    })
    await expect(mergeJournalIntoDraft(text, STARTED_AT, [])).resolves.toEqual({ status: 'nothing-to-add' })
  })

  it('is unmergeable for a plain draft with lines, and never alters it', async () => {
    const plain = draftText([{ speaker: 'you', text: 'plain local line', t: STARTED_AT }])
    await expect(mergeJournalIntoDraft(plain, STARTED_AT, [record(1, 1)])).resolves.toEqual({ status: 'unmergeable' })
  })

  it('is unmergeable for a draft whose speech frame is ambiguous', async () => {
    const text = draftText([line(1)]) + '\n<!-- metis-speech-transcript:v1 -->\n'
    await expect(mergeJournalIntoDraft(text, STARTED_AT, [record(1, 1), record(2, 2)])).resolves.toEqual({
      status: 'unmergeable'
    })
  })

  it('is unmergeable, never throwing, when the merged transcript exceeds the trusted budget', async () => {
    const { configureMeetingSpeechLimits } = await import('./meeting-speech')
    const text = draftText([line(1)])
    configureMeetingSpeechLimits({
      maxFieldBytes: 32_768,
      maxPayloadBytes: 1_024,
      maxRecordBytes: 131_072,
      maxRecords: 12_000,
      maxWords: 150_000
    })
    await expect(mergeJournalIntoDraft(text, STARTED_AT, [record(1, 1), record(2, 2)])).resolves.toEqual({
      status: 'unmergeable'
    })
  })
})
