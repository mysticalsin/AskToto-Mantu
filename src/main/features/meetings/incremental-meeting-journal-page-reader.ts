import type { IncrementalJournalFileRecord, IncrementalJournalPageResult } from './incremental-meeting-journal-files'
import type { IndexCore, ManifestCore } from './incremental-meeting-journal-format'

type ManifestRead = { status: 'ok'; core: ManifestCore; bytes: Buffer } | { status: 'missing' | 'unavailable' }
type FileRead = { status: 'ok'; bytes: Buffer } | { status: 'missing' | 'unavailable' }
type DecodedRecord = {
  metadata: Omit<IncrementalJournalFileRecord, 'revision' | 'canonicalBytes'>
  canonicalBytes: Uint8Array
}

export async function readIncrementalJournalPage(options: {
  afterRevision: number
  expectedRevision: number
  maxRecords: number
  maxPageRecords: number
  maxPageBytes: number
  maxPhysicalRecordBytes: number
  requestedMaxBytes: number
  meetingId: string
  key: Buffer
  baseCurrent: () => boolean
  isCurrent: () => boolean
  readManifest: (requestCurrent: () => boolean) => Promise<ManifestRead>
  readBytes: (name: string, maxBytes: number, requestCurrent: () => boolean) => Promise<FileRead>
  indexName: (revision: number) => string
  recordName: (hash: string) => string
  verifyIndex: (bytes: Uint8Array, key: Buffer, meetingId: string, revision: number) => IndexCore | null
  decodeRecord: (
    bytes: Uint8Array,
    key: Buffer,
    meetingId: string,
    identityHash: string,
    revision: number
  ) => DecodedRecord | null
  sink: (record: IncrementalJournalFileRecord) => void | Promise<void>
}): Promise<IncrementalJournalPageResult> {
  const {
    afterRevision,
    expectedRevision,
    maxRecords,
    maxPageRecords,
    maxPageBytes,
    maxPhysicalRecordBytes,
    requestedMaxBytes,
    meetingId,
    key,
    baseCurrent,
    isCurrent,
    readManifest,
    readBytes,
    indexName,
    recordName,
    verifyIndex,
    decodeRecord,
    sink
  } = options
  if (
    !Number.isSafeInteger(afterRevision) ||
    afterRevision < 0 ||
    afterRevision > Number.MAX_SAFE_INTEGER - maxPageRecords ||
    !Number.isSafeInteger(expectedRevision) ||
    expectedRevision < afterRevision ||
    !Number.isSafeInteger(maxRecords) ||
    maxRecords <= 0 ||
    maxRecords > maxPageRecords ||
    !Number.isSafeInteger(requestedMaxBytes) ||
    requestedMaxBytes <= 0 ||
    requestedMaxBytes > maxPageBytes ||
    typeof sink !== 'function'
  )
    return { status: 'unavailable' }
  const requestCurrent = () => safeCurrent(baseCurrent) && safeCurrent(isCurrent)
  const loaded = await readManifest(requestCurrent)
  if (loaded.status !== 'ok' || !requestCurrent()) return { status: 'unavailable' }
  const durableRevision = loaded.core.durableRevision
  loaded.bytes.fill(0)
  if (durableRevision !== expectedRevision || afterRevision > durableRevision) return { status: 'unavailable' }
  const stopAt = Math.min(durableRevision, afterRevision + maxRecords)
  let nextRevision = afterRevision
  let pageBytes = 0
  for (let revision = afterRevision + 1; revision <= stopAt; revision++) {
    if (!requestCurrent()) return { status: 'stale-owner' }
    const encodedIndex = await readBytes(indexName(revision), 512, requestCurrent)
    const indexByteLength = encodedIndex.status === 'ok' ? encodedIndex.bytes.byteLength : 0
    const index = encodedIndex.status === 'ok' && verifyIndex(encodedIndex.bytes, key, meetingId, revision)
    if (encodedIndex.status === 'ok') encodedIndex.bytes.fill(0)
    if (!index || !requestCurrent()) return { status: requestCurrent() ? 'unavailable' : 'stale-owner' }
    if (
      index.recordBytes > maxPhysicalRecordBytes ||
      pageBytes > requestedMaxBytes - indexByteLength - index.recordBytes
    )
      return { status: 'unavailable' }
    const recordRead = await readBytes(recordName(index.identityHash), index.recordBytes, requestCurrent)
    if (recordRead.status !== 'ok' || recordRead.bytes.byteLength !== index.recordBytes || !requestCurrent()) {
      if (recordRead.status === 'ok') recordRead.bytes.fill(0)
      return { status: requestCurrent() ? 'unavailable' : 'stale-owner' }
    }
    pageBytes += indexByteLength + index.recordBytes
    const decoded = decodeRecord(recordRead.bytes, key, meetingId, index.identityHash, revision)
    recordRead.bytes.fill(0)
    if (!decoded || decoded.metadata.sha256 !== index.sha256) {
      decoded?.canonicalBytes.fill(0)
      return { status: 'unavailable' }
    }
    const value: IncrementalJournalFileRecord = {
      revision,
      ...decoded.metadata,
      canonicalBytes: decoded.canonicalBytes
    }
    try {
      await sink(value)
    } catch {
      value.canonicalBytes.fill(0)
      return { status: 'unavailable' }
    }
    value.canonicalBytes.fill(0)
    if (!requestCurrent()) return { status: 'stale-owner' }
    nextRevision = revision
  }
  if (!requestCurrent()) return { status: 'stale-owner' }
  return { status: 'ok', nextRevision, durableRevision, complete: nextRevision === durableRevision }
}

function safeCurrent(check: () => boolean): boolean {
  try {
    return check() === true
  } catch {
    return false
  }
}
