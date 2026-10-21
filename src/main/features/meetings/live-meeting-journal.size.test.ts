import { mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CloudSpeechEvent } from '@shared/cloud-speech'
import { canonicalizeIncrementalMeetingRecord } from '../../infra/storage/incremental-record-canonical'
import { issueIncrementalRecordReceipt } from '../../infra/storage/incremental-record-receipt'
import { createStorageGateway } from '../../infra/storage/gateway'
import type { ContentPresence, DatalessDetector } from '../../infra/storage/dataless'
import { createIncrementalMeetingAppender } from './incremental-meeting-journal'
import { createIncrementalMeetingJournalFileStorage } from './incremental-meeting-journal-files'
import { MEETING_SPEECH_LIMITS } from './meeting-speech-policy'
import {
  LIVE_MEETING_JOURNAL_LIMITS,
  LIVE_MEETING_JOURNAL_STORAGE_BUDGET,
  LIVE_MEETING_JOURNAL_RECORD_ESTIMATE
} from './live-meeting-journal-policy'

/**
 * C09b design section 2 sized the journal from a DERIVED (never measured) record size: ~2 KB canonical, ~3 KB
 * physical per 12-word final. This is the first T4 test on purpose: it MEASURES a real 12-word cloud-final record
 * through the real canonicalizer and the real encrypted file store, prints the numbers, and fails if reality
 * contradicts the estimate by more than 2x, because every budget in the policy was derived from that estimate.
 */

const MEETING_ID = '8d3e41c2-5a7b-8c11-9a42-0b6f1e2d3c4a'
const CAPTURE_ID = '11111111-1111-4111-8111-111111111111'
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const WORDS_EN = ['so', 'what', 'we', 'agreed', 'on', 'Tuesday', 'was', 'to', 'ship', 'the', 'pilot', 'first']

function cloudFinalRecord(): { json: Uint8Array; wordCount: number; textBytes: number } {
  const startMs = 3_600_000
  const words = WORDS_EN.map((text, word) => ({
    text,
    language: 'en',
    startMs: startMs + word * 410,
    endMs: startMs + (word + 1) * 410 - 20
  }))
  const text = words.map((word) => word.text).join(' ')
  const speech: Extract<CloudSpeechEvent, { type: 'segment' }> = {
    type: 'segment',
    captureId: CAPTURE_ID,
    captureGeneration: 2,
    sequence: 4_717,
    segment: {
      stream: { generation: 2, track: 'system', epoch: 1 },
      engine: 'deepgram-nova3',
      index: 733,
      revision: 1,
      final: true,
      text,
      startMs,
      endMs: startMs + 5_000
    },
    languages: ['en'],
    words
  }
  const record = {
    identity: {
      kind: 'cloud',
      captureId: CAPTURE_ID,
      captureGeneration: 2,
      streamGeneration: 2,
      track: 'system',
      epoch: 1,
      segmentIndex: 733
    },
    source: 'cloud-final',
    line: { speaker: 'them', text, t: 1_760_000_000_000 + startMs, lang: 'English', speech }
  }
  return {
    json: new TextEncoder().encode(JSON.stringify(record)),
    wordCount: words.length,
    textBytes: Buffer.byteLength(text, 'utf8')
  }
}

function detector(): DatalessDetector {
  return { classify: async (files) => new Map(files.map((file): [string, ContentPresence] => [file.path, 'local'])) }
}

