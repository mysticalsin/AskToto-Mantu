import { mkdtemp, readdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SpeechProvenanceLimits } from '@shared/meeting-speech-contract'
import { createStorageGateway } from '../../infra/storage/gateway'
import type { ContentPresence, DatalessDetector } from '../../infra/storage/dataless'
import { canonicalizeIncrementalMeetingRecord } from '../../infra/process/incremental-record-canonical'
import { createIncrementalMeetingAppender, type IncrementalJournalLimits } from './incremental-meeting-journal'
import { createIncrementalMeetingJournalFileStorage } from './incremental-meeting-journal-files'
import { issueIncrementalRecordReceipt } from '../../infra/process/incremental-record-receipt'

const meetingId = '64d5a603-0b18-4da5-8a3f-4a42c9d22031'
const recordJson = new TextEncoder().encode(
  JSON.stringify({
    identity: { kind: 'local', recordId: '6370e1cc-43f4-4976-a912-04d0c3ca8f9f' },
    source: 'local-final',
    line: { speaker: 'you', text: 'private', t: 1_700_000_000_000 }
  })
)
const key = Uint8Array.from({ length: 32 }, (_, index) => index + 1)
const limits: IncrementalJournalLimits & SpeechProvenanceLimits = {
  maxRecords: 8,
  maxWords: 64,
  maxFieldBytes: 2_048,
  maxRecordBytes: 8_192,
  maxPayloadBytes: 32_768,
  maxJournalBytes: 65_536
}
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function detector(): DatalessDetector {
  return { classify: async (files) => new Map(files.map((file): [string, ContentPresence] => [file.path, 'local'])) }
}

async function workerReceipt(input: Uint8Array, binding: Parameters<typeof issueIncrementalRecordReceipt>[1]) {
  const source = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(input)) as unknown
  const result = canonicalizeIncrementalMeetingRecord(source, binding.limits, binding.maxCanonicalBytes)
  if (!result.ok) throw new Error('test worker canonicalization should accept its valid fixture')
  const receipt = issueIncrementalRecordReceipt(result.value, binding)
  if (!receipt) throw new Error('test worker canonicalization should issue its validated receipt')
  return receipt
}

async function store(root: string) {
  const storage = createIncrementalMeetingJournalFileStorage({
    root,
    meetingId,
    key: Uint8Array.from(key),
    maxJournalBytes: limits.maxJournalBytes,
    maxPhysicalRecordBytes: 16_384,
    maxChunkBytes: 1_024,
    maxPageRecords: 4,
    maxPageBytes: 32_768,
    isCurrent: () => true,
    gateway: createStorageGateway({ root: () => root, detector: detector() })
  })
  if (!storage) throw new Error('file journal configuration should be valid')
  return storage
}

function appender(storage: Awaited<ReturnType<typeof store>>) {
  return createIncrementalMeetingAppender({
    meetingId,
    readLimits: () => limits,
    isCurrent: () => true,
    canonicalizeRecord: workerReceipt,
    storage
  })
}

describe('incremental journal canonical read aliases', () => {
  it('admits the retained canonical root for each fresh read-only adapter through a parent alias', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'metis-incremental-read-alias-'))
    roots.push(parent)
    const root = join(parent, 'journal')
    const writer = await store(root)
    await expect(writer.initialize()).resolves.toMatchObject({ status: 'ok' })
    await expect(appender(writer).append(recordJson, 0)).resolves.toEqual({
      status: 'durable',
      revision: 1,
      duplicate: false
    })
    writer.dispose()
    const names = (await readdir(root)).sort()
    const alias = join(parent, 'alias')
    await symlink(parent, alias, process.platform === 'win32' ? 'junction' : 'dir')
    const aliasedRoot = join(alias, 'journal')
    const snapshotReader = await store(aliasedRoot)
    const identityReader = await store(aliasedRoot)
    const pageReader = await store(aliasedRoot)
    const record = JSON.parse(new TextDecoder().decode(recordJson))
    try {
      await expect(snapshotReader.readSnapshot(meetingId, () => true)).resolves.toMatchObject({
        status: 'ok',
        snapshot: { acceptedRevision: 1, durableRevision: 1, recordCount: 1 }
      })
      await expect(
        identityReader.lookupIdentity(meetingId, JSON.stringify(record.identity), () => true)
      ).resolves.toMatchObject({
        status: 'found',
        revision: 1
      })
      const records: unknown[] = []
      await expect(
        pageReader.readPage(
          0,
          1,
          1,
          (value) => {
            records.push(JSON.parse(new TextDecoder().decode(value.canonicalBytes)))
          },
          () => true
        )
      ).resolves.toEqual({ status: 'ok', nextRevision: 1, durableRevision: 1, complete: true })
      expect(records).toEqual([record])
      expect((await readdir(root)).sort()).toEqual(names)
    } finally {
      snapshotReader.dispose()
      identityReader.dispose()
      pageReader.dispose()
    }
  })
})
