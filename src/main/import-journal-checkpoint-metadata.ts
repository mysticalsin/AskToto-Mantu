import { isAbsolute, normalize } from 'node:path'
import { TextDecoder, TextEncoder } from 'node:util'
import type { TranscriptLine } from '@shared/ipc'
import type { IncrementalJournalSnapshot } from './features/meetings/incremental-meeting-journal'
import type { ImportCheckpoint, ImportJobHeader, ImportTranscriptHandle } from './import-job-checkpoint-contract'
import type { ImportPersistencePolicy } from './import-persistence-policy'
import { MAX_MANIFEST_BYTES } from './features/meetings/incremental-meeting-journal-format'

const SAFE_COMPONENT = /^[A-Za-z0-9_-]{1,128}$/
const HEADER_FIELDS = new Set([
  'jobId',
  'sourcePath',
  'sourceName',
  'sourceSizeBytes',
  'sourceMtimeMs',
  'title',
  'state',
  'cursor',
  'totalChunks',
  'progressPct',
  'file',
  'error',
  'recapError',
  'mode',
  'chunkSec',
  'pipeline',
  'durationMs',
  'createdAt',
  'updatedAt'
])
const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

export interface ImportJournalOwnerBinding {
  readonly profileNamespace: string
  readonly principalAssociation: string
  readonly generation: string
}

export interface ImportJournalSourceVersion {
  readonly canonicalPath: string
  readonly device: string
  readonly inode: string
  readonly size: number
  readonly mtimeNs: string
  readonly ctimeNs: string
}

export interface PendingWindow {
  cursor: number
  nextCursor: number
  baseRevision: number
  recordId: string | null
  nextHeader: ImportJobHeader
}

export interface CheckpointMetadata {
  version: 1
  jobId: string
  journalId: string
  keyId: string
  owner: ImportJournalOwnerBinding
  source: ImportJournalSourceVersion
  header: ImportJobHeader
  cursor: number
  totalChunks: number
  frontier: {
    revision: number
    recordCount: number
    wordCount: number
    payloadBytes: number
  }
  pending: PendingWindow | null
}

export interface CheckpointMetadataBinding {
  readonly jobId: string
  readonly journalId: string
  readonly keyId: string
  readonly owner: ImportJournalOwnerBinding
  readonly source: ImportJournalSourceVersion
  readonly policy: ImportPersistencePolicy
}

export function safeComponent(value: unknown): value is string {
  return typeof value === 'string' && SAFE_COMPONENT.test(value)
}

export function validCounter(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).sort().join(',') === [...expected].sort().join(',')
}

export function validateHeader(header: unknown, jobId: string): header is ImportJobHeader {
  if (!header || typeof header !== 'object' || Array.isArray(header)) return false
  if (!boundedJsonBytes(header, MAX_MANIFEST_BYTES)) return false
  const value = header as Record<string, unknown>
  return (
    !('lines' in value) &&
    Object.keys(value).every((key) => HEADER_FIELDS.has(key)) &&
    value.jobId === jobId &&
    typeof value.sourcePath === 'string' &&
    value.sourcePath.length > 0 &&
    Buffer.byteLength(value.sourcePath, 'utf8') <= MAX_MANIFEST_BYTES &&
    typeof value.sourceName === 'string' &&
    Buffer.byteLength(value.sourceName, 'utf8') <= MAX_MANIFEST_BYTES &&
    Number.isSafeInteger(value.sourceSizeBytes) &&
    (value.sourceSizeBytes as number) >= 0 &&
    Number.isFinite(value.sourceMtimeMs) &&
    typeof value.title === 'string' &&
    value.title.length > 0 &&
    Buffer.byteLength(value.title, 'utf8') <= MAX_MANIFEST_BYTES &&
    [
      'queued',
      'decoding',
      'transcribing',
      'saving',
      'recapping',
      'done',
      'failed',
      'policy-held',
      'cancelled'
    ].includes(String(value.state)) &&
    validCounter(value.cursor) &&
    validCounter(value.totalChunks) &&
    (value.progressPct === undefined ||
      (typeof value.progressPct === 'number' &&
        Number.isFinite(value.progressPct) &&
        value.progressPct >= 0 &&
        value.progressPct <= 100)) &&
    Number.isFinite(value.createdAt) &&
    Number.isFinite(value.updatedAt) &&
    (value.file === undefined ||
      (typeof value.file === 'string' && Buffer.byteLength(value.file, 'utf8') <= MAX_MANIFEST_BYTES)) &&
    (value.error === undefined ||
      (typeof value.error === 'string' && Buffer.byteLength(value.error, 'utf8') <= MAX_MANIFEST_BYTES)) &&
    (value.recapError === undefined ||
      (typeof value.recapError === 'string' && Buffer.byteLength(value.recapError, 'utf8') <= MAX_MANIFEST_BYTES)) &&
    (value.mode === undefined ||
      (typeof value.mode === 'string' && Buffer.byteLength(value.mode, 'utf8') <= MAX_MANIFEST_BYTES)) &&
    (value.chunkSec === undefined || (Number.isSafeInteger(value.chunkSec) && (value.chunkSec as number) > 0)) &&
    (value.pipeline === undefined || value.pipeline === 'vad-v1' || value.pipeline === 'vad-v2') &&
    (value.durationMs === undefined || (Number.isFinite(value.durationMs) && (value.durationMs as number) >= 0))
  )
}