describe('live meeting journal record size (measured, not derived)', () => {
  it('measures a real 12-word cloud-final record against the section 2 estimate', async () => {
    const fixture = cloudFinalRecord()
    expect(fixture.wordCount).toBe(12)

    // 1. Canonical bytes, through the same function the journal uses inline.
    const canonical = canonicalizeIncrementalMeetingRecord(
      JSON.parse(Buffer.from(fixture.json).toString('utf8')),
      MEETING_SPEECH_LIMITS,
      LIVE_MEETING_JOURNAL_LIMITS.maxJournalBytes
    )
    expect(canonical).toMatchObject({ ok: true })
    if (!canonical.ok) return
    const canonicalByteLength = canonical.value.canonicalByteLength
    const linePayloadBytes = canonical.value.linePayloadBytes

    // 2. Physical bytes: append that exact record through the real encrypted file store into an empty root.
    const root = await mkdtemp(join(tmpdir(), 'metis-journal-size-'))
    roots.push(root)
    const gateway = createStorageGateway({ root: () => root, detector: detector() })
    const budget = LIVE_MEETING_JOURNAL_STORAGE_BUDGET
    const storage = createIncrementalMeetingJournalFileStorage({
      root,
      meetingId: MEETING_ID,
      key: Uint8Array.from({ length: 32 }, (_, index) => index + 1),
      maxJournalBytes: LIVE_MEETING_JOURNAL_LIMITS.maxJournalBytes,
      ...budget,
      isCurrent: () => true,
      gateway
    })
    expect(storage).toBeDefined()
    if (!storage) return
    await expect(storage.initialize()).resolves.toMatchObject({ status: 'ok' })
    const emptyNames = await readdir(root)
    const emptyBytes = (await Promise.all(emptyNames.map((name) => stat(join(root, name))))).reduce(
      (total, entry) => total + entry.size,
      0
    )
    const appender = createIncrementalMeetingAppender({
      meetingId: MEETING_ID,
      readLimits: () => LIVE_MEETING_JOURNAL_LIMITS,
      isCurrent: () => true,
      canonicalizeRecord: async (bytes, binding) => {
        const result = canonicalizeIncrementalMeetingRecord(
          JSON.parse(Buffer.from(bytes).toString('utf8')),
          binding.limits,
          binding.maxCanonicalBytes
        )
        if (!result.ok) throw new Error(result.reason)
        const receipt = issueIncrementalRecordReceipt(result.value, binding)
        if (!receipt) throw new Error('receipt')
        return receipt
      },
      storage
    })
    await expect(appender.append(fixture.json, 0)).resolves.toEqual({
      status: 'durable',
      revision: 1,
      duplicate: false
    })
    const names = await readdir(root)
    const sizes = await Promise.all(names.map(async (name) => [name, (await stat(join(root, name))).size] as const))
    const physicalBytes = sizes.reduce((total, [, size]) => total + size, 0)
    const recordFile = sizes.find(([name]) => name.startsWith('record-'))?.[1] ?? 0
    storage.dispose()

    const perRecordPhysical = physicalBytes - emptyBytes
    const measurement = {
      words: fixture.wordCount,
      textBytes: fixture.textBytes,
      linePayloadBytes,
      canonicalByteLength,
      recordFileBytes: recordFile,
      physicalBytesAfterOneAppend: physicalBytes,
      physicalBytesPerRecordExcludingManifest: perRecordPhysical,
      files: names.length,
      fourHourCanonicalMiB: Number(((canonicalByteLength * 5_760) / 1_048_576).toFixed(2)),
      fourHourPhysicalMiB: Number(((perRecordPhysical * 5_760) / 1_048_576).toFixed(2))
    }
    // Recorded on purpose: the T4 report and the design estimate are checked against this line.
    console.info(`[journal-size] ${JSON.stringify(measurement)}`)

    const estimate = LIVE_MEETING_JOURNAL_RECORD_ESTIMATE
    expect(canonicalByteLength).toBeGreaterThan(estimate.canonicalBytes / 2)
    expect(canonicalByteLength).toBeLessThan(estimate.canonicalBytes * 2)
    expect(perRecordPhysical).toBeGreaterThan(estimate.physicalBytes / 2)
    expect(perRecordPhysical).toBeLessThan(estimate.physicalBytes * 2)
    // And the shipped budget must hold the declared 4 h workload at the measured size.
    expect(canonicalByteLength * 5_760).toBeLessThan(LIVE_MEETING_JOURNAL_LIMITS.maxPayloadBytes)
    expect(perRecordPhysical * 5_760).toBeLessThan(LIVE_MEETING_JOURNAL_LIMITS.maxJournalBytes)
  })
})
