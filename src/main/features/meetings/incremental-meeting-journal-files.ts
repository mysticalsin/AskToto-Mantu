import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { StorageGateway } from '../../infra/storage/gateway'
import { atomicSavedWriteStream } from '../../infra/storage/atomic-saved-write'
import { withIncrementalMeetingMutation } from './incremental-meeting-mutation-lock'
import { createBoundedJournalFileReader } from './incremental-meeting-journal-file-read'
import { createIncrementalMeetingJournalRoot } from './incremental-meeting-journal-root'
import { consumeIncrementalRecordReceipt } from './incremental-record-receipt'
import { createApplicationMetadataStore } from './incremental-meeting-journal-application-metadata'
import { createIncrementalJournalStateOperations } from './incremental-meeting-journal-state-operations'
import { readIncrementalJournalPage } from './incremental-meeting-journal-page-reader'
import {
  MAX_MANIFEST_BYTES,
  SHA256,
  UUID,
  decodeRecord,
  encodeIndex,
  encodeRecord,
  exactKey,
  identityHash,
  manifestBytes,
  ownedBytes,
  plainObject,
  safeCurrent,
  setManifestStoredBytes,
  snapshotFrom,
  validCounter,
  verifyIdentityIndex,
  verifyIndex,
  verifyManifest
} from './incremental-meeting-journal-format'
import type { IndexCore, JournalState, ManifestCore, RecordMetadata } from './incremental-meeting-journal-format'
import {
  type IncrementalAppendCommit,
  type IncrementalAppendCommitResult,
  type IncrementalIdentityLookup,
  type IncrementalJournalSnapshot,
  type IncrementalJournalStorageResult,
  type IncrementalJournalApplicationMetadataResult,
  type IncrementalMeetingJournalStorage
} from './incremental-meeting-journal'

export interface IncrementalMeetingJournalFileStorageOptions {
  /** Main-owned private directory. The caller creates and generation-binds it before constructing this store. */
  root: string
  meetingId: string
  /** Main-owned per-meeting key supplied by the existing protected-key lifecycle; copied and wiped on dispose. */
  key: Uint8Array
  /** Explicit main-owned physical budgets; this adapter supplies no defaults. */
  maxJournalBytes: number
  maxPhysicalRecordBytes: number
  maxChunkBytes: number
  maxPageRecords: number
  maxPageBytes: number
  isCurrent: () => boolean
  gateway: StorageGateway
}

export interface IncrementalMeetingJournalFileStorage extends IncrementalMeetingJournalStorage {
  initialize(): Promise<IncrementalJournalStorageResult<IncrementalJournalSnapshot>>
  readPendingAppend(isCurrent: () => boolean): Promise<'pending' | 'clear' | 'unavailable'>
  transitionState(
    state: Exclude<JournalState, 'active'>,
    isCurrent: () => boolean
  ): Promise<'committed' | 'stale-owner' | 'unavailable'>
  readPage(
    afterRevision: number,
    expectedRevision: number,
    maxRecords: number,
    sink: (record: IncrementalJournalFileRecord) => void | Promise<void>,
    isCurrent: () => boolean,
    maxBytes?: number
  ): Promise<IncrementalJournalPageResult>
  readApplicationMetadata(isCurrent: () => boolean): Promise<IncrementalJournalApplicationMetadataResult>
  commitApplicationMetadata(
    expectedRevision: number,
    bytes: Uint8Array | null,
    maxBytes: number,
    isCurrent: () => boolean
  ): Promise<IncrementalJournalApplicationMetadataResult>
  dispose(): void
}

export interface IncrementalJournalFileRecord extends RecordMetadata {
  revision: number
  canonicalBytes: Uint8Array
}

export type IncrementalJournalPageResult =
  | { status: 'ok'; nextRevision: number; durableRevision: number; complete: boolean }
  | { status: 'stale-owner' | 'unavailable' }

type BoundedManifestRead = { status: 'ok'; core: ManifestCore; bytes: Buffer } | { status: 'missing' | 'unavailable' }

