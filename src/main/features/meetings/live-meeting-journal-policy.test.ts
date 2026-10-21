import { describe, expect, it } from 'vitest'
import { createStorageGateway } from '../../infra/storage/gateway'
import { createIncrementalMeetingJournalFileStorage } from './incremental-meeting-journal-files'
import { MEETING_SPEECH_LIMITS } from './meeting-speech-policy'
import {
  LIVE_MEETING_JOURNAL_APPEND_QUEUE_MAX,
  LIVE_MEETING_JOURNAL_LIMITS,
  LIVE_MEETING_JOURNAL_STORAGE_BUDGET,
  validateLiveMeetingJournalPolicy
} from './live-meeting-journal-policy'

describe('live meeting journal policy constants', () => {
  it('ships exactly the budgets the owner approved on 2026-10-21', () => {
    expect(LIVE_MEETING_JOURNAL_LIMITS).toEqual({
      maxRecords: 12_000,
      maxWords: 150_000,
      maxFieldBytes: 32_768,
      maxRecordBytes: 131_072,
      maxPayloadBytes: 67_108_864,
      maxJournalBytes: 134_217_728
    })
    expect(LIVE_MEETING_JOURNAL_STORAGE_BUDGET).toEqual({
      maxPhysicalRecordBytes: 139_264,
      maxChunkBytes: 65_536,
      maxPageRecords: 256,
      maxPageBytes: 35_651_584
    })
    expect(LIVE_MEETING_JOURNAL_APPEND_QUEUE_MAX).toBe(64)
  })

  it('shares one definition of a legal line with the speech save codec', () => {
    const { maxJournalBytes, ...perRecord } = LIVE_MEETING_JOURNAL_LIMITS
    expect(perRecord).toEqual(MEETING_SPEECH_LIMITS)
    expect(maxJournalBytes).toBe(MEETING_SPEECH_LIMITS.maxPayloadBytes * 2)
  })

  it('is frozen so no caller can widen it at runtime', () => {
    expect(Object.isFrozen(LIVE_MEETING_JOURNAL_LIMITS)).toBe(true)
    expect(Object.isFrozen(LIVE_MEETING_JOURNAL_STORAGE_BUDGET)).toBe(true)
  })

  it('keeps every relation the journal and file adapter constructors enforce', () => {
    const l = LIVE_MEETING_JOURNAL_LIMITS
    const s = LIVE_MEETING_JOURNAL_STORAGE_BUDGET
    expect(() => validateLiveMeetingJournalPolicy()).not.toThrow()
    expect(l.maxFieldBytes).toBeLessThanOrEqual(l.maxRecordBytes)
    expect(l.maxRecordBytes).toBeLessThanOrEqual(l.maxPayloadBytes)
    expect(l.maxPayloadBytes).toBeLessThanOrEqual(l.maxJournalBytes)
    // A schema-valid segment (8,192 characters, up to 4 bytes each) can never trip the field cap.
    expect(l.maxFieldBytes).toBeGreaterThanOrEqual(8_192 * 4)
    // The physical record holds the logical record plus its wrapper, metadata and header.
    expect(s.maxPhysicalRecordBytes).toBeGreaterThan(l.maxRecordBytes)
    expect(s.maxPhysicalRecordBytes).toBeLessThanOrEqual(l.maxJournalBytes)
    expect(s.maxChunkBytes).toBeLessThanOrEqual(Math.min(l.maxJournalBytes, s.maxPhysicalRecordBytes))
    expect(s.maxPageBytes).toBeLessThanOrEqual(l.maxJournalBytes)
    expect(s.maxPageBytes).toBe(s.maxPageRecords * s.maxPhysicalRecordBytes)
    for (const value of [...Object.values(l), ...Object.values(s), LIVE_MEETING_JOURNAL_APPEND_QUEUE_MAX])
      expect(Number.isSafeInteger(value) && value > 0).toBe(true)
  })

  it('is accepted by the real file adapter constructor', () => {
    const storage = createIncrementalMeetingJournalFileStorage({
      root: '/nonexistent/journal-root',
      meetingId: '8d3e41c2-5a7b-8c11-9a42-0b6f1e2d3c4a',
      key: new Uint8Array(32).fill(7),
      maxJournalBytes: LIVE_MEETING_JOURNAL_LIMITS.maxJournalBytes,
      ...LIVE_MEETING_JOURNAL_STORAGE_BUDGET,
      isCurrent: () => true,
      gateway: createStorageGateway({ root: () => '/nonexistent/journal-root' })
    })
    expect(storage).toBeDefined()
    storage?.dispose()
  })

  it('rejects an inconsistent policy', () => {
    const l = LIVE_MEETING_JOURNAL_LIMITS
    const s = LIVE_MEETING_JOURNAL_STORAGE_BUDGET
    const message = 'Live meeting journal policy is inconsistent.'
    expect(() => validateLiveMeetingJournalPolicy({ ...l, maxJournalBytes: l.maxPayloadBytes - 1 }, s)).toThrow(message)
    expect(() => validateLiveMeetingJournalPolicy({ ...l, maxFieldBytes: l.maxRecordBytes + 1 }, s)).toThrow(message)
    expect(() => validateLiveMeetingJournalPolicy(l, { ...s, maxPhysicalRecordBytes: l.maxRecordBytes })).toThrow(
      message
    )
    expect(() => validateLiveMeetingJournalPolicy(l, { ...s, maxChunkBytes: s.maxPhysicalRecordBytes + 1 })).toThrow(
      message
    )
    expect(() => validateLiveMeetingJournalPolicy(l, { ...s, maxPageBytes: s.maxPageBytes + 1 })).toThrow(message)
    expect(() => validateLiveMeetingJournalPolicy(l, s, 0)).toThrow(message)
    expect(() => validateLiveMeetingJournalPolicy({ ...l, maxWords: 1.5 }, s)).toThrow(message)
  })
})
