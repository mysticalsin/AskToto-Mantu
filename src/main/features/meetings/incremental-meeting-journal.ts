import type { SpeechProvenanceLimits } from '@shared/meeting-speech-contract'
import { IncrementalMeetingIdentitySchema, type CanonicalIncrementalRecord } from '@shared/incremental-meeting'
import {
  discardIncrementalRecordReceipt,
  inspectIncrementalRecordReceipt,
  type IncrementalRecordReceipt,
  type IncrementalRecordReceiptBinding
} from '../../infra/process/incremental-record-receipt'

export type IncrementalJournalLimits = SpeechProvenanceLimits & { maxJournalBytes: number }

export interface IncrementalJournalSnapshot {
  state: 'active' | 'finalized' | 'discarded'
  acceptedRevision: number
  durableRevision: number
  recordCount: number
  wordCount: number
  linePayloadBytes: number
  /** Storage-owned exact bytes: immutable chunks, index pages, frontier and manifest. */
  storedBytes: number
}

export type IncrementalJournalStorageResult<T> = { status: 'ok'; snapshot: T } | { status: 'unavailable' }

export type IncrementalIdentityLookup =
  | { status: 'absent' }
  | { status: 'found'; sha256: string; revision: number }
  | { status: 'unavailable' }

export interface IncrementalAppendCommit {
  meetingId: string
  expectedRevision: number
  nextRevision: number
  identityKey: string
  sha256: string
  receipt: IncrementalRecordReceipt
  receiptBinding: IncrementalRecordReceiptBinding
  canonicalByteLength: number
  recordWordCount: number
  recordLinePayloadBytes: number
  clock: string
  wordCount: number
  recordCount: number
  linePayloadBytes: number
  provenancePayloadBytes: number
  maxJournalBytes: number
}

export type IncrementalAppendCommitResult =
  | { status: 'committed'; snapshot: IncrementalJournalSnapshot }
  | { status: 'stale-revision' }
  | { status: 'stale-owner' }
  | { status: 'limit' }
  | { status: 'unavailable' }

/** Main-owned adapter. It accepts a meeting capability, never a renderer path or filesystem method. */
export interface IncrementalMeetingJournalStorage {
  readSnapshot(
    meetingId: string,
    isCurrent: () => boolean
  ): Promise<IncrementalJournalStorageResult<IncrementalJournalSnapshot>>
  lookupIdentity(meetingId: string, identityKey: string, isCurrent: () => boolean): Promise<IncrementalIdentityLookup>
  /** Must check currentness at each mutation boundary, CAS the revision and atomically publish record plus frontier. */
  commitAppend(request: IncrementalAppendCommit, isCurrent: () => boolean): Promise<IncrementalAppendCommitResult>
}

export type IncrementalAppendResult =
  | { status: 'durable'; revision: number; duplicate: boolean }
  | {
      status: 'refused'
      reason:
        | 'UNCONFIGURED'
        | 'QUEUE_FULL'
        | 'INVALID_LIMITS'
        | 'INVALID_RECORD'
        | 'STALE_REVISION'
        | 'CONFLICTING_IDENTITY'
        | 'LIMIT'
        | 'STALE_OWNER'
        | 'UNAVAILABLE'
    }

export interface IncrementalMeetingAppender {
  append(recordJson: Uint8Array, expectedRevision: number): Promise<IncrementalAppendResult>
}

export interface IncrementalMeetingAppenderOptions {
  meetingId: string
  readLimits: () => IncrementalJournalLimits | undefined
  isCurrent: () => boolean
  canonicalizeRecord: (
    recordJson: Uint8Array,
    binding: IncrementalRecordReceiptBinding
  ) => Promise<IncrementalRecordReceipt>
  storage?: IncrementalMeetingJournalStorage
}

const CLOCK_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/
const SOURCE_LIMIT_KEYS = ['maxFieldBytes', 'maxPayloadBytes', 'maxRecordBytes', 'maxRecords', 'maxWords']

function validLimits(limits: IncrementalJournalLimits | undefined): limits is IncrementalJournalLimits {
  try {
    if (!limits) return false
    const keys = [...SOURCE_LIMIT_KEYS, 'maxJournalBytes'].sort()
    return (
      Object.keys(limits).sort().join(',') === keys.join(',') &&
      Object.values(limits).every((value) => Number.isSafeInteger(value) && value > 0)
    )
  } catch {
    return false
  }
}

