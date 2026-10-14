import { describe, expect, it, vi } from 'vitest'
import type { TranscriptLine } from '@shared/ipc'
import type {
  IncrementalMeetingAppender,
  IncrementalJournalSnapshot
} from './features/meetings/incremental-meeting-journal'
import type {
  IncrementalJournalFileRecord,
  IncrementalMeetingJournalFileStorage
} from './features/meetings/incremental-meeting-journal-files'
import type { ImportCheckpoint, ImportJobHeader } from './import-job-checkpoint-contract'
import type { ImportLegacyOriginHandle } from './import-legacy-origin'
import type { ImportPersistencePolicy } from './import-persistence-policy'
import {
  createImportJournalCheckpointRepository,
  type ImportJournalSession
} from './import-journal-checkpoint-repository'

const JOB_ID = '11111111-1111-4111-8111-111111111111'
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
  let failFinalCommitAt = 3
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
    async readPendingAppend() {
      return 'clear' as const
    },
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
    async readPage(
      afterRevision: number,
      expectedRevision: number,
      _maxRecords: number,
      sink: (record: IncrementalJournalFileRecord) => void | Promise<void>
    ) {
      if (expectedRevision !== snapshot.durableRevision) return { status: 'unavailable' as const }
      for (let revision = afterRevision + 1; revision <= expectedRevision; revision += 1) {
        const encoded = [...records.values()][revision - 1]
        if (!encoded) return { status: 'unavailable' as const }
        const record = JSON.parse(encoded)
        await sink({
          revision,
          ...record,
          identityKey: record.identity.recordId,
          sha256: '0'.repeat(64),
          clock: '0',
          wordCount: record.line.text.trim().split(/\s+/).filter(Boolean).length,
          linePayloadBytes: Buffer.byteLength(record.line.text, 'utf8'),
          canonicalBytes: new TextEncoder().encode(encoded)
        })
      }
      return {
        status: 'ok' as const,
        nextRevision: expectedRevision,
        durableRevision: expectedRevision,
        complete: true
      }
    },
    async commitApplicationMetadata(expectedRevision: number, bytes: Uint8Array | null) {
      commitCalls += 1
      if (expectedRevision !== applicationRevision) return { status: 'stale-revision' as const }
      if (failFinalCommit && commitCalls === failFinalCommitAt) return { status: 'unavailable' as const }
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
    meetingId: '33333333-3333-4333-8333-333333333333',
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
  let storedSession: ImportJournalSession = session
  const runtime = {
    async createNew(_header: ImportJobHeader, _origin: ImportLegacyOriginHandle, journalId: string) {
      storedSession = { ...session, meetingId: journalId, journalId }
      return storedSession
    },
    async openExisting() {
      failFinalCommit = false
      return storedSession
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
    failFinalCommitAt(call: number) {
      failFinalCommitAt = call
    },
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
  it('recovers a durable pending record and advances its cursor without retranscribing', async () => {
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
    expect(resumed.checkpoint.frontier).toMatchObject({ revision: 1, recordCount: 1, cursor: 1 })
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

  it('normalizes totalChunks across transcript and silent window commits', async () => {
    const f = fixture()
    const created = await f.repository.createNew(header(), ORIGIN)
    expect(created.status).toBe('ready')
    if (created.status !== 'ready') return
    const initialized = await f.repository.saveHeader(
      created.checkpoint,
      { totalChunks: 10, cursor: 0, updatedAt: 2 },
      ORIGIN
    )
    expect(initialized.status).toBe('ready')
    if (initialized.status !== 'ready') return
    f.failFinalCommitAt(4)
    const transcriptChange = {
      expectedCursor: 0,
      nextCursor: 1,
      record: { speaker: 'unknown', text: 'bounded speech', t: 1_700_000_000_000 } as TranscriptLine,
      headerPatch: { cursor: 1, totalChunks: 9, updatedAt: 2 }
    }
    const first = await f.repository.appendWindow(initialized.checkpoint, transcriptChange, ORIGIN)
    expect(first.status).toBe('held')
    if (first.status !== 'held') return
    // The fixture injects one crash at the final CAS; retrying the same identity completes it.
    const resumed = await f.repository.resume(JOB_ID, ORIGIN)
    expect(resumed.status).toBe('ready')
    if (resumed.status !== 'ready') return
    expect(resumed.checkpoint.header.totalChunks).toBe(10)
    const silent = await f.repository.appendWindow(
      resumed.checkpoint,
      {
        expectedCursor: 1,
        nextCursor: 2,
        record: null,
        headerPatch: { cursor: 2, totalChunks: 9, updatedAt: 3 }
      },
      ORIGIN
    )
    expect(silent.status).toBe('ready')
    if (silent.status === 'ready') expect(silent.checkpoint.header.totalChunks).toBe(10)
  })

  it('rejects over-cap transcript fields before reserving a pending cursor or appending', async () => {
    const f = fixture()
    const created = await f.repository.createNew(header(), ORIGIN)
    expect(created.status).toBe('ready')
    if (created.status !== 'ready') return
    const before = await f.session.storage.readApplicationMetadata(() => true)
    if (before.status !== 'ok') throw new Error('Fixture metadata should be readable.')
    const rejected = await f.repository.appendWindow(
      created.checkpoint,
      {
        expectedCursor: 0,
        nextCursor: 1,
        record: { speaker: 'unknown', text: 'x'.repeat(policy().speech.maxFieldBytes + 1), t: 1 } as TranscriptLine,
        headerPatch: { cursor: 1, totalChunks: 1, updatedAt: 2 }
      },
      ORIGIN
    )
    expect(rejected).toEqual({ status: 'held', reason: 'RESOURCE_LIMIT' })
    expect(f.records.size).toBe(0)
    await expect(f.session.storage.readApplicationMetadata(() => true)).resolves.toEqual(before)
    before.bytes?.fill(0)
  })

  it('rejects malformed progress before either silent or transcript cursor commits', async () => {
    const f = fixture()
    const created = await f.repository.createNew(header(), ORIGIN)
    expect(created.status).toBe('ready')
    if (created.status !== 'ready') return
    const before = await f.session.storage.readApplicationMetadata(() => true)
    if (before.status !== 'ok') throw new Error('Fixture metadata should be readable.')
    for (const record of [null, { speaker: 'unknown', text: 'speech', t: 1 } as TranscriptLine]) {
      const rejected = await f.repository.appendWindow(
        created.checkpoint,
        {
          expectedCursor: 0,
          nextCursor: 1,
          record,
          headerPatch: { cursor: 1, totalChunks: Number.POSITIVE_INFINITY, updatedAt: 2 }
        },
        ORIGIN
      )
      expect(rejected).toEqual({ status: 'held', reason: 'MALFORMED' })
    }
    expect(f.records.size).toBe(0)
    await expect(f.session.storage.readApplicationMetadata(() => true)).resolves.toEqual(before)
    before.bytes?.fill(0)
  })
})
