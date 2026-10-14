import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SpeechProvenanceLimits } from '@shared/meeting-speech-contract'
import { canonicalizeIncrementalMeetingRecord } from './incremental-record-canonical'
import { createStorageGateway } from '../../infra/storage/gateway'
import type { ContentPresence, DatalessDetector } from '../../infra/storage/dataless'
import {
  createIncrementalMeetingAppender,
  type IncrementalJournalLimits,
  type IncrementalMeetingJournalStorage
} from './incremental-meeting-journal'
import { createIncrementalMeetingJournalFileStorage } from './incremental-meeting-journal-files'
import { issueIncrementalRecordReceipt } from './incremental-record-receipt'
import { encodeIndex, identityHash } from './incremental-meeting-journal-format'
import type { StorageGateway } from '../../infra/storage/gateway'

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
  const result = canonicalizeIncrementalMeetingRecord(source, limits, limits.maxRecordBytes)
  if (!result.ok) throw new Error('test worker canonicalization should accept its valid fixture')
  const receipt = issueIncrementalRecordReceipt(result.value, binding)
  if (!receipt) throw new Error('test worker canonicalization should issue its validated receipt')
  return receipt
}

async function store(
  root: string,
  current: () => boolean = () => true,
  suppliedKey = key,
  gatewayOverride?: StorageGateway,
  maxPageBytes = 32_768,
  maxPhysicalRecordBytes = 16_384
) {
  const gateway = gatewayOverride ?? createStorageGateway({ root: () => root, detector: detector() })
  const storage = createIncrementalMeetingJournalFileStorage({
    root,
    meetingId,
    key: Uint8Array.from(suppliedKey),
    maxJournalBytes: limits.maxJournalBytes,
    maxPhysicalRecordBytes,
    maxChunkBytes: 1_024,
    maxPageRecords: 4,
    maxPageBytes,
    isCurrent: current,
    gateway
  })
  if (!storage) throw new Error('file journal configuration should be valid')
  return storage
}

function appender(storage: IncrementalMeetingJournalStorage | undefined, isCurrent: () => boolean = () => true) {
  if (!storage) throw new Error('file journal configuration should be valid')
  return createIncrementalMeetingAppender({
    meetingId,
    readLimits: () => limits,
    isCurrent,
    canonicalizeRecord: workerReceipt,
    storage
  })
}

