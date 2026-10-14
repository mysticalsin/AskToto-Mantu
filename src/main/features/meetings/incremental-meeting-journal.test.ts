import { describe, expect, it } from 'vitest'
import type { SpeechProvenanceLimits } from '@shared/meeting-speech-contract'
import type { CanonicalIncrementalRecord } from '@shared/incremental-meeting'
import {
  createIncrementalMeetingAppender,
  provenancePayloadBytes,
  type IncrementalJournalSnapshot,
  type IncrementalMeetingJournalStorage
} from './incremental-meeting-journal'

const meetingId = '64d5a603-0b18-4da5-8a3f-4a42c9d22031'
const recordJson = new TextEncoder().encode('{"identityKey":"local-a","sha256":"a"}')
const limits: SpeechProvenanceLimits & { maxJournalBytes: number } = {
  maxRecords: 3,
  maxWords: 4,
  maxFieldBytes: 1_024,
  maxRecordBytes: 2_048,
  maxPayloadBytes: 8_192,
  maxJournalBytes: 16_384
}

function snapshot(patch: Partial<IncrementalJournalSnapshot> = {}): IncrementalJournalSnapshot {
  return {
    state: 'active',
    acceptedRevision: 0,
    durableRevision: 0,
    recordCount: 0,
    wordCount: 0,
    linePayloadBytes: 0,
    storedBytes: 0,
    ...patch
  }
}

function canonical(
  patch: Partial<CanonicalIncrementalRecord> & { identityKey?: string; sha256?: string } = {}
): CanonicalIncrementalRecord {
  const canonicalBytes = Uint8Array.from([1, 2, 3])
  return {
    identityKey: 'local-a',
    sha256: 'a'.repeat(64),
    canonicalBytes,
    canonicalByteLength: canonicalBytes.byteLength,
    wordCount: 1,
    linePayloadBytes: 100,
    clock: '12:34:56',
    ...patch
  }
}

function fixture(
  options: {
    initial?: IncrementalJournalSnapshot
    limits?: SpeechProvenanceLimits & { maxJournalBytes: number }
    current?: () => boolean
    canonical?: () => Promise<CanonicalIncrementalRecord>
    lookup?: IncrementalMeetingJournalStorage['lookupIdentity']
    commit?: IncrementalMeetingJournalStorage['commitAppend']
  } = {}
) {
  let currentSnapshot = options.initial ?? snapshot()
  let commitCalls = 0
  const storage: IncrementalMeetingJournalStorage = {
    readSnapshot: async () => ({ status: 'ok', snapshot: currentSnapshot }),
    lookupIdentity: options.lookup ?? (async () => ({ status: 'absent' })),
    commitAppend:
      options.commit ??
      (async (request) => {
        commitCalls++
        currentSnapshot = {
          ...currentSnapshot,
          acceptedRevision: request.nextRevision,
          durableRevision: request.nextRevision,
          recordCount: request.recordCount,
          wordCount: request.wordCount,
          linePayloadBytes: request.linePayloadBytes,
          storedBytes: currentSnapshot.storedBytes + request.canonicalByteLength
        }
        return { status: 'committed', snapshot: currentSnapshot }
      })
  }
  return {
    appender: createIncrementalMeetingAppender({
      meetingId,
      readLimits: () => options.limits ?? limits,
      isCurrent: options.current ?? (() => true),
      canonicalizeRecord: options.canonical ?? (async () => canonical()),
      storage
    }),
    storage,
    readSnapshot: () => currentSnapshot,
    commitCalls: () => commitCalls
  }
}

