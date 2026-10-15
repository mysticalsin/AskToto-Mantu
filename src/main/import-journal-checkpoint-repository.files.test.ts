import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SpeechProvenanceLimits } from '@shared/meeting-speech-contract'
import type { TranscriptLine } from '@shared/ipc'
import { createStorageGateway } from './infra/storage/gateway'
import type { ContentPresence, DatalessDetector } from './infra/storage/dataless'
import {
  createIncrementalMeetingAppender,
  type IncrementalJournalLimits
} from './features/meetings/incremental-meeting-journal'
import { createIncrementalMeetingJournalFileStorage } from './features/meetings/incremental-meeting-journal-files'
import { canonicalizeIncrementalMeetingRecord } from './infra/process/incremental-record-canonical'
import { issueIncrementalRecordReceipt } from './infra/process/incremental-record-receipt'
import type { ImportJobHeader } from './import-job-checkpoint-contract'
import type { ImportLegacyOriginHandle } from './import-legacy-origin'
import type { ImportPersistencePolicy } from './import-persistence-policy'
import {
  createImportJournalCheckpointRepository,
  type ImportJournalCheckpointRuntime,
  type ImportJournalSession
} from './import-journal-checkpoint-repository'

const jobId = '11111111-1111-4111-8111-111111111111'
const origin = Object.freeze({}) as ImportLegacyOriginHandle
const key = Uint8Array.from({ length: 32 }, (_, index) => index + 1)
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function policy(): ImportPersistencePolicy {
  return {
    revision: 'physical-test-policy',
    speech: { maxRecords: 10, maxWords: 100, maxFieldBytes: 2048, maxRecordBytes: 8192, maxPayloadBytes: 16384 },
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
      maxJournalBytes: 65536,
      maxPhysicalRecordBytes: 16384,
      maxChunkBytes: 1024,
      maxPageRecords: 4,
      maxPageBytes: 32768
    },
    worker: { maxInputBytes: 8192, maxOutputBytes: 8192, operationDeadlineMs: 1000, shutdownDeadlineMs: 1000 },
    consumers: { maxPublicExportBytes: 8192, maxRecapInputBytes: 8192, maxRecapOutputBytes: 1024 }
  }
}

function detector(): DatalessDetector {
  return { classify: async (files) => new Map(files.map((file): [string, ContentPresence] => [file.path, 'local'])) }
}

function header(sourcePath: string): ImportJobHeader {
  return {
    jobId,
    sourcePath,
    sourceName: 'audio.wav',
    sourceSizeBytes: 42,
    sourceMtimeMs: 3,
    title: 'Physical recovery',
    state: 'failed',
    cursor: 0,
    totalChunks: 1,
    createdAt: 1,
    updatedAt: 1
  } as ImportJobHeader
}

async function receipt(input: Uint8Array, binding: Parameters<typeof issueIncrementalRecordReceipt>[1]) {
  const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(input))
  const canonical = canonicalizeIncrementalMeetingRecord(value, binding.limits, binding.maxCanonicalBytes)
  if (!canonical.ok) throw new Error('Valid physical fixture was refused by canonicalization.')
  const result = issueIncrementalRecordReceipt(canonical.value, binding)
  if (!result) throw new Error('Valid physical fixture did not produce a receipt.')
  return result
}

