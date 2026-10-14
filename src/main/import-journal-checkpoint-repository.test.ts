import { describe, expect, it, vi } from 'vitest'
import type { TranscriptLine } from '@shared/ipc'
import type {
  IncrementalMeetingAppender,
  IncrementalJournalSnapshot
} from './features/meetings/incremental-meeting-journal'
import type { IncrementalMeetingJournalFileStorage } from './features/meetings/incremental-meeting-journal-files'
import type { ImportCheckpoint, ImportJobHeader } from './import-job-checkpoint-contract'
import type { ImportLegacyOriginHandle } from './import-legacy-origin'
import type { ImportPersistencePolicy } from './import-persistence-policy'
import {
  createImportJournalCheckpointRepository,
  type ImportJournalSession
} from './import-journal-checkpoint-repository'

const JOB_ID = '11111111-1111-4111-8111-111111111111'
const MEETING_ID = '22222222-2222-4222-8222-222222222222'
const ORIGIN = Object.freeze({}) as ImportLegacyOriginHandle

function policy(): ImportPersistencePolicy {
  return {
    revision: 'test-policy',
    speech: { maxRecords: 100, maxWords: 1000, maxFieldBytes: 4096, maxRecordBytes: 8192, maxPayloadBytes: 16384 },
    legacy: {
      maxPhysicalBytes: 32768,
      maxDecodedBytes: 32768,
      maxDescriptorBytes: 8192,
      maxChunkBytes: 4096,
      maxResidentBytes: 16384,
      maxStagingBytes: 32768,
      operationDeadlineMs: 1000,
      shutdownDeadlineMs: 1000,
      nativeV1: { unavailable: true }
    },
    journal: {
      maxJournalBytes: 32768,
      maxPhysicalRecordBytes: 8192,
      maxChunkBytes: 4096,
      maxPageRecords: 10,
      maxPageBytes: 8192
    },
    worker: { maxInputBytes: 8192, maxOutputBytes: 8192, operationDeadlineMs: 1000, shutdownDeadlineMs: 1000 },
    consumers: { maxPublicExportBytes: 8192, maxRecapInputBytes: 8192, maxRecapOutputBytes: 1024 }
  }
}

function fixture() {
  let applicationBytes: Uint8Array | null = null
  let applicationRevision = 0
  let commitCalls = 0
  let failFinalCommit = true
  let snapshot: IncrementalJournalSnapshot = {
    state: 'active',
    acceptedRevision: 0,
    durableRevision: 0,
    recordCount: 0,
    wordCount: 0,
    linePayloadBytes: 0,
    storedBytes: 0
  }
  const records = new Map<string, string>()
  const storage = {
    async initialize() {
      return { status: 'ok' as const, snapshot }
    },
    async readSnapshot(_meetingId: string, isCurrent: () => boolean) {
      return isCurrent() ? { status: 'ok' as const, snapshot } : { status: 'unavailable' as const }
    },
    async readApplicationMetadata() {
      return {
        status: 'ok' as const,
        revision: applicationRevision,
        bytes: applicationBytes ? Uint8Array.from(applicationBytes) : null
      }
    },
    async commitApplicationMetadata(expectedRevision: number, bytes: Uint8Array | null) {
      commitCalls += 1
      if (expectedRevision !== applicationRevision) return { status: 'stale-revision' as const }
      if (failFinalCommit && commitCalls === 3) return { status: 'unavailable' as const }
      applicationRevision += 1
      applicationBytes?.fill(0)
      applicationBytes = bytes ? Uint8Array.from(bytes) : null
      return {
        status: 'ok' as const,
        revision: applicationRevision,
        bytes: applicationBytes ? Uint8Array.from(applicationBytes) : null
      }
    }
  } as unknown as IncrementalMeetingJournalFileStorage
  const appender = {
    async append(bytes: Uint8Array, expectedRevision: number) {
      const text = new TextDecoder().decode(bytes)
      const record = JSON.parse(text) as { identity: { recordId: string }; line: TranscriptLine }
      const previous = records.get(record.identity.recordId)
      if (previous)
        return previous === text
          ? { status: 'durable' as const, revision: snapshot.durableRevision, duplicate: true }
          : { status: 'refused' as const, reason: 'CONFLICTING_IDENTITY' as const }
      if (expectedRevision !== snapshot.durableRevision)
        return { status: 'refused' as const, reason: 'STALE_REVISION' as const }
      records.set(record.identity.recordId, text)
      const lineBytes = Buffer.byteLength(record.line.text, 'utf8')
      snapshot = {
        ...snapshot,
        acceptedRevision: snapshot.durableRevision + 1,
        durableRevision: snapshot.durableRevision + 1,
        recordCount: snapshot.recordCount + 1,
        wordCount: snapshot.wordCount + record.line.text.trim().split(/\s+/).filter(Boolean).length,
        linePayloadBytes: snapshot.linePayloadBytes + lineBytes
      }
      return { status: 'durable' as const, revision: snapshot.durableRevision, duplicate: false }
    }
  } as IncrementalMeetingAppender
  const session: ImportJournalSession = {
    jobId: JOB_ID,
    meetingId: MEETING_ID,
    journalId: '33333333-3333-4333-8333-333333333333',
    keyId: 'key_1',
    owner: { profileNamespace: 'profile_1', principalAssociation: 'principal_1', generation: 'generation_1' },
    source: {
      canonicalPath: '/private/audio.wav',
      device: '1',
      inode: '2',
      size: 42,
      mtimeNs: '3',
      ctimeNs: '4'
    },
    policy: policy(),
    storage,
    appender,
    assertCurrent() {},
    retire: vi.fn(),
    settle: vi.fn(async () => {})
  }
  const runtime = {
    async createNew(_header: ImportJobHeader, _origin: ImportLegacyOriginHandle, journalId: string) {
      return { ...session, journalId }
    },
    async openExisting() {
      failFinalCommit = false
      return session
    },
    async listHeldIds() {
      return { jobIds: [], overflow: false }
    },
    assertOriginCurrent() {}
  }
  return {
    repository: createImportJournalCheckpointRepository(runtime),
    session,
    records,
    getSnapshot: () => snapshot,
    async injectMetadata(bytes: Uint8Array) {
      const result = await storage.commitApplicationMetadata(applicationRevision, bytes, 8192, () => true)
      if (result.status === 'ok') result.bytes?.fill(0)
    }
  }
}