function validateSource(value: unknown): value is ImportJournalSourceVersion {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const source = value as Record<string, unknown>
  return (
    exactKeys(source, ['canonicalPath', 'device', 'inode', 'size', 'mtimeNs', 'ctimeNs']) &&
    typeof source.canonicalPath === 'string' &&
    isAbsolute(source.canonicalPath) &&
    !source.canonicalPath.includes('\0') &&
    normalize(source.canonicalPath) === source.canonicalPath &&
    typeof source.device === 'string' &&
    /^\d+$/.test(source.device) &&
    typeof source.inode === 'string' &&
    /^\d+$/.test(source.inode) &&
    validCounter(source.size) &&
    typeof source.mtimeNs === 'string' &&
    /^-?\d+$/.test(source.mtimeNs) &&
    typeof source.ctimeNs === 'string' &&
    /^-?\d+$/.test(source.ctimeNs)
  )
}

function validateOwner(value: unknown): value is ImportJournalOwnerBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const owner = value as Record<string, unknown>
  return (
    exactKeys(owner, ['profileNamespace', 'principalAssociation', 'generation']) &&
    safeComponent(owner.profileNamespace) &&
    safeComponent(owner.principalAssociation) &&
    safeComponent(owner.generation)
  )
}

function sameSource(left: ImportJournalSourceVersion, right: ImportJournalSourceVersion): boolean {
  return (
    left.canonicalPath === right.canonicalPath &&
    left.device === right.device &&
    left.inode === right.inode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  )
}

function validatePending(value: unknown, jobId: string): value is PendingWindow | null {
  if (value === null) return true
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const pending = value as Record<string, unknown>
  return (
    exactKeys(pending, ['cursor', 'nextCursor', 'baseRevision', 'recordId', 'nextHeader']) &&
    validCounter(pending.cursor) &&
    validCounter(pending.nextCursor) &&
    pending.nextCursor === pending.cursor + 1 &&
    validCounter(pending.baseRevision) &&
    (pending.recordId === null ||
      (typeof pending.recordId === 'string' && /^[0-9a-f-]{36}$/i.test(pending.recordId))) &&
    validateHeader(pending.nextHeader, jobId) &&
    (pending.nextHeader as ImportJobHeader).cursor === pending.nextCursor
  )
}

export function decodeCheckpointMetadata(
  bytes: Uint8Array,
  binding: CheckpointMetadataBinding
): CheckpointMetadata | undefined {
  try {
    const parsed: unknown = JSON.parse(decoder.decode(bytes))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    const value = parsed as Record<string, unknown>
    if (
      !exactKeys(value, [
        'version',
        'jobId',
        'journalId',
        'keyId',
        'owner',
        'source',
        'header',
        'cursor',
        'totalChunks',
        'frontier',
        'pending'
      ]) ||
      value.version !== 1 ||
      value.jobId !== binding.jobId ||
      value.journalId !== binding.journalId ||
      value.keyId !== binding.keyId ||
      !validateOwner(value.owner) ||
      !validateSource(value.source) ||
      !validateHeader(value.header, binding.jobId) ||
      !validCounter(value.cursor) ||
      !validCounter(value.totalChunks) ||
      !value.frontier ||
      typeof value.frontier !== 'object' ||
      Array.isArray(value.frontier) ||
      !exactKeys(value.frontier as Record<string, unknown>, ['revision', 'recordCount', 'wordCount', 'payloadBytes']) ||
      !Object.values(value.frontier as Record<string, unknown>).every(validCounter) ||
      !validatePending(value.pending, binding.jobId)
    )
      return undefined
    const metadata = value as unknown as CheckpointMetadata
    if (
      metadata.owner.profileNamespace !== binding.owner.profileNamespace ||
      metadata.owner.principalAssociation !== binding.owner.principalAssociation ||
      metadata.owner.generation !== binding.owner.generation ||
      !sameSource(metadata.source, binding.source) ||
      metadata.header.cursor !== metadata.cursor ||
      metadata.header.totalChunks !== metadata.totalChunks ||
      metadata.header.sourceSizeBytes !== metadata.source.size ||
      metadata.frontier.revision < metadata.frontier.recordCount ||
      metadata.frontier.recordCount > binding.policy.speech.maxRecords ||
      metadata.frontier.wordCount > binding.policy.speech.maxWords ||
      metadata.frontier.payloadBytes > binding.policy.speech.maxPayloadBytes ||
      (metadata.pending !== null && metadata.pending.baseRevision !== metadata.frontier.revision) ||
      (metadata.pending !== null && metadata.pending.cursor !== metadata.cursor)
    )
      return undefined
    if (JSON.stringify(metadata) !== decoder.decode(bytes)) return undefined
    return metadata
  } catch {
    return undefined
  }
}