function activeCheck(base: () => boolean, request: () => boolean): () => boolean {
  return () => safeCurrent(base) && safeCurrent(request)
}

/** Concrete encrypted record/frontier store; no directory scan or history-sized in-memory index is kept. */
export function createIncrementalMeetingJournalFileStorage(
  options: IncrementalMeetingJournalFileStorageOptions
): IncrementalMeetingJournalFileStorage | undefined {
  const rootInput = options.root
  const meetingId = options.meetingId
  const isCurrent = options.isCurrent
  const maxJournalBytes = options.maxJournalBytes
  const maxPhysicalRecordBytes = options.maxPhysicalRecordBytes
  const maxChunkBytes = options.maxChunkBytes
  const maxPageRecords = options.maxPageRecords
  const maxPageBytes = options.maxPageBytes
  const gateway = options.gateway
  const classify = gateway?.classify.bind(gateway)
  const streamFile = gateway?.stream.bind(gateway)
  const list = gateway?.list.bind(gateway)
  const key = exactKey(options.key)
  const rootInputPath = resolve(rootInput)
  let root = rootInputPath
  if (
    !key ||
    !UUID.test(meetingId) ||
    !rootInput ||
    typeof isCurrent !== 'function' ||
    typeof classify !== 'function' ||
    typeof streamFile !== 'function' ||
    typeof list !== 'function' ||
    !Number.isSafeInteger(maxJournalBytes) ||
    maxJournalBytes <= 0 ||
    !Number.isSafeInteger(maxPhysicalRecordBytes) ||
    maxPhysicalRecordBytes <= 0 ||
    maxPhysicalRecordBytes > maxJournalBytes ||
    !Number.isSafeInteger(maxChunkBytes) ||
    maxChunkBytes <= 0 ||
    maxChunkBytes > Math.min(maxJournalBytes, maxPhysicalRecordBytes) ||
    !Number.isSafeInteger(maxPageRecords) ||
    maxPageRecords <= 0 ||
    !Number.isSafeInteger(maxPageBytes) ||
    maxPageBytes <= 0 ||
    maxPageBytes > maxJournalBytes
  ) {
    key?.fill(0)
    return undefined
  }
  const manifestName = 'manifest.v1'
  let manifestPath = join(root, manifestName)
  let disposed = false
  const baseCurrent = (): boolean => !disposed && safeCurrent(isCurrent)
  const recordName = (hash: string): string => `record-${hash}.v1`
  const identityIndexName = (hash: string): string => `identity-${hash}.v1`
  const indexName = (revision: number): string => `index-${String(revision).padStart(12, '0')}.v1`
  const pathFor = (name: string): string => join(root, name)
  const resolveCurrentRoot = createIncrementalMeetingJournalRoot(rootInputPath, baseCurrent)
  async function canonicalMutationKey(): Promise<string | undefined> {
    if (!(await rootAligned())) return undefined
    return `${root}\0${meetingId}`
  }
  async function rootAligned(): Promise<boolean> {
    const path = await resolveCurrentRoot()
    if (!path || !baseCurrent()) return false
    // Read-only adapters also admit the canonical namespace; the helper retains its physical owner.
    root = path
    manifestPath = join(root, manifestName)
    return true
  }
  const readBytes = createBoundedJournalFileReader({
    baseCurrent,
    rootAligned,
    maxChunkBytes,
    classify: classify!,
    stream: streamFile!
  })

  async function readManifest(requestCurrent: () => boolean): Promise<BoundedManifestRead> {
    const read = await readBytes(manifestName, 16_384, requestCurrent)
    if (read.status !== 'ok') return read
    const core = verifyManifest(read.bytes, key!, meetingId)
    if (!core) {
      read.bytes.fill(0)
      return { status: 'unavailable' }
    }
    return { status: 'ok', core, bytes: read.bytes }
  }

  async function writeAtomic(
    name: string,
    bytes: Buffer,
    requestCurrent: () => boolean,
    maxBytes: number
  ): Promise<boolean> {
    if (
      !(await rootAligned()) ||
      !baseCurrent() ||
      !requestCurrent() ||
      bytes.byteLength > maxBytes ||
      (name === manifestName && bytes.byteLength > MAX_MANIFEST_BYTES)
    ) {
      bytes.fill(0)
      return false
    }
    const chunkSize = Math.min(maxChunkBytes, maxBytes)
    async function* one(): AsyncGenerator<Uint8Array> {
      for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
        const chunk = ownedBytes(bytes.subarray(offset, Math.min(bytes.byteLength, offset + chunkSize)))
        try {
          yield chunk
        } finally {
          chunk.fill(0)
        }
      }
    }
    try {
      await atomicSavedWriteStream(pathFor(name), one(), {
        maxBytes,
        maxChunkBytes: chunkSize,
        maxChunks: Math.max(1, Math.ceil(bytes.byteLength / chunkSize)),
        beforeChunk: () => {
          if (!baseCurrent() || !requestCurrent()) throw new Error('STALE_OWNER')
        },
        beforeReplace: () => {
          if (!baseCurrent() || !requestCurrent()) throw new Error('STALE_OWNER')
        },
        prepareBeforeReplace: async () => {
          if (!(await rootAligned()) || !baseCurrent() || !requestCurrent()) throw new Error('STALE_OWNER')
        }
      })
      return (await rootAligned()) && baseCurrent() && requestCurrent()
    } catch {
      return false
    } finally {
      bytes.fill(0)
    }
  }

  const applicationMetadata = createApplicationMetadataStore({
    baseCurrent,
    maxJournalBytes,
    key: key!,
    readManifest,
    async writeManifest(core, recordBytes, requestCurrent) {
      const bytes = setManifestStoredBytes(core, recordBytes, key!)
      if (!requestCurrent() || core.storedBytes > maxJournalBytes) {
        bytes.fill(0)
        return false
      }
      return writeAtomic(manifestName, bytes, requestCurrent, maxJournalBytes)
    }
  })
  const stateOperations = createIncrementalJournalStateOperations({
    baseCurrent,
    activeCheck,
    readManifest,
    writeAtomic,
    manifestName,
    maxJournalBytes,
    key: key!
  })

  const storage: IncrementalMeetingJournalFileStorage = {
    readPendingAppend: stateOperations.readPendingAppend,

    async initialize() {
      const requestCurrent = baseCurrent
      if (!requestCurrent()) return { status: 'unavailable' }
      try {
        if (!(await canonicalMutationKey()) || !baseCurrent()) return { status: 'unavailable' }
        const current = await readManifest(requestCurrent)
        if (current.status === 'ok') {
          current.bytes.fill(0)
          return { status: 'ok', snapshot: snapshotFrom(current.core) }
        }
        if (current.status !== 'missing') return { status: 'unavailable' }
        if (!(await rootAligned())) return { status: 'unavailable' }
        const entries = await list!('.')
        if (!(await rootAligned()) || entries.status !== 'ok' || entries.names.length !== 0)
          return { status: 'unavailable' }
        const core: ManifestCore = {
          version: 1,
          meetingId,
          state: 'active',
          acceptedRevision: 0,
          durableRevision: 0,
          recordCount: 0,
          wordCount: 0,
          linePayloadBytes: 0,
          storedBytes: 0,
          manifestBytes: 0,
          pending: null,
          applicationRevision: 0,
          applicationMetadata: null
        }
        const encoded = setManifestStoredBytes(core, 0, key!)
        if (encoded.byteLength > maxJournalBytes) {
          encoded.fill(0)
          return { status: 'unavailable' }
        }
        if (!baseCurrent()) return { status: 'unavailable' }
        const created = await open(manifestPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
        try {
          if (!(await rootAligned())) return { status: 'unavailable' }
          await created.writeFile(encoded)
          if (!(await rootAligned())) return { status: 'unavailable' }
          await created.sync()
          if (!(await rootAligned())) return { status: 'unavailable' }
        } finally {
          await created.close()
          encoded.fill(0)
        }
        return (await rootAligned()) ? { status: 'ok', snapshot: snapshotFrom(core) } : { status: 'unavailable' }
      } catch {
        return { status: 'unavailable' }
      }
    },

    async readSnapshot(_meetingId, isCurrent): Promise<IncrementalJournalStorageResult<IncrementalJournalSnapshot>> {
      if (_meetingId !== meetingId) return { status: 'unavailable' }
      const requestCurrent = activeCheck(baseCurrent, isCurrent)
      const read = await readManifest(requestCurrent)
      if (read.status !== 'ok' || !requestCurrent()) return { status: 'unavailable' }
      read.bytes.fill(0)
      return { status: 'ok', snapshot: snapshotFrom(read.core) }
    },

    async lookupIdentity(_meetingId, identityKey, isCurrent): Promise<IncrementalIdentityLookup> {
      if (_meetingId !== meetingId || typeof identityKey !== 'string') return { status: 'unavailable' }
      const requestCurrent = activeCheck(baseCurrent, isCurrent)
      const read = await readManifest(requestCurrent)
      if (read.status !== 'ok' || !requestCurrent()) return { status: 'unavailable' }
      const hash = identityHash(identityKey, key!)
      const locationRead = await readBytes(identityIndexName(hash), 512, requestCurrent)
      if (!requestCurrent()) {
        read.bytes.fill(0)
        if (locationRead.status === 'ok') locationRead.bytes.fill(0)
        return { status: 'unavailable' }
      }
      if (locationRead.status === 'missing') {
        read.bytes.fill(0)
        return { status: 'absent' }
      }
      if (locationRead.status !== 'ok') {
        read.bytes.fill(0)
        return { status: 'unavailable' }
      }
      const location = verifyIdentityIndex(locationRead.bytes, key!, meetingId, hash)
      locationRead.bytes.fill(0)
      if (!location) {
        read.bytes.fill(0)
        return { status: 'unavailable' }
      }
      if (location.revision > read.core.acceptedRevision) {
        read.bytes.fill(0)
        return { status: 'absent' }
      }
      if (location.recordBytes > maxPhysicalRecordBytes) {
        read.bytes.fill(0)
        return { status: 'unavailable' }
      }
      const indexRead = await readBytes(indexName(location.revision), 512, requestCurrent)
      const index = indexRead.status === 'ok' && verifyIndex(indexRead.bytes, key!, meetingId, location.revision)
      if (indexRead.status === 'ok') indexRead.bytes.fill(0)
      if (
        !index ||
        index.identityHash !== hash ||
        index.sha256 !== location.sha256 ||
        index.recordBytes !== location.recordBytes
      ) {
        read.bytes.fill(0)
        return { status: 'unavailable' }
      }
      const recordRead = await readBytes(recordName(hash), location.recordBytes, requestCurrent)
      if (recordRead.status !== 'ok' || recordRead.bytes.byteLength !== location.recordBytes || !requestCurrent()) {
        read.bytes.fill(0)
        if (recordRead.status === 'ok') recordRead.bytes.fill(0)
        return { status: 'unavailable' }
      }
      const decoded = decodeRecord(recordRead.bytes, key!, meetingId, hash, location.revision)
      read.bytes.fill(0)
      recordRead.bytes.fill(0)
      if (!decoded || decoded.metadata.identityKey !== identityKey || decoded.metadata.sha256 !== index.sha256) {
        decoded?.canonicalBytes.fill(0)
        return { status: 'unavailable' }
      }
      decoded.canonicalBytes.fill(0)
      return { status: 'found', sha256: decoded.metadata.sha256, revision: location.revision }
    },

    async commitAppend(request, isCurrent): Promise<IncrementalAppendCommitResult> {
      if (request.meetingId !== meetingId || !baseCurrent()) return { status: 'stale-owner' }
      const requestCurrent = activeCheck(baseCurrent, isCurrent)
      const loaded = await readManifest(requestCurrent)
      if (loaded.status !== 'ok' || !requestCurrent()) return { status: 'unavailable' }
      const { core: old, bytes: oldManifestBytes } = loaded
      if (old.state !== 'active') {
        oldManifestBytes.fill(0)
        return { status: 'unavailable' }
      }
      if (old.acceptedRevision !== request.expectedRevision) {
        oldManifestBytes.fill(0)
        return { status: 'stale-revision' }
      }
      const hash = identityHash(request.identityKey, key!)
      if (
        request.maxJournalBytes !== maxJournalBytes ||
        !Number.isSafeInteger(request.expectedRevision) ||
        request.expectedRevision < 0 ||
        request.nextRevision !== request.expectedRevision + 1 ||
        request.recordCount !== old.recordCount + 1 ||
        request.wordCount !== old.wordCount + request.recordWordCount ||
        request.linePayloadBytes !== old.linePayloadBytes + request.recordLinePayloadBytes ||
        !SHA256.test(request.sha256) ||
        request.recordWordCount < 0 ||
        request.recordLinePayloadBytes <= 0
      ) {
        oldManifestBytes.fill(0)
        return { status: 'limit' }
      }
      const canonical = consumeIncrementalRecordReceipt(request.receipt, request.receiptBinding)
      if (
        !canonical ||
        request.receiptBinding.meetingId !== meetingId ||
        request.receiptBinding.maxCanonicalBytes > maxJournalBytes ||
        request.receiptBinding.isCurrent !== isCurrent ||
        canonical.identityKey !== request.identityKey ||
        canonical.sha256 !== request.sha256 ||
        canonical.canonicalByteLength !== request.canonicalByteLength ||
        canonical.wordCount !== request.recordWordCount ||
        canonical.linePayloadBytes !== request.recordLinePayloadBytes ||
        canonical.clock !== request.clock ||
        createHash('sha256').update(canonical.canonicalBytes).digest('hex') !== request.sha256
      ) {
        canonical?.canonicalBytes.fill(0)
        oldManifestBytes.fill(0)
        return { status: 'unavailable' }
      }
      let encrypted: Buffer
      try {
        encrypted = encodeRecord(request, canonical.canonicalBytes, key!, maxPhysicalRecordBytes)
      } catch {
        canonical.canonicalBytes.fill(0)
        oldManifestBytes.fill(0)
        return { status: 'limit' }
      }
      canonical.canonicalBytes.fill(0)
      const indexBuffer = encodeIndex(
        {
          version: 1,
          meetingId,
          revision: request.nextRevision,
          identityHash: hash,
          sha256: request.sha256,
          recordBytes: encrypted.byteLength
        },
        key!
      )
      const identityIndexBuffer = Buffer.from(indexBuffer)
      if (encrypted.byteLength > maxPhysicalRecordBytes) {
        encrypted.fill(0)
        indexBuffer.fill(0)
        identityIndexBuffer.fill(0)
        oldManifestBytes.fill(0)
        return { status: 'limit' }
      }
      const pending = old.pending
      if (
        pending &&
        (pending.identityHash !== hash ||
          pending.sha256 !== request.sha256 ||
          pending.nextRevision !== request.nextRevision ||
          pending.recordBytes !== encrypted.byteLength ||
          pending.indexBytes !== indexBuffer.byteLength ||
          pending.identityIndexBytes !== identityIndexBuffer.byteLength)
      ) {
        encrypted.fill(0)
        indexBuffer.fill(0)
        identityIndexBuffer.fill(0)
        oldManifestBytes.fill(0)
        return { status: 'unavailable' }
      }
      const committedRecordBytes = old.pending
        ? old.storedBytes - old.pending.priorManifestBytes
        : old.storedBytes - old.manifestBytes
      if (!validCounter(committedRecordBytes)) {
        encrypted.fill(0)
        indexBuffer.fill(0)
        identityIndexBuffer.fill(0)
        oldManifestBytes.fill(0)
        return { status: 'unavailable' }
      }
      if (!pending) {
        const reserved: ManifestCore = {
          ...old,
          manifestBytes: 0,
          pending: {
            identityHash: hash,
            sha256: request.sha256,
            nextRevision: request.nextRevision,
            recordBytes: encrypted.byteLength,
            indexBytes: indexBuffer.byteLength,
            identityIndexBytes: identityIndexBuffer.byteLength,
            priorManifestBytes: old.manifestBytes
          }
        }
        const pendingManifest = manifestBytes(reserved, key!)
        reserved.manifestBytes = pendingManifest.byteLength
        const reservedPhysicalBytes =
          committedRecordBytes +
          reserved.manifestBytes +
          encrypted.byteLength +
          indexBuffer.byteLength +
          identityIndexBuffer.byteLength
        if (
          pendingManifest.byteLength > MAX_MANIFEST_BYTES ||
          !Number.isSafeInteger(reservedPhysicalBytes) ||
          reservedPhysicalBytes > request.maxJournalBytes
        ) {
          pendingManifest.fill(0)
          encrypted.fill(0)
          indexBuffer.fill(0)
          identityIndexBuffer.fill(0)
          oldManifestBytes.fill(0)
          return { status: 'limit' }
        }
        const written = await writeAtomic(manifestName, pendingManifest, requestCurrent, request.maxJournalBytes)
        if (!written || !requestCurrent()) {
          pendingManifest.fill(0)
          encrypted.fill(0)
          indexBuffer.fill(0)
          identityIndexBuffer.fill(0)
          oldManifestBytes.fill(0)
          return { status: requestCurrent() ? 'unavailable' : 'stale-owner' }
        }
      }
      oldManifestBytes.fill(0)

      const pendingPath = recordName(hash)
      let recordExists = false
      const classified = await classify!([pendingPath])
      if (!requestCurrent()) {
        encrypted.fill(0)
        indexBuffer.fill(0)
        identityIndexBuffer.fill(0)
        return { status: 'stale-owner' }
      }
      const fileClass = classified.get(pendingPath)
      if (!fileClass) {
        encrypted.fill(0)
        indexBuffer.fill(0)
        identityIndexBuffer.fill(0)
        return { status: 'unavailable' }
      }
      if (fileClass?.status === 'ok') {
        if (fileClass.isSymlink || !fileClass.isRegular) {
          encrypted.fill(0)
          indexBuffer.fill(0)
          identityIndexBuffer.fill(0)
          return { status: 'unavailable' }
        }
        const existing = await readBytes(pendingPath, maxPhysicalRecordBytes, requestCurrent)
        const oldRecord =
          existing.status === 'ok' ? decodeRecord(existing.bytes, key!, meetingId, hash, request.nextRevision) : null
        if (existing.status === 'ok') existing.bytes.fill(0)
        if (
          !oldRecord ||
          oldRecord.metadata.sha256 !== request.sha256 ||
          oldRecord.metadata.identityKey !== request.identityKey
        ) {
          oldRecord?.canonicalBytes.fill(0)
          encrypted.fill(0)
          indexBuffer.fill(0)
          identityIndexBuffer.fill(0)
          return { status: 'unavailable' }
        }
        oldRecord.canonicalBytes.fill(0)
        recordExists = true
      } else if (fileClass.status !== 'missing') {
        encrypted.fill(0)
        indexBuffer.fill(0)
        identityIndexBuffer.fill(0)
        return { status: 'unavailable' }
      }
      if (!recordExists) {
        const wrote = await writeAtomic(pendingPath, encrypted, requestCurrent, maxPhysicalRecordBytes)
        if (!wrote || !requestCurrent()) {
          indexBuffer.fill(0)
          identityIndexBuffer.fill(0)
          return { status: requestCurrent() ? 'unavailable' : 'stale-owner' }
        }
      } else encrypted.fill(0)

      const indexPath = indexName(request.nextRevision)
      const indexClass = (await classify!([indexPath])).get(indexPath)
      if (!requestCurrent()) {
        indexBuffer.fill(0)
        identityIndexBuffer.fill(0)
        return { status: 'stale-owner' }
      }
      if (indexClass?.status === 'ok') {
        if (indexClass.isSymlink || !indexClass.isRegular) {
          indexBuffer.fill(0)
          identityIndexBuffer.fill(0)
          return { status: 'unavailable' }
        }
        const existingIndexBytes = await readBytes(indexPath, 512, requestCurrent)
        const existingIndex =
          existingIndexBytes.status === 'ok' &&
          verifyIndex(existingIndexBytes.bytes, key!, meetingId, request.nextRevision)
        if (existingIndexBytes.status === 'ok') existingIndexBytes.bytes.fill(0)
        if (
          !existingIndex ||
          existingIndex.identityHash !== hash ||
          existingIndex.sha256 !== request.sha256 ||
          existingIndex.recordBytes !== encrypted.byteLength
        ) {
          indexBuffer.fill(0)
          identityIndexBuffer.fill(0)
          return { status: 'unavailable' }
        }
        indexBuffer.fill(0)
      } else if (!indexClass || indexClass.status !== 'missing') {
        indexBuffer.fill(0)
        identityIndexBuffer.fill(0)
        return { status: 'unavailable' }
      } else {
        const indexWritten = await writeAtomic(indexPath, indexBuffer, requestCurrent, request.maxJournalBytes)
        if (!indexWritten || !requestCurrent()) {
          identityIndexBuffer.fill(0)
          return { status: requestCurrent() ? 'unavailable' : 'stale-owner' }
        }
      }

      const identityPath = identityIndexName(hash)
      const identityClass = (await classify!([identityPath])).get(identityPath)
      if (!requestCurrent()) {
        identityIndexBuffer.fill(0)
        return { status: 'stale-owner' }
      }
      if (identityClass?.status === 'ok') {
        if (identityClass.isSymlink || !identityClass.isRegular) {
          identityIndexBuffer.fill(0)
          return { status: 'unavailable' }
        }
        const existingBytes = await readBytes(identityPath, 512, requestCurrent)
        const existingIndex =
          existingBytes.status === 'ok' && verifyIdentityIndex(existingBytes.bytes, key!, meetingId, hash)
        if (existingBytes.status === 'ok') existingBytes.bytes.fill(0)
        if (
          !existingIndex ||
          existingIndex.revision !== request.nextRevision ||
          existingIndex.sha256 !== request.sha256 ||
          existingIndex.recordBytes !== encrypted.byteLength
        ) {
          identityIndexBuffer.fill(0)
          return { status: 'unavailable' }
        }
        identityIndexBuffer.fill(0)
      } else if (!identityClass || identityClass.status !== 'missing') {
        identityIndexBuffer.fill(0)
        return { status: 'unavailable' }
      } else {
        const identityWritten = await writeAtomic(identityPath, identityIndexBuffer, requestCurrent, 512)
        if (!identityWritten || !requestCurrent()) return { status: requestCurrent() ? 'unavailable' : 'stale-owner' }
      }

      if (!requestCurrent()) return { status: 'stale-owner' }
      const currentManifest = await readManifest(requestCurrent)
      if (currentManifest.status !== 'ok' || !requestCurrent()) return { status: 'unavailable' }
      const activePending = currentManifest.core.pending
      if (
        !activePending ||
        activePending.identityHash !== hash ||
        activePending.sha256 !== request.sha256 ||
        activePending.nextRevision !== request.nextRevision
      ) {
        currentManifest.bytes.fill(0)
        return { status: 'unavailable' }
      }
      const finalCore: ManifestCore = {
        ...currentManifest.core,
        acceptedRevision: request.nextRevision,
        durableRevision: request.nextRevision,
        recordCount: request.recordCount,
        wordCount: request.wordCount,
        linePayloadBytes: request.linePayloadBytes,
        pending: null
      }
      const finalBytes = setManifestStoredBytes(
        finalCore,
        committedRecordBytes + activePending.recordBytes + activePending.indexBytes + activePending.identityIndexBytes,
        key!
      )
      if (finalBytes.byteLength > MAX_MANIFEST_BYTES || finalCore.storedBytes > request.maxJournalBytes) {
        finalBytes.fill(0)
        currentManifest.bytes.fill(0)
        return { status: 'limit' }
      }
      const finalized = await writeAtomic(manifestName, finalBytes, requestCurrent, request.maxJournalBytes)
      currentManifest.bytes.fill(0)
      if (!finalized || !requestCurrent()) return { status: requestCurrent() ? 'unavailable' : 'stale-owner' }
      return { status: 'committed', snapshot: snapshotFrom(finalCore) }
    },

    async readPage(afterRevision, expectedRevision, maxRecords, sink, isCurrent, requestedMaxBytes = maxPageBytes) {
      return readIncrementalJournalPage({
        afterRevision,
        expectedRevision,
        maxRecords,
        maxPageRecords,
        maxPageBytes,
        maxPhysicalRecordBytes,
        requestedMaxBytes,
        meetingId,
        key: key!,
        baseCurrent,
        isCurrent,
        readManifest,
        readBytes,
        indexName,
        recordName,
        verifyIndex,
        decodeRecord,
        sink
      })
    },

    transitionState: stateOperations.transitionState,

    ...applicationMetadata,

    dispose() {
      if (disposed) return
      disposed = true
      key!.fill(0)
    }
  }
  return {
    ...storage,
    async initialize() {
      const canonicalKey = await canonicalMutationKey()
      if (!canonicalKey) return { status: 'unavailable' }
      const locked = await withIncrementalMeetingMutation(canonicalKey, baseCurrent, () => storage.initialize())
      return locked.status === 'ok' ? locked.value : { status: 'unavailable' }
    },
    async commitAppend(request, isCurrent) {
      const canonicalKey = await canonicalMutationKey()
      if (!canonicalKey) return { status: 'unavailable' }
      const locked = await withIncrementalMeetingMutation(
        canonicalKey,
        () => baseCurrent() && safeCurrent(isCurrent),
        () => storage.commitAppend(request, isCurrent)
      )
      return locked.status === 'ok'
        ? locked.value
        : { status: locked.status === 'stale-owner' ? 'stale-owner' : 'unavailable' }
    },
    async transitionState(state, isCurrent) {
      const canonicalKey = await canonicalMutationKey()
      if (!canonicalKey) return 'unavailable'
      const locked = await withIncrementalMeetingMutation(
        canonicalKey,
        () => baseCurrent() && safeCurrent(isCurrent),
        () => storage.transitionState(state, isCurrent)
      )
      return locked.status === 'ok' ? locked.value : locked.status === 'stale-owner' ? 'stale-owner' : 'unavailable'
    },
    async readApplicationMetadata(isCurrent) {
      const canonicalKey = await canonicalMutationKey()
      if (!canonicalKey) return { status: 'unavailable' }
      const locked = await withIncrementalMeetingMutation(
        canonicalKey,
        () => baseCurrent() && safeCurrent(isCurrent),
        () => storage.readApplicationMetadata(isCurrent)
      )
      return locked.status === 'ok'
        ? locked.value
        : { status: locked.status === 'stale-owner' ? 'stale-owner' : 'unavailable' }
    },
    async commitApplicationMetadata(expectedRevision, bytes, maxBytes, isCurrent) {
      const canonicalKey = await canonicalMutationKey()
      if (!canonicalKey) return { status: 'unavailable' }
      const locked = await withIncrementalMeetingMutation(
        canonicalKey,
        () => baseCurrent() && safeCurrent(isCurrent),
        () => storage.commitApplicationMetadata(expectedRevision, bytes, maxBytes, isCurrent)
      )
      return locked.status === 'ok'
        ? locked.value
        : { status: locked.status === 'stale-owner' ? 'stale-owner' : 'unavailable' }
    }
  }
}