function header(): ImportJobHeader {
  return {
    jobId: JOB_ID,
    sourcePath: '/private/audio.wav',
    sourceName: 'audio.wav',
    sourceSizeBytes: 42,
    sourceMtimeMs: 3,
    title: 'Interview',
    state: 'failed',
    cursor: 0,
    totalChunks: 1,
    createdAt: 1,
    updatedAt: 1
  } as ImportJobHeader
}

describe('import journal checkpoint repository', () => {
  it('replays an appended pending window after a crash before cursor CAS, then advances once', async () => {
    const f = fixture()
    const created = await f.repository.createNew(header(), ORIGIN)
    expect(created.status).toBe('ready')
    if (created.status !== 'ready') return
    const checkpoint = created.checkpoint
    const change = {
      expectedCursor: 0,
      nextCursor: 1,
      record: { speaker: 'unknown', text: 'bounded speech', t: 1_700_000_000_000 } as TranscriptLine,
      headerPatch: { cursor: 1, totalChunks: 1, updatedAt: 2 }
    }

    const interrupted = await f.repository.appendWindow(checkpoint, change, ORIGIN)
    expect(interrupted.status).toBe('held')
    expect(f.getSnapshot().durableRevision).toBe(1)
    expect(f.records.size).toBe(1)
    await f.repository.retire(checkpoint.transcript)
    await f.repository.settle(checkpoint.transcript)

    const resumed = await f.repository.resume(JOB_ID, ORIGIN)
    expect(resumed.status).toBe('ready')
    if (resumed.status !== 'ready') return
    const retried = await f.repository.appendWindow(resumed.checkpoint, change, ORIGIN)
    expect(retried.status).toBe('ready')
    if (retried.status !== 'ready') return
    expect(retried.checkpoint.frontier).toMatchObject({ revision: 1, recordCount: 1, cursor: 1 })
    expect(f.records.size).toBe(1)
    expect(f.getSnapshot().durableRevision).toBe(1)
  })

  it('rejects metadata with unknown fields before returning a checkpoint', async () => {
    const f = fixture()
    const created = await f.repository.createNew(header(), ORIGIN)
    expect(created.status).toBe('ready')
    await f.injectMetadata(new TextEncoder().encode('{"unexpected":true}'))
    await expect(f.repository.resume(JOB_ID, ORIGIN)).resolves.toEqual({ status: 'held', reason: 'MALFORMED' })
  })
})