export function encodeCheckpointMetadata(metadata: CheckpointMetadata, maxBytes: number): Uint8Array | undefined {
  try {
    if (!boundedJsonBytes(metadata, maxBytes)) return undefined
    const json = JSON.stringify(metadata)
    const length = Buffer.byteLength(json, 'utf8')
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || length <= 0 || length > maxBytes) return undefined
    const bytes = encoder.encode(json)
    if (bytes.byteLength !== length) {
      bytes.fill(0)
      return undefined
    }
    return bytes
  } catch {
    return undefined
  }
}

/** Conservative bounded preflight used before schema cloning or JSON allocation. */
export function boundedJsonBytes(value: unknown, maxBytes: number): boolean {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) return false
  let charged = 0
  let nodes = 0
  const seen = new Set<object>()
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }]
  const add = (bytes: number): boolean => {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || charged > maxBytes - bytes) return false
    charged += bytes
    return true
  }
  const stringBytes = (text: string): number | undefined => {
    let size = 2
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index)
      if (code === 34 || code === 92 || code < 32) size += code < 32 ? 6 : 2
      else if (code < 128) size += 1
      else if (code < 2048) size += 2
      else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
        const low = text.charCodeAt(index + 1)
        if (low >= 0xdc00 && low <= 0xdfff) {
          size += 4
          index += 1
        } else size += 6
      } else if (code >= 0xd800 && code <= 0xdfff) size += 6
      else size += 3
      if (size > maxBytes) return undefined
    }
    return size
  }
  while (stack.length) {
    const item = stack.pop()!
    nodes += 1
    if (nodes > 256 || item.depth > 8) return false
    const current = item.value
    if (current === null) {
      if (!add(4)) return false
    } else if (typeof current === 'string') {
      const size = stringBytes(current)
      if (size === undefined || !add(size)) return false
    } else if (typeof current === 'number') {
      if (!Number.isFinite(current) || !add(String(current).length)) return false
    } else if (typeof current === 'boolean') {
      if (!add(current ? 4 : 5)) return false
    } else if (Array.isArray(current)) {
      if (seen.has(current) || current.length > 256 || !add(2 + Math.max(0, current.length - 1))) return false
      seen.add(current)
      for (let index = current.length - 1; index >= 0; index -= 1)
        stack.push({ value: current[index], depth: item.depth + 1 })
    } else if (typeof current === 'object') {
      if (seen.has(current)) return false
      seen.add(current)
      const keys = Object.keys(current)
      if (keys.length > 128 || !add(2 + Math.max(0, keys.length - 1) * 1)) return false
      for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(current, key)
        const keySize = stringBytes(key)
        if (!descriptor || !('value' in descriptor) || keySize === undefined || !add(keySize + 1)) return false
        stack.push({ value: descriptor.value, depth: item.depth + 1 })
      }
    } else return false
    if (charged > maxBytes) return false
  }
  return true
}

export function checkpointFromMetadata(
  header: ImportJobHeader,
  metadata: CheckpointMetadata,
  transcript: ImportTranscriptHandle
): ImportCheckpoint {
  return Object.freeze({
    header: Object.freeze({ ...header }),
    transcript,
    frontier: Object.freeze({
      generation: metadata.owner.generation,
      journalId: metadata.journalId,
      revision: metadata.frontier.revision,
      recordCount: metadata.frontier.recordCount,
      wordCount: metadata.frontier.wordCount,
      payloadBytes: metadata.frontier.payloadBytes,
      cursor: metadata.cursor
    })
  })
}

export function matchesCheckpointSnapshot(metadata: CheckpointMetadata, snapshot: IncrementalJournalSnapshot): boolean {
  const pending = metadata.pending
  const pendingReplayInFlight = Boolean(
    pending &&
      pending.recordId !== null &&
      snapshot.durableRevision === pending.baseRevision + 1 &&
      snapshot.recordCount === metadata.frontier.recordCount + 1 &&
      snapshot.wordCount >= metadata.frontier.wordCount &&
      snapshot.linePayloadBytes >= metadata.frontier.payloadBytes
  )
  return (
    snapshot.state === 'active' &&
    snapshot.acceptedRevision === snapshot.durableRevision &&
    (pendingReplayInFlight ||
      (pending?.recordId !== null && pending !== null && pending.baseRevision === snapshot.durableRevision) ||
      (!pending && metadata.frontier.revision === snapshot.durableRevision)) &&
    (pendingReplayInFlight || metadata.frontier.recordCount === snapshot.recordCount) &&
    (pendingReplayInFlight || metadata.frontier.wordCount === snapshot.wordCount) &&
    (pendingReplayInFlight || metadata.frontier.payloadBytes === snapshot.linePayloadBytes)
  )
}

export function recordTextBytes(line: TranscriptLine): number {
  return Buffer.byteLength(line.text, 'utf8')
}