describe('encrypted import checkpoint repository recovery', () => {
  it('reopens a committed window from physical journal files without reappending its transcript', async () => {
    const root = await mkdtemp(join(tmpdir(), 'metis-import-checkpoint-recovery-'))
    roots.push(root)
    const configured = policy()
    let failCursorCommit = true
    const createSession = (meetingId: string, shouldFailCursorCommit: boolean): ImportJournalSession => {
      const gateway = createStorageGateway({ root: () => root, detector: detector() })
      const physical = createIncrementalMeetingJournalFileStorage({
        root,
        meetingId,
        key: Uint8Array.from(key),
        maxJournalBytes: configured.journal.maxJournalBytes,
        maxPhysicalRecordBytes: configured.journal.maxPhysicalRecordBytes,
        maxChunkBytes: configured.journal.maxChunkBytes,
        maxPageRecords: configured.journal.maxPageRecords,
        maxPageBytes: configured.journal.maxPageBytes,
        isCurrent: () => true,
        gateway
      })
      if (!physical) throw new Error('Physical file journal should be configured.')
      const storage = {
        ...physical,
        async commitApplicationMetadata(
          expectedRevision: number,
          bytes: Uint8Array | null,
          maxBytes: number,
          isCurrent: () => boolean
        ) {
          if (shouldFailCursorCommit && failCursorCommit && expectedRevision === 2) {
            failCursorCommit = false
            return { status: 'unavailable' as const }
          }
          return physical.commitApplicationMetadata(expectedRevision, bytes, maxBytes, isCurrent)
        }
      }
      const journalLimits: IncrementalJournalLimits & SpeechProvenanceLimits = {
        ...configured.speech,
        maxJournalBytes: configured.journal.maxJournalBytes
      }
      const appender = createIncrementalMeetingAppender({
        meetingId,
        readLimits: () => journalLimits,
        isCurrent: () => true,
        canonicalizeRecord: receipt,
        storage
      })
      return {
        jobId,
        meetingId,
        journalId: meetingId,
        keyId: 'key_1',
        owner: { profileNamespace: 'profile_1', principalAssociation: 'principal_1', generation: 'generation_1' },
        source: {
          canonicalPath: resolve(join(root, 'audio.wav')),
          device: '1',
          inode: '2',
          size: 42,
          mtimeNs: '3',
          ctimeNs: '4'
        },
        policy: configured,
        storage,
        appender,
        assertCurrent() {},
        retire() {
          storage.dispose()
        },
        async settle() {
          storage.dispose()
        }
      }
    }
    let active: ImportJournalSession | undefined
    const runtime: ImportJournalCheckpointRuntime = {
      async createNew(_header, _origin, journalId) {
        active = createSession(journalId, true)
        return active
      },
      async openExisting() {
        if (!active) throw new Error('Missing checkpoint session.')
        active = createSession(active.meetingId, false)
        return active
      },
      async listHeldIds() {
        return { jobIds: [], overflow: false }
      },
      assertOriginCurrent() {}
    }
    const repository = createImportJournalCheckpointRepository(runtime)
    const sourcePath = resolve(join(root, 'audio.wav'))
    const created = await repository.createNew(header(sourcePath), origin)
    expect(created.status).toBe('ready')
    if (created.status !== 'ready') return
    const beforeAdmission = await active!.storage.readApplicationMetadata(() => true)
    expect(beforeAdmission.status).toBe('ok')
    const invalidAdmission = await repository.appendWindow(
      created.checkpoint,
      {
        expectedCursor: 0,
        nextCursor: 1,
        record: { speaker: 'unknown', text: 'x'.repeat(configured.speech.maxFieldBytes + 1), t: 1 } as TranscriptLine,
        headerPatch: { cursor: 1, totalChunks: 1, updatedAt: 2 }
      },
      origin
    )
    expect(invalidAdmission).toEqual({ status: 'held', reason: 'RESOURCE_LIMIT' })
    await expect(active!.storage.readApplicationMetadata(() => true)).resolves.toEqual(beforeAdmission)
    await expect(active!.storage.readSnapshot(active!.meetingId, () => true)).resolves.toMatchObject({
      status: 'ok',
      snapshot: { durableRevision: 0, recordCount: 0 }
    })
    if (beforeAdmission.status === 'ok') beforeAdmission.bytes?.fill(0)
    const change = {
      expectedCursor: 0,
      nextCursor: 1,
      record: {
        speaker: 'unknown',
        text: 'Use <tag> & "quotes"\n café\t ready',
        t: 1_700_000_000_000
      } as TranscriptLine,
      headerPatch: { cursor: 1, totalChunks: 1, updatedAt: 2 }
    }
    await expect(repository.appendWindow(created.checkpoint, change, origin)).resolves.toMatchObject({
      status: 'held',
      reason: 'UNAVAILABLE'
    })
    const physicalSession = active
    expect(physicalSession).toBeDefined()
    const snapshot = await physicalSession!.storage.readSnapshot(physicalSession!.meetingId, () => true)
    expect(snapshot).toMatchObject({ status: 'ok', snapshot: { durableRevision: 1, recordCount: 1 } })
    await repository.retire(created.checkpoint.transcript)
    await repository.settle(created.checkpoint.transcript)

    const resumed = await repository.resume(jobId, origin)
    expect(resumed.status).toBe('ready')
    if (resumed.status !== 'ready') return
    expect(resumed.checkpoint.frontier).toMatchObject({ revision: 1, recordCount: 1, cursor: 1 })
    expect(resumed.checkpoint.header.totalChunks).toBe(1)
    const page: TranscriptLine[] = []
    await expect(
      repository.readPage(
        resumed.checkpoint.transcript,
        { maxRecords: 1, maxBytes: configured.journal.maxPageBytes },
        origin,
        {
          async write(line) {
            page.push(line)
          }
        }
      )
    ).resolves.toMatchObject({ records: 1, nextRecordId: '1', complete: true })
    expect(page).toEqual([change.record])
    await repository.settle(resumed.checkpoint.transcript)
  })
})