describe('bounded incremental meeting append journal', () => {
  it('computes the exact v1 payload overhead from record count and canonical line bytes', () => {
    const one = provenancePayloadBytes(1, 100)
    const two = provenancePayloadBytes(2, 200)
    expect(one).toBe(
      Buffer.byteLength('{"version":1,"clocks":["12:34:56"],"lines":[') +
        100 +
        Buffer.byteLength('],"transcriptSha256":"' + '0'.repeat(64) + '"}')
    )
    expect(two).toBe(one + 100 + Buffer.byteLength(',"12:34:56"') + Buffer.byteLength(','))
  })

  it('commits one record and advances only a matching durable frontier', async () => {
    const { appender, readSnapshot, commitCalls } = fixture()
    await expect(appender.append(recordJson, 0)).resolves.toEqual({ status: 'durable', revision: 1, duplicate: false })
    expect(readSnapshot()).toMatchObject({ acceptedRevision: 1, durableRevision: 1, recordCount: 1, wordCount: 1 })
    expect(commitCalls()).toBe(1)
  })

  it('treats an exact identity-and-digest retry as idempotent and refuses conflicting bytes', async () => {
    const existing = { status: 'found' as const, sha256: 'a'.repeat(64), revision: 1 }
    const exact = fixture({
      initial: snapshot({
        acceptedRevision: 1,
        durableRevision: 1,
        recordCount: 1,
        wordCount: 1,
        linePayloadBytes: 100,
        storedBytes: 3
      }),
      lookup: async () => existing
    })
    await expect(exact.appender.append(recordJson, 0)).resolves.toEqual({
      status: 'durable',
      revision: 1,
      duplicate: true
    })
    expect(exact.commitCalls()).toBe(0)

    const conflict = fixture({ lookup: async () => ({ ...existing, sha256: 'b'.repeat(64) }) })
    await expect(conflict.appender.append(recordJson, 0)).resolves.toEqual({
      status: 'refused',
      reason: 'CONFLICTING_IDENTITY'
    })
    expect(conflict.commitCalls()).toBe(0)
  })

  it('enforces revision, record, word, provenance-payload and journal-byte limits before commit', async () => {
    const stale = fixture({ initial: snapshot({ acceptedRevision: 2, durableRevision: 2 }) })
    await expect(stale.appender.append(recordJson, 1)).resolves.toEqual({ status: 'refused', reason: 'STALE_REVISION' })

    const count = fixture({
      initial: snapshot({
        acceptedRevision: limits.maxRecords,
        durableRevision: limits.maxRecords,
        recordCount: limits.maxRecords,
        linePayloadBytes: limits.maxRecords * 100,
        storedBytes: limits.maxRecords * 100
      })
    })
    await expect(count.appender.append(recordJson, 0)).resolves.toEqual({ status: 'refused', reason: 'LIMIT' })

    const words = fixture({
      initial: snapshot({
        acceptedRevision: 1,
        durableRevision: 1,
        recordCount: 1,
        wordCount: limits.maxWords,
        linePayloadBytes: 100,
        storedBytes: 100
      })
    })
    await expect(words.appender.append(recordJson, 0)).resolves.toEqual({ status: 'refused', reason: 'LIMIT' })

    const payloadLimits = { ...limits, maxPayloadBytes: 3_000 }
    const payload = fixture({
      limits: payloadLimits,
      initial: snapshot({
        acceptedRevision: 1,
        durableRevision: 1,
        recordCount: 1,
        linePayloadBytes: 2_048,
        storedBytes: 2_048
      }),
      canonical: async () => canonical({ linePayloadBytes: 2_048 })
    })
    await expect(payload.appender.append(recordJson, 0)).resolves.toEqual({ status: 'refused', reason: 'LIMIT' })

    const disk = fixture({
      initial: snapshot({
        acceptedRevision: 1,
        durableRevision: 1,
        recordCount: 1,
        linePayloadBytes: 100,
        storedBytes: limits.maxJournalBytes - 1
      })
    })
    await expect(disk.appender.append(recordJson, 0)).resolves.toEqual({ status: 'refused', reason: 'LIMIT' })
    for (const result of [count, words, payload, disk]) expect(result.commitCalls()).toBe(0)
  })

  it('rechecks owner after canonicalization and identity lookup before an irreversible commit', async () => {
    let current = true
    const guarded = fixture({
      current: () => current,
      lookup: async () => {
        current = false
        return { status: 'absent' }
      }
    })
    await expect(guarded.appender.append(recordJson, 0)).resolves.toEqual({
      status: 'refused',
      reason: 'STALE_OWNER'
    })
    expect(guarded.commitCalls()).toBe(0)
  })

  it('uses the storage mutation fence when ownership retires during commit', async () => {
    let current = true
    const retired = fixture({
      current: () => current,
      commit: async (_request, isCurrent) => {
        current = false
        expect(isCurrent()).toBe(false)
        return { status: 'stale-owner' }
      }
    })
    await expect(retired.appender.append(recordJson, 0)).resolves.toEqual({
      status: 'refused',
      reason: 'STALE_OWNER'
    })
  })

  it('bounds work to one active operation instead of retaining an unbounded pending queue', async () => {
    let releaseLookup: (() => void) | undefined
    let markLookupStarted: (() => void) | undefined
    const lookupStarted = new Promise<void>((resolve) => (markLookupStarted = resolve))
    const held = fixture({
      lookup: () =>
        new Promise((resolve) => {
          markLookupStarted?.()
          releaseLookup = () => resolve({ status: 'absent' })
        })
    })
    const first = held.appender.append(recordJson, 0)
    await lookupStarted
    await expect(held.appender.append(recordJson, 0)).resolves.toEqual({ status: 'refused', reason: 'QUEUE_FULL' })
    releaseLookup?.()
    await expect(first).resolves.toMatchObject({ status: 'durable', revision: 1 })
  })
})