function validCounter(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}

function exactOwnedByteLength(value: unknown): number | null {
  if (!(value instanceof Uint8Array)) return null
  const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object
  const byteLengthGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')?.get
  const byteOffsetGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset')?.get
  const bufferGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')?.get
  const arrayBufferLengthGetter = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')?.get
  if (!byteLengthGetter || !byteOffsetGetter || !bufferGetter || !arrayBufferLengthGetter) return null
  try {
    const byteLength = byteLengthGetter.call(value) as number
    const byteOffset = byteOffsetGetter.call(value) as number
    const buffer = bufferGetter.call(value) as unknown
    if (!(buffer instanceof ArrayBuffer)) return null
    const bufferLength = arrayBufferLengthGetter.call(buffer) as number
    const resizableGetter = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get
    if (
      byteOffset !== 0 ||
      byteLength !== bufferLength ||
      !Number.isSafeInteger(byteLength) ||
      byteLength <= 0 ||
      resizableGetter?.call(buffer) === true
    )
      return null
    return byteLength
  } catch {
    return null
  }
}

function validSnapshot(snapshot: IncrementalJournalSnapshot, limits: IncrementalJournalLimits): boolean {
  return Boolean(
    snapshot &&
      Object.keys(snapshot).sort().join(',') ===
        'acceptedRevision,durableRevision,linePayloadBytes,recordCount,state,storedBytes,wordCount' &&
      ['active', 'finalized', 'discarded'].includes(snapshot.state) &&
      [
        snapshot.acceptedRevision,
        snapshot.durableRevision,
        snapshot.recordCount,
        snapshot.wordCount,
        snapshot.linePayloadBytes,
        snapshot.storedBytes
      ].every(validCounter) &&
      snapshot.acceptedRevision === snapshot.durableRevision &&
      (snapshot.recordCount !== 0 || snapshot.linePayloadBytes === 0) &&
      snapshot.acceptedRevision >= snapshot.recordCount &&
      snapshot.recordCount <= limits.maxRecords &&
      snapshot.wordCount <= limits.maxWords &&
      Number.isSafeInteger(snapshot.recordCount * 256) &&
      snapshot.wordCount <= snapshot.recordCount * 256 &&
      (snapshot.recordCount === 0 ||
        (Number.isSafeInteger(snapshot.recordCount * limits.maxRecordBytes) &&
          snapshot.linePayloadBytes >= snapshot.recordCount * 2 &&
          snapshot.linePayloadBytes <= snapshot.recordCount * limits.maxRecordBytes &&
          snapshot.storedBytes > 0)) &&
      snapshot.storedBytes <= limits.maxJournalBytes &&
      provenancePayloadBytes(snapshot.recordCount, snapshot.linePayloadBytes) <= limits.maxPayloadBytes
  )
}

/** Exact byte count of the existing v1 private provenance JSON payload, including hash and framing fields. */
export function provenancePayloadBytes(recordCount: number, linePayloadBytes: number): number {
  if (!validCounter(recordCount) || !validCounter(linePayloadBytes)) return Number.POSITIVE_INFINITY
  if (recordCount === 0) return linePayloadBytes === 0 ? 0 : Number.POSITIVE_INFINITY
  const clockArrayBytes = 2 + recordCount * 10 + Math.max(0, recordCount - 1)
  const lineSeparators = Math.max(0, recordCount - 1)
  const value =
    Buffer.byteLength('{"version":1,"clocks":', 'utf8') +
    clockArrayBytes +
    Buffer.byteLength(',"lines":[', 'utf8') +
    linePayloadBytes +
    lineSeparators +
    Buffer.byteLength('],"transcriptSha256":"', 'utf8') +
    64 +
    Buffer.byteLength('"}', 'utf8')
  return Number.isSafeInteger(value) ? value : Number.POSITIVE_INFINITY
}

function readCurrent(read: () => boolean): boolean {
  try {
    return read()
  } catch {
    return false
  }
}

