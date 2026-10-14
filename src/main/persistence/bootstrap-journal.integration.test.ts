import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { lstat, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { canonicalizeIncrementalMeetingRecord } from '../features/meetings/incremental-record-canonical'
import { createIncrementalMeetingAppender } from '../features/meetings/incremental-meeting-journal'
import { createIncrementalMeetingJournalFileStorage } from '../features/meetings/incremental-meeting-journal-files'
import { issueIncrementalRecordReceipt } from '../features/meetings/incremental-record-receipt'
import { createStorageGateway } from '../infra/storage/gateway'
import type { MeetingSpeechPersistenceService } from '../infra/process/meeting-speech-host'
import { RootRegistry, type RootScopeBinding } from './root-registry'
import { createProtectedMeetingKeys, type NativeKeyStore } from './protected-meeting-keys'

const aclHarness = vi.hoisted(() => ({
  prepare: null as ((path: string) => Promise<boolean>) | null,
  verify: null as ((path: string) => Promise<boolean>) | null
}))
vi.mock('../win-security', () => ({
  preparePrivateCurrentUserAcl: (path: string) => aclHarness.prepare?.(path) ?? Promise.resolve(true),
  verifyPrivateCurrentUserAcl: (path: string) => aclHarness.verify?.(path) ?? Promise.resolve(true)
}))

const limits = {
  maxRecords: 8,
  maxWords: 64,
  maxFieldBytes: 2_048,
  maxRecordBytes: 8_192,
  maxPayloadBytes: 32_768,
  maxJournalBytes: 65_536
}
const fixtureRecord = new TextEncoder().encode(
  JSON.stringify({
    identity: { kind: 'local', recordId: '6370e1cc-43f4-4976-a912-04d0c3ca8f9f' },
    source: 'local-final',
    line: { speaker: 'you', text: 'synthetic fixture', t: 1_700_000_000_000 }
  })
)
const fixtureMaster = Buffer.alloc(32, 0x3a)
const fixtureMarker = Buffer.from('ATKENC2\n')
let tempRoots: string[] = []

afterEach(async () => {
  fixtureMaster.fill(0x3a)
  await Promise.all(tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

function owner(generation: string, bindings: WeakMap<object, RootScopeBinding>) {
  const scope = Object.freeze({})
  let active = true
  bindings.set(
    scope,
    Object.freeze({
      profileNamespace: 'fixture-profile',
      principalAssociation: 'fixture-principal',
      generation,
      nativeKeyAccess: 'allowed',
      legacyFileKeyAccess: 'denied',
      maxHeldRoots: 2,
      isCurrent: () => active
    })
  )
  return { scope, retire: () => (active = false) }
}

function syntheticNativeKeyStore(): NativeKeyStore {
  return {
    selectedBackend: () => 'macos-keychain',
    wrap(encoded) {
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', fixtureMaster, iv)
      const ciphertext = Buffer.concat([cipher.update(encoded, 'utf8'), cipher.final()])
      return Buffer.concat([iv, cipher.getAuthTag(), ciphertext])
    },
    unwrap(wrapped) {
      const decipher = createDecipheriv('aes-256-gcm', fixtureMaster, wrapped.subarray(0, 12))
      decipher.setAuthTag(wrapped.subarray(12, 28))
      return Buffer.concat([decipher.update(wrapped.subarray(28)), decipher.final()]).toString('utf8')
    }
  }
}

function syntheticSpeech(): MeetingSpeechPersistenceService {
  return {
    async encryptEnvelopeV2(content, contentKey, iv, kLocal) {
      const cipher = createCipheriv('aes-256-gcm', contentKey, iv)
      const ciphertext = Buffer.concat([cipher.update(content, 'utf8'), cipher.final()])
      const envelope = Buffer.from(
        JSON.stringify({
          v: 2,
          iv: Buffer.from(iv).toString('base64'),
          tag: cipher.getAuthTag().toString('base64'),
          ct: ciphertext.toString('base64'),
          kLocal
        })
      )
      return Buffer.concat([fixtureMarker, envelope])
    },
    async decryptEnvelopeV2(envelope, contentKey, kLocal) {
      const decoded = JSON.parse(Buffer.from(envelope).subarray(fixtureMarker.length).toString('utf8')) as {
        v: number
        iv: string
        tag: string
        ct: string
        kLocal: string
      }
      if (decoded.v !== 2 || decoded.kLocal !== kLocal) throw new Error('synthetic envelope binding mismatch')
      const decipher = createDecipheriv('aes-256-gcm', contentKey, Buffer.from(decoded.iv, 'base64'))
      decipher.setAuthTag(Buffer.from(decoded.tag, 'base64'))
      return Buffer.concat([decipher.update(Buffer.from(decoded.ct, 'base64')), decipher.final()]).toString('utf8')
    }
  } as MeetingSpeechPersistenceService
}

async function canonicalReceipt(source: Uint8Array, binding: Parameters<typeof issueIncrementalRecordReceipt>[1]) {
  const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(source)) as unknown
  const canonical = canonicalizeIncrementalMeetingRecord(parsed, binding.limits, binding.maxCanonicalBytes)
  if (!canonical.ok) throw new Error('Synthetic journal fixture record was rejected')
  const receipt = issueIncrementalRecordReceipt(canonical.value, binding)
  if (!receipt) throw new Error('Synthetic journal fixture receipt was rejected')
  return receipt
}

describe('root, key and core journal integration fixture', () => {
  it('keeps a missing read-only core root missing', async () => {
    const base = await mkdtemp(join(tmpdir(), 'metis-main-journal-readonly-'))
    tempRoots.push(base)
    const missing = join(base, 'does-not-exist')
    const gateway = createStorageGateway({ root: () => missing })
    const storage = createIncrementalMeetingJournalFileStorage({
      root: missing,
      meetingId: '64d5a603-0b18-4da5-8a3f-4a42c9d22031',
      key: Uint8Array.from({ length: 32 }, (_, index) => index + 1),
      maxJournalBytes: limits.maxJournalBytes,
      maxPhysicalRecordBytes: 16_384,
      maxChunkBytes: 1_024,
      maxPageRecords: 4,
      maxPageBytes: 32_768,
      isCurrent: () => true,
      createRootIfMissing: false,
      gateway
    })
    expect(storage).toBeDefined()
    await expect(storage!.readSnapshot('64d5a603-0b18-4da5-8a3f-4a42c9d22031', () => true)).resolves.toMatchObject({
      status: 'unavailable'
    })
    await expect(lstat(missing)).rejects.toMatchObject({ code: 'ENOENT' })
    storage!.dispose()
  })

  it('creates, appends, closes and freshly reopens the same journal read-only', async () => {
    const base = await mkdtemp(join(tmpdir(), 'metis-main-journal-fixture-'))
    tempRoots.push(base)
    const bindings = new WeakMap<object, RootScopeBinding>()
    const firstOwner = owner('stable-journal-generation', bindings)
    const secondOwner = owner('stable-journal-generation', bindings)
    const roots = new RootRegistry({
      userDataRoot: () => base,
      resolveScope: (scope) => bindings.get(scope),
      bindGatewayRoot: async (root) => root.assertCurrent()
    })
    const keys = createProtectedMeetingKeys({
      roots,
      nativeKeyStore: syntheticNativeKeyStore(),
      speech: syntheticSpeech()
    })
    const meetingId = '64d5a603-0b18-4da5-8a3f-4a42c9d22031'
    const root = await roots.create(firstOwner.scope, meetingId)
    const writer = await roots.acquireWriter(firstOwner.scope, root)
    const key = await keys.create(firstOwner.scope, root, writer, 'stable-journal-generation')
    const gateway = createStorageGateway({
      root: () => join(root.meetingPath, 'journal'),
      detector: { classify: async (files) => new Map(files.map((file) => [file.path, 'local' as const])) }
    })
    const storage = await key.withKey((ownedKey) => {
      try {
        return createIncrementalMeetingJournalFileStorage({
          root: join(root.meetingPath, 'journal'),
          meetingId,
          key: ownedKey,
          maxJournalBytes: limits.maxJournalBytes,
          maxPhysicalRecordBytes: 16_384,
          maxChunkBytes: 1_024,
          maxPageRecords: 4,
          maxPageBytes: 32_768,
          isCurrent: () => {
            try {
              roots.assertScopeCurrent(firstOwner.scope, root)
              writer.assertCurrent()
              return true
            } catch {
              return false
            }
          },
          assertPhysicalCurrent: async () => {
            await root.assertPhysicalCurrent()
            await writer.assertPhysicalCurrent()
          },
          createRootIfMissing: true,
          gateway
        })
      } finally {
        ownedKey.fill(0)
      }
    })
    expect(storage).toBeDefined()
    await expect(storage!.initialize()).resolves.toMatchObject({ status: 'ok' })
    const appender = createIncrementalMeetingAppender({
      meetingId,
      readLimits: () => limits,
      isCurrent: () => {
        try {
          roots.assertScopeCurrent(firstOwner.scope, root)
          writer.assertCurrent()
          return true
        } catch {
          return false
        }
      },
      canonicalizeRecord: canonicalReceipt,
      storage: storage!
    })
    await expect(appender.append(fixtureRecord, 0)).resolves.toMatchObject({ status: 'durable', revision: 1 })
    storage!.dispose()
    await keys.settleAndDispose(key)
    await writer.release()
    await roots.closeRoot(firstOwner.scope, root)
    firstOwner.retire()

    const reopenedRoot = await roots.openExisting(secondOwner.scope, meetingId)
    const reopenedKey = await keys.open(secondOwner.scope, reopenedRoot, key.reference)
    const reopenedGateway = createStorageGateway({
      root: () => join(reopenedRoot.meetingPath, 'journal'),
      detector: { classify: async (files) => new Map(files.map((file) => [file.path, 'local' as const])) }
    })
    const reopenedStorage = await reopenedKey.withKey((ownedKey) => {
      try {
        return createIncrementalMeetingJournalFileStorage({
          root: join(reopenedRoot.meetingPath, 'journal'),
          meetingId,
          key: ownedKey,
          maxJournalBytes: limits.maxJournalBytes,
          maxPhysicalRecordBytes: 16_384,
          maxChunkBytes: 1_024,
          maxPageRecords: 4,
          maxPageBytes: 32_768,
          isCurrent: () => {
            try {
              roots.assertScopeCurrent(secondOwner.scope, reopenedRoot)
              return true
            } catch {
              return false
            }
          },
          assertPhysicalCurrent: () => reopenedRoot.assertPhysicalCurrent(),
          createRootIfMissing: false,
          gateway: reopenedGateway
        })
      } finally {
        ownedKey.fill(0)
      }
    })
    expect(reopenedStorage).toBeDefined()
    await expect(reopenedStorage!.readSnapshot(meetingId, () => true)).resolves.toMatchObject({
      status: 'ok',
      snapshot: { acceptedRevision: 1, durableRevision: 1, recordCount: 1 }
    })
    reopenedStorage!.dispose()
    await keys.settleAndDispose(reopenedKey)
    reopenedRoot.retire()
    await roots.closeRoot(secondOwner.scope, reopenedRoot)
    secondOwner.retire()
  })
})