describe('encrypted incremental meeting journal files', () => {
  it('persists an authenticated frontier and encrypted immutable record for exact retry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'metis-incremental-files-'))
    roots.push(root)
    const first = await store(root)
    await expect(first.initialize()).resolves.toMatchObject({
      status: 'ok',
      snapshot: { state: 'active', acceptedRevision: 0, durableRevision: 0, recordCount: 0 }
    })
    await expect(appender(first).append(recordJson, 0)).resolves.toMatchObject({
      status: 'durable',
      revision: 1,
      duplicate: false
    })
    const names = await readdir(root)
    const recordName = names.find((name) => name.startsWith('record-'))
    expect(recordName).toBeDefined()
    const recordFile = await readFile(join(root, recordName!))
    expect(recordFile.includes(Buffer.from('private'))).toBe(false)
    first.dispose()

    const reopened = await store(root)
    await expect(reopened.initialize()).resolves.toMatchObject({
      status: 'ok',
      snapshot: { acceptedRevision: 1, durableRevision: 1, recordCount: 1, wordCount: 0 }
    })
    const projected: Uint8Array[] = []
    await expect(
      reopened.readPage(
        0,
        1,
        1,
        (record) => {
          projected.push(Uint8Array.from(record.canonicalBytes))
        },
        () => true
      )
    ).resolves.toEqual({ status: 'ok', nextRevision: 1, durableRevision: 1, complete: true })
    expect(Buffer.concat(projected.map((bytes) => Buffer.from(bytes))).toString('utf8')).toContain('"text":"private"')
    await expect(appender(reopened).append(recordJson, 0)).resolves.toEqual({
      status: 'durable',
      revision: 1,
      duplicate: true
    })
    reopened.dispose()
  })

  it('refuses a tampered manifest and a key from another meeting owner', async () => {
    const root = await mkdtemp(join(tmpdir(), 'metis-incremental-tamper-'))
    roots.push(root)
    const first = await store(root)
    await first.initialize()
    first.dispose()
    const wrongKey = await store(
      root,
      () => true,
      Uint8Array.from({ length: 32 }, () => 99)
    )
    await expect(wrongKey.initialize()).resolves.toEqual({ status: 'unavailable' })
    wrongKey.dispose()
    const authorized = await store(root)
    expect(await readdir(root)).toContain('manifest.v1')
    const manifestPath = join(root, 'manifest.v1')
    const manifest = await readFile(manifestPath)
    manifest[manifest.length - 2] ^= 1
    await writeFile(manifestPath, manifest)
    authorized.dispose()

    const tampered = await store(root)
    await expect(tampered.initialize()).resolves.toEqual({ status: 'unavailable' })
    tampered.dispose()
  })

  it('does not initialize after its captured owner becomes stale', async () => {
    const root = await mkdtemp(join(tmpdir(), 'metis-incremental-stale-'))
    roots.push(root)
    let current = true
    const stale = await store(root, () => current)
    current = false
    await expect(stale.initialize()).resolves.toEqual({ status: 'unavailable' })
    expect(await readdir(root)).toEqual([])
    stale.dispose()
  })

  it('serializes two adapters for the same meeting through the durable frontier CAS', async () => {
    const root = await mkdtemp(join(tmpdir(), 'metis-incremental-race-'))
    roots.push(root)
    let releaseFirst!: () => void
    let startedFirst!: () => void
    let markSecondLookup!: () => void
    const firstWriteStarted = new Promise<void>((resolve) => (startedFirst = resolve))
    const releaseWrite = new Promise<void>((resolve) => (releaseFirst = resolve))
    const secondLookupDone = new Promise<void>((resolve) => (markSecondLookup = resolve))
    const gateGateway = createStorageGateway({ root: () => root, detector: detector() })
    const gatedGateway = {
      ...gateGateway,
      classify: async (paths: readonly string[]) => {
        if (paths.some((path) => path.startsWith('record-'))) {
          startedFirst()
          await releaseWrite
        }
        return gateGateway.classify(paths)
      }
    }
    const first = createIncrementalMeetingJournalFileStorage({
      root,
      meetingId,
      key: Uint8Array.from(key),
      maxJournalBytes: limits.maxJournalBytes,
      maxPhysicalRecordBytes: 16_384,
      maxChunkBytes: 1_024,
      maxPageRecords: 4,
      maxPageBytes: 32_768,
      isCurrent: () => true,
      gateway: gatedGateway
    })
    const second = await store(root)
    if (!first) throw new Error('file journal configuration should be valid')
    await first.initialize()
    const secondStorage: IncrementalMeetingJournalStorage = {
      ...second,
      async lookupIdentity(...args) {
        const result = await second.lookupIdentity(...args)
        markSecondLookup()
        return result
      }
    }
    const firstAppend = appender(first).append(recordJson, 0)
    await firstWriteStarted
    const secondAppend = appender(secondStorage).append(recordJson, 0)
    await secondLookupDone
    releaseFirst()
    await expect(firstAppend).resolves.toMatchObject({ status: 'durable', revision: 1, duplicate: false })
    await expect(secondAppend).resolves.toEqual({ status: 'refused', reason: 'STALE_REVISION' })
    await expect(second.readSnapshot(meetingId, () => true)).resolves.toMatchObject({
      status: 'ok',
      snapshot: { acceptedRevision: 1, durableRevision: 1, recordCount: 1 }
    })
    first.dispose()
    second.dispose()
  })

  it('serializes append and terminal transition so the terminal state cannot roll back the new frontier', async () => {
    const root = await mkdtemp(join(tmpdir(), 'metis-incremental-terminal-race-'))
    roots.push(root)
    let releaseFirst!: () => void
    let startedFirst!: () => void
    const firstWriteStarted = new Promise<void>((resolve) => (startedFirst = resolve))
    const releaseWrite = new Promise<void>((resolve) => (releaseFirst = resolve))
    const base = createStorageGateway({ root: () => root, detector: detector() })
    const gated: StorageGateway = {
      ...base,
      async classify(paths, options) {
        if (paths.some((path) => path.startsWith('record-'))) {
          startedFirst()
          await releaseWrite
        }
        return base.classify(paths, options)
      }
    }
    const first = await store(root, () => true, key, gated)
    const second = await store(root)
    await first.initialize()
    const appending = appender(first).append(recordJson, 0)
    await firstWriteStarted
    const finalizing = second.transitionState('finalized', () => true)
    releaseFirst()
    await expect(appending).resolves.toMatchObject({ status: 'durable', revision: 1, duplicate: false })
    await expect(finalizing).resolves.toBe('committed')
    await expect(second.readSnapshot(meetingId, () => true)).resolves.toMatchObject({
      status: 'ok',
      snapshot: { state: 'finalized', acceptedRevision: 1, durableRevision: 1, recordCount: 1 }
    })
    first.dispose()
    second.dispose()
  })

  it('accepts only one terminal transition from the active state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'metis-incremental-terminal-single-'))
    roots.push(root)
    const storage = await store(root)
    await storage.initialize()
    await expect(storage.transitionState('finalized', () => true)).resolves.toBe('committed')
    await expect(storage.transitionState('discarded', () => true)).resolves.toBe('unavailable')
    await expect(storage.readSnapshot(meetingId, () => true)).resolves.toMatchObject({
      status: 'ok',
      snapshot: { state: 'finalized', acceptedRevision: 0 }
    })
    storage.dispose()
  })

  it('refuses omitted record classification instead of treating it as an absent path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'metis-incremental-classification-'))
    roots.push(root)
    const base = createStorageGateway({ root: () => root, detector: detector() })
    const gateway: StorageGateway = {
      ...base,
      async classify(paths, options) {
        const result = await base.classify(paths, options)
        if (!paths.some((path) => path.startsWith('record-'))) return result
        return new Map([...result].filter(([path]) => !path.startsWith('record-')))
      }
    }
    const storage = await store(root, () => true, key, gateway)
    await storage.initialize()
    await expect(appender(storage).append(recordJson, 0)).resolves.toEqual({
      status: 'refused',
      reason: 'UNAVAILABLE'
    })
    expect((await readdir(root)).some((name) => name.startsWith('record-'))).toBe(false)
    storage.dispose()
  })

  it('rejects a validly authenticated index/record digest mismatch on duplicate lookup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'metis-incremental-index-digest-'))
    roots.push(root)
    const storage = await store(root)
    await storage.initialize()
    await expect(appender(storage).append(recordJson, 0)).resolves.toMatchObject({ status: 'durable', revision: 1 })
    const identityKey = JSON.stringify({ kind: 'local', recordId: '6370e1cc-43f4-4976-a912-04d0c3ca8f9f' })
    const identity = identityHash(identityKey, Buffer.from(key))
    const mismatch = 'f'.repeat(64)
    const revisionPath = join(root, 'index-000000000001.v1')
    const identityPath = join(root, `identity-${identity}.v1`)
    const revisionEntry = JSON.parse((await readFile(revisionPath)).toString('utf8'))
    const identityEntry = JSON.parse((await readFile(identityPath)).toString('utf8'))
    await writeFile(
      revisionPath,
      encodeIndex(
        {
          version: 1,
          meetingId,
          revision: 1,
          identityHash: identity,
          sha256: mismatch,
          recordBytes: revisionEntry.recordBytes
        },
        Buffer.from(key)
      )
    )
    await writeFile(
      identityPath,
      encodeIndex(
        {
          version: 1,
          meetingId,
          revision: 1,
          identityHash: identity,
          sha256: mismatch,
          recordBytes: identityEntry.recordBytes
        },
        Buffer.from(key)
      )
    )
    await expect(appender(storage).append(recordJson, 1)).resolves.toEqual({
      status: 'refused',
      reason: 'UNAVAILABLE'
    })
    storage.dispose()
  })

  it('refuses a page whose authenticated record exceeds the page-byte budget before reading record bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'metis-incremental-page-bound-'))
    roots.push(root)
    const initial = await store(root)
    await initial.initialize()
    await appender(initial).append(recordJson, 0)
    initial.dispose()
    const recordFile = await readFile(join(root, (await readdir(root)).find((name) => name.startsWith('record-'))!))
    const indexFile = await readFile(join(root, 'index-000000000001.v1'))
    let recordReads = 0
    const base = createStorageGateway({ root: () => root, detector: detector() })
    const tracking: StorageGateway = {
      ...base,
      stream(relPath, sink, options) {
        if (relPath.startsWith('record-')) recordReads++
        return base.stream(relPath, sink, options)
      }
    }
    const bounded = await store(root, () => true, key, tracking, recordFile.byteLength + indexFile.byteLength - 1)
    await expect(
      bounded.readPage(
        0,
        1,
        1,
        () => undefined,
        () => true
      )
    ).resolves.toEqual({
      status: 'unavailable'
    })
    expect(recordReads).toBe(0)
    bounded.dispose()
  })

  it('snapshots page limits and gateway methods before the caller can mutate its options', async () => {
    const root = await mkdtemp(join(tmpdir(), 'metis-incremental-option-snapshot-'))
    roots.push(root)
    const initial = await store(root)
    await initial.initialize()
    await appender(initial).append(recordJson, 0)
    initial.dispose()

    const indexBytes = (await readFile(join(root, 'index-000000000001.v1'))).byteLength
    const recordName = (await readdir(root)).find((name) => name.startsWith('record-'))!
    const recordBytes = (await readFile(join(root, recordName))).byteLength
    const base = createStorageGateway({ root: () => root, detector: detector() })
    let originalStreamCalls = 0
    const gateway: StorageGateway = {
      ...base,
      stream(relPath, sink, streamOptions) {
        originalStreamCalls++
        return base.stream(relPath, sink, streamOptions)
      }
    }
    const mutableOptions = {
      root,
      meetingId,
      key: Uint8Array.from(key),
      maxJournalBytes: limits.maxJournalBytes,
      maxPhysicalRecordBytes: 16_384,
      maxChunkBytes: 1_024,
      maxPageRecords: 4,
      maxPageBytes: indexBytes + recordBytes - 1,
      isCurrent: () => true,
      gateway
    }
    const bounded = createIncrementalMeetingJournalFileStorage(mutableOptions)
    expect(bounded).toBeDefined()
    mutableOptions.maxPageBytes = limits.maxJournalBytes
    gateway.stream = async () => ({ status: 'unavailable', code: 'REPLACED' })
    await expect(
      bounded!.readPage(
        0,
        1,
        1,
        () => undefined,
        () => true
      )
    ).resolves.toEqual({
      status: 'unavailable'
    })
    expect(originalStreamCalls).toBe(2)
    bounded!.dispose()

    let adequateOriginalStreamCalls = 0
    const adequateGateway: StorageGateway = {
      ...base,
      stream(relPath, sink, streamOptions) {
        adequateOriginalStreamCalls++
        return base.stream(relPath, sink, streamOptions)
      }
    }
    const adequateOptions = {
      ...mutableOptions,
      key: Uint8Array.from(key),
      gateway: adequateGateway,
      maxPageBytes: limits.maxJournalBytes
    }
    const adequate = createIncrementalMeetingJournalFileStorage(adequateOptions)
    expect(adequate).toBeDefined()
    adequateOptions.maxPageBytes = 1
    adequateGateway.stream = async () => ({ status: 'unavailable', code: 'REPLACED' })
    await expect(
      adequate!.readPage(
        0,
        1,
        1,
        () => undefined,
        () => true
      )
    ).resolves.toMatchObject({
      status: 'ok',
      nextRevision: 1
    })
    expect(adequateOriginalStreamCalls).toBe(3)
    adequate!.dispose()
  })

  it('refuses an authenticated over-cap physical record before opening its payload', async () => {
    const root = await mkdtemp(join(tmpdir(), 'metis-incremental-record-bound-'))
    roots.push(root)
    const initial = await store(root)
    await initial.initialize()
    await appender(initial).append(recordJson, 0)
    initial.dispose()
    const identityKey = JSON.stringify({ kind: 'local', recordId: '6370e1cc-43f4-4976-a912-04d0c3ca8f9f' })
    const identity = identityHash(identityKey, Buffer.from(key))
    const overCap = 16_385
    const indexPath = join(root, 'index-000000000001.v1')
    const identityPath = join(root, `identity-${identity}.v1`)
    for (const path of [indexPath, identityPath]) {
      const prior = JSON.parse((await readFile(path)).toString('utf8'))
      await writeFile(
        path,
        encodeIndex(
          {
            version: 1,
            meetingId,
            revision: 1,
            identityHash: identity,
            sha256: prior.sha256,
            recordBytes: overCap
          },
          Buffer.from(key)
        )
      )
    }
    let recordReads = 0
    const base = createStorageGateway({ root: () => root, detector: detector() })
    const tracking: StorageGateway = {
      ...base,
      stream(relPath, sink, options) {
        if (relPath.startsWith('record-')) recordReads++
        return base.stream(relPath, sink, options)
      }
    }
    const bounded = await store(root, () => true, key, tracking)
    await expect(appender(bounded).append(recordJson, 1)).resolves.toEqual({
      status: 'refused',
      reason: 'UNAVAILABLE'
    })
    expect(recordReads).toBe(0)
    bounded.dispose()
  })
})