function snapshotMatchesCommit(
  snapshot: IncrementalJournalSnapshot,
  request: IncrementalAppendCommit,
  priorStoredBytes: number,
  limits: IncrementalJournalLimits
): boolean {
  return Boolean(
    validSnapshot(snapshot, limits) &&
      snapshot.state === 'active' &&
      snapshot.acceptedRevision === request.nextRevision &&
      snapshot.durableRevision === request.nextRevision &&
      snapshot.recordCount === request.recordCount &&
      snapshot.wordCount === request.wordCount &&
      snapshot.linePayloadBytes === request.linePayloadBytes &&
      snapshot.storedBytes >= priorStoredBytes + request.canonicalByteLength
  )
}

/** One active append at a time. Replay identity remains page-backed in storage, never in a growing Set. */
export function createIncrementalMeetingAppender(
  options: IncrementalMeetingAppenderOptions
): IncrementalMeetingAppender {
  const meetingId = options.meetingId
  const readLimits = options.readLimits
  const isCurrent = options.isCurrent
  const canonicalizeRecord = options.canonicalizeRecord
  const configuredStorage = options.storage
  const readSnapshot = configuredStorage?.readSnapshot
  const lookupIdentity = configuredStorage?.lookupIdentity
  const commitAppend = configuredStorage?.commitAppend
  const storage: IncrementalMeetingJournalStorage | undefined =
    configuredStorage && readSnapshot && lookupIdentity && commitAppend
      ? {
          readSnapshot: (...args) => readSnapshot.apply(configuredStorage, args),
          lookupIdentity: (...args) => lookupIdentity.apply(configuredStorage, args),
          commitAppend: (...args) => commitAppend.apply(configuredStorage, args)
        }
      : undefined
  let active = false
  let loadedSnapshot: IncrementalJournalSnapshot | undefined

  return {
    async append(recordJson, expectedRevision): Promise<IncrementalAppendResult> {
      if (active) return { status: 'refused', reason: 'QUEUE_FULL' }
      active = true
      let receipt: IncrementalRecordReceipt | undefined
      try {
        if (!storage || !isCurrent || !readLimits || !canonicalizeRecord)
          return { status: 'refused', reason: 'UNCONFIGURED' }
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(meetingId))
          return { status: 'refused', reason: 'UNCONFIGURED' }
        if (!readCurrent(isCurrent)) return { status: 'refused', reason: 'STALE_OWNER' }
        if (!validCounter(expectedRevision)) return { status: 'refused', reason: 'INVALID_RECORD' }
        let rawLimits: IncrementalJournalLimits | undefined
        try {
          const configured = readLimits()
          rawLimits = configured ? Object.freeze({ ...configured }) : undefined
        } catch {
          return { status: 'refused', reason: 'INVALID_LIMITS' }
        }
        if (!validLimits(rawLimits)) return { status: 'refused', reason: 'INVALID_LIMITS' }
        const limits = rawLimits

        if (!loadedSnapshot) {
          const loaded = await storage.readSnapshot(meetingId, isCurrent)
          if (!readCurrent(isCurrent)) return { status: 'refused', reason: 'STALE_OWNER' }
          if (loaded.status !== 'ok' || !validSnapshot(loaded.snapshot, limits))
            return { status: 'refused', reason: 'UNAVAILABLE' }
          loadedSnapshot = Object.freeze({ ...loaded.snapshot })
        }
        const current = loadedSnapshot
        if (current.state !== 'active') return { status: 'refused', reason: 'UNAVAILABLE' }
        if (!readCurrent(isCurrent)) return { status: 'refused', reason: 'STALE_OWNER' }

        const ownerToken = Object.freeze(Object.create(null) as object)
        const binding: IncrementalRecordReceiptBinding = Object.freeze({
          ownerToken,
          meetingId,
          isCurrent,
          limits: Object.freeze({
            maxFieldBytes: limits.maxFieldBytes,
            maxPayloadBytes: limits.maxPayloadBytes,
            maxRecordBytes: limits.maxRecordBytes,
            maxRecords: limits.maxRecords,
            maxWords: limits.maxWords
          }),
          maxCanonicalBytes: limits.maxJournalBytes
        })
        receipt = await canonicalizeRecord(recordJson, binding)
        if (!readCurrent(isCurrent)) return { status: 'refused', reason: 'STALE_OWNER' }
        const canonical = inspectIncrementalRecordReceipt(receipt, binding)
        if (
          !canonical ||
          !Number.isSafeInteger(canonical.canonicalByteLength) ||
          canonical.canonicalByteLength <= 0 ||
          canonical.canonicalByteLength > limits.maxJournalBytes ||
          canonical.wordCount > limits.maxWords ||
          canonical.linePayloadBytes > limits.maxRecordBytes ||
          !CLOCK_PATTERN.test(canonical.clock) ||
          !IncrementalMeetingIdentitySchema.safeParse(JSON.parse(canonical.identityKey)).success
        )
          return { status: 'refused', reason: 'INVALID_RECORD' }

        const existing = await storage.lookupIdentity(meetingId, canonical.identityKey, isCurrent)
        if (!readCurrent(isCurrent)) return { status: 'refused', reason: 'STALE_OWNER' }
        if (existing.status === 'unavailable') return { status: 'refused', reason: 'UNAVAILABLE' }
        if (existing.status === 'found') {
          if (
            !validCounter(existing.revision) ||
            existing.revision === 0 ||
            existing.revision > current.acceptedRevision ||
            !/^[a-f0-9]{64}$/.test(existing.sha256)
          )
            return { status: 'refused', reason: 'UNAVAILABLE' }
          if (existing.sha256 !== canonical.sha256) return { status: 'refused', reason: 'CONFLICTING_IDENTITY' }
          return { status: 'durable', revision: existing.revision, duplicate: true }
        }
        if (expectedRevision !== current.acceptedRevision) return { status: 'refused', reason: 'STALE_REVISION' }

        const nextRevision = current.acceptedRevision + 1
        const recordCount = current.recordCount + 1
        const wordCount = current.wordCount + canonical.wordCount
        const linePayloadBytes = current.linePayloadBytes + canonical.linePayloadBytes
        if (
          ![nextRevision, recordCount, wordCount, linePayloadBytes].every(validCounter) ||
          recordCount > limits.maxRecords ||
          wordCount > limits.maxWords ||
          canonical.linePayloadBytes > limits.maxRecordBytes ||
          provenancePayloadBytes(recordCount, linePayloadBytes) > limits.maxPayloadBytes ||
          current.storedBytes > limits.maxJournalBytes - canonical.canonicalByteLength
        )
          return { status: 'refused', reason: 'LIMIT' }

        const request: IncrementalAppendCommit = {
          meetingId,
          expectedRevision,
          nextRevision,
          identityKey: canonical.identityKey,
          sha256: canonical.sha256,
          receipt,
          receiptBinding: binding,
          canonicalByteLength: canonical.canonicalByteLength,
          recordWordCount: canonical.wordCount,
          recordLinePayloadBytes: canonical.linePayloadBytes,
          clock: canonical.clock,
          wordCount,
          recordCount,
          linePayloadBytes,
          provenancePayloadBytes: provenancePayloadBytes(recordCount, linePayloadBytes),
          maxJournalBytes: limits.maxJournalBytes
        }
        if (!readCurrent(isCurrent)) return { status: 'refused', reason: 'STALE_OWNER' }
        let committed: IncrementalAppendCommitResult
        try {
          committed = await storage.commitAppend(request, isCurrent)
        } catch {
          loadedSnapshot = undefined
          return { status: 'refused', reason: 'UNAVAILABLE' }
        }
        if (committed.status === 'stale-revision') {
          loadedSnapshot = undefined
          return { status: 'refused', reason: 'STALE_REVISION' }
        }
        if (committed.status === 'stale-owner') return { status: 'refused', reason: 'STALE_OWNER' }
        if (committed.status === 'limit') {
          loadedSnapshot = undefined
          return { status: 'refused', reason: 'LIMIT' }
        }
        if (
          committed.status !== 'committed' ||
          !snapshotMatchesCommit(committed.snapshot, request, current.storedBytes, limits)
        ) {
          loadedSnapshot = undefined
          return { status: 'refused', reason: 'UNAVAILABLE' }
        }
        loadedSnapshot = Object.freeze({ ...committed.snapshot })
        if (!readCurrent(isCurrent)) return { status: 'refused', reason: 'STALE_OWNER' }
        return { status: 'durable', revision: nextRevision, duplicate: false }
      } catch {
        return { status: 'refused', reason: 'UNAVAILABLE' }
      } finally {
        discardIncrementalRecordReceipt(receipt)
        active = false
      }
    }
  }
}
