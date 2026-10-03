import { describe, expect, it } from 'vitest'
import { JournalAckSchema, JournalEntrySchema, JournalSessionIdSchema, parseJournalRecord } from './index'

const line = { speaker: 'them' as const, text: 'Ship it on Friday.', t: 1200 }

describe('journal record contract', () => {
  it('accepts a finals batch and a recap or note revision with their record metadata', () => {
    const finals = { kind: 'finals', lines: [line], v: 1, seq: 1, at: 10 }
    const recap = { kind: 'revision', doc: 'recap', text: '## Decisions', v: 1, seq: 2, at: 11 }
    expect(parseJournalRecord(finals)).toEqual(finals)
    expect(parseJournalRecord(recap)).toEqual(recap)
    expect(parseJournalRecord({ ...recap, doc: 'note' })).toEqual({ ...recap, doc: 'note' })
  })

  it('rejects provisional captions, empty batches, unknown documents and bad metadata', () => {
    const meta = { v: 1, seq: 1, at: 0 }
    expect(parseJournalRecord({ kind: 'finals', lines: [{ ...line, provisional: true }], ...meta })).toBeNull()
    expect(parseJournalRecord({ kind: 'finals', lines: [], ...meta })).toBeNull()
    expect(parseJournalRecord({ kind: 'revision', doc: 'summary', text: 'x', ...meta })).toBeNull()
    expect(parseJournalRecord({ kind: 'revision', doc: 'note', text: 'x', ...meta, seq: 0 })).toBeNull()
    expect(parseJournalRecord({ kind: 'revision', doc: 'note', text: 'x', ...meta, v: 2 })).toBeNull()
    expect(JournalEntrySchema.safeParse({ kind: 'finals', lines: [{ ...line, provisional: true }] }).success).toBe(false)
  })

  it('allows only a single safe directory name as a session id', () => {
    expect(JournalSessionIdSchema.safeParse('meeting_2026-10-02-abc').success).toBe(true)
    for (const id of ['', '.', '..', '../x', 'a/b', 'a\\b', '-lead', 'x'.repeat(65)]) {
      expect(JournalSessionIdSchema.safeParse(id).success).toBe(false)
    }
  })

  it('requires an ack to cover at least one record', () => {
    expect(JournalAckSchema.safeParse({ sessionId: 's1', fromSeq: 2, toSeq: 3, savedAt: 5 }).success).toBe(true)
    expect(JournalAckSchema.safeParse({ sessionId: 's1', fromSeq: 3, toSeq: 2, savedAt: 5 }).success).toBe(false)
  })
})
