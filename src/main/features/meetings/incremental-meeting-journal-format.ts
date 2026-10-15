import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual
} from 'node:crypto'
import type { IncrementalAppendCommit, IncrementalJournalSnapshot } from './incremental-meeting-journal'

export const MANIFEST_VERSION = 1
export const RECORD_MAGIC = Buffer.from('MIR1')
export const RECORD_HEADER_BYTES = 4 + 8 + 12 + 16
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
export const SHA256 = /^[a-f0-9]{64}$/

export type JournalState = IncrementalJournalSnapshot['state']
export type PendingRecord = {
  identityHash: string
  sha256: string
  nextRevision: number
  recordBytes: number
  indexBytes: number
  identityIndexBytes: number
  priorManifestBytes: number
}
export type ManifestCore = {
  version: 1
  meetingId: string
  state: JournalState
  acceptedRevision: number
  durableRevision: number
  recordCount: number
  wordCount: number
  linePayloadBytes: number
  storedBytes: number
  manifestBytes: number
  pending: PendingRecord | null
}
export type StoredManifest = ManifestCore & { hmac: string }
export type RecordMetadata = {
  identityKey: string
  sha256: string
  clock: string
  wordCount: number
  linePayloadBytes: number
}
export type IndexCore = {
  version: 1
  meetingId: string
  revision: number
  identityHash: string
  sha256: string
  recordBytes: number
}

export function exactKey(value: Uint8Array): Buffer | null {
  try {
    if (!(value instanceof Uint8Array) || Object.getPrototypeOf(value) !== Uint8Array.prototype) return null
    const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object
    const lengthGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')?.get
    const offsetGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset')?.get
    const bufferGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')?.get
    const arrayBufferLengthGetter = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')?.get
    const resizableGetter = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get
    if (!lengthGetter || !offsetGetter || !bufferGetter || !arrayBufferLengthGetter || !resizableGetter) return null
    const length = lengthGetter.call(value) as number
    const offset = offsetGetter.call(value) as number
    const buffer = bufferGetter.call(value) as unknown
    if (!(buffer instanceof ArrayBuffer) || offset !== 0 || length !== 32) return null
    if (arrayBufferLengthGetter.call(buffer) !== length || resizableGetter.call(buffer) !== false) return null
    const copy = Buffer.alloc(32)
    copy.set(new Uint8Array(buffer, 0, length))
    return copy
  } catch {
    return null
  }
}

export function safeCurrent(check: () => boolean): boolean {
  try {
    return check() === true
  } catch {
    return false
  }
}

export function plainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(
    value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
  )
}

export function ownedBytes(source: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(new ArrayBuffer(source.byteLength))
  bytes.set(source)
  return bytes
}

function keyForRecord(key: Buffer, meetingId: string): Buffer {
  return Buffer.from(
    hkdfSync('sha256', key, Buffer.from(meetingId), Buffer.from('metis-incremental-meeting-record-v1'), 32)
  )
}

export function manifestBytes(core: ManifestCore, key: Buffer): Buffer {
  let currentLength = 0
  let envelope = ''
  for (let attempt = 0; attempt < 8; attempt++) {
    core.manifestBytes = currentLength
    const serializedCore = JSON.stringify(core)
    const hmac = createHmac('sha256', key).update(serializedCore).digest('hex')
    envelope = JSON.stringify({ ...core, hmac })
    const nextLength = Buffer.byteLength(envelope, 'utf8')
    if (nextLength === currentLength) return Buffer.from(envelope, 'utf8')
    currentLength = nextLength
  }
  throw new Error('MANIFEST_SIZE_UNSTABLE')
}

export function setManifestStoredBytes(core: ManifestCore, recordBytes: number, key: Buffer): Buffer {
  let total = recordBytes
  for (let attempt = 0; attempt < 8; attempt++) {
    core.storedBytes = total
    const encoded = manifestBytes(core, key)
    const next = recordBytes + encoded.byteLength
    if (next === total) return encoded
    encoded.fill(0)
    total = next
  }
  throw new Error('MANIFEST_SIZE_UNSTABLE')
}

export function validCounter(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

export function verifyManifest(bytes: Uint8Array, key: Buffer, meetingId: string): ManifestCore | null {
  try {
    if (bytes.byteLength === 0 || bytes.byteLength > 16_384) return null
    const parsed: unknown = JSON.parse(Buffer.from(bytes).toString('utf8'))
    if (!plainObject(parsed)) return null
    const keys = Object.keys(parsed).sort().join(',')
    if (
      keys !==
      'acceptedRevision,durableRevision,hmac,linePayloadBytes,manifestBytes,meetingId,pending,recordCount,state,storedBytes,version,wordCount'
    )
      return null
    const value = parsed as StoredManifest
    if (
      value.version !== MANIFEST_VERSION ||
      value.meetingId !== meetingId ||
      !['active', 'finalized', 'discarded'].includes(value.state) ||
      ![
        value.acceptedRevision,
        value.durableRevision,
        value.recordCount,
        value.wordCount,
        value.linePayloadBytes,
        value.storedBytes,
        value.manifestBytes
      ].every(validCounter) ||
      value.acceptedRevision !== value.durableRevision ||
      value.acceptedRevision < value.recordCount ||
      value.manifestBytes !== bytes.byteLength ||
      !SHA256.test(value.hmac) ||
      (value.recordCount === 0 ? value.linePayloadBytes !== 0 : value.linePayloadBytes < value.recordCount * 2) ||
      (value.pending === null && value.storedBytes < value.manifestBytes)
    )
      return null
    if (value.pending !== null) {
      const pending = value.pending
      if (
        !plainObject(pending) ||
        Object.keys(pending).sort().join(',') !==
          'identityHash,identityIndexBytes,indexBytes,nextRevision,priorManifestBytes,recordBytes,sha256' ||
        !SHA256.test(pending.identityHash) ||
        !SHA256.test(pending.sha256) ||
        !validCounter(pending.nextRevision) ||
        pending.nextRevision !== value.acceptedRevision + 1 ||
        !validCounter(pending.recordBytes) ||
        pending.recordBytes === 0 ||
        !validCounter(pending.indexBytes) ||
        pending.indexBytes === 0 ||
        !validCounter(pending.identityIndexBytes) ||
        pending.identityIndexBytes === 0 ||
        !validCounter(pending.priorManifestBytes) ||
        pending.priorManifestBytes === 0
      )
        return null
    }
    const core = { ...value } as ManifestCore & { hmac?: string }
    delete core.hmac
    const expected = createHmac('sha256', key).update(JSON.stringify(core)).digest()
    const actual = Buffer.from(value.hmac, 'hex')
    if (expected.byteLength !== actual.byteLength || !timingSafeEqual(expected, actual)) return null
    if (JSON.stringify({ ...core, hmac: value.hmac }) !== Buffer.from(bytes).toString('utf8')) return null
    return core
  } catch {
    return null
  }
}

export function snapshotFrom(core: ManifestCore): IncrementalJournalSnapshot {
  return {
    state: core.state,
    acceptedRevision: core.acceptedRevision,
    durableRevision: core.durableRevision,
    recordCount: core.recordCount,
    wordCount: core.wordCount,
    linePayloadBytes: core.linePayloadBytes,
    storedBytes: core.storedBytes
  }
}

export function encodeIndex(core: IndexCore, key: Buffer): Buffer {
  const payload = JSON.stringify(core)
  const hmac = createHmac('sha256', key).update(payload).digest('hex')
  return Buffer.from(JSON.stringify({ ...core, hmac }), 'utf8')
}

export function verifyIndex(bytes: Uint8Array, key: Buffer, meetingId: string, revision: number): IndexCore | null {
  return verifyIndexFor(bytes, key, meetingId, revision)
}

export function verifyIdentityIndex(
  bytes: Uint8Array,
  key: Buffer,
  meetingId: string,
  identityHash: string
): IndexCore | null {
  const value = verifyIndexFor(bytes, key, meetingId)
  return value && value.identityHash === identityHash ? value : null
}

function verifyIndexFor(bytes: Uint8Array, key: Buffer, meetingId: string, revision?: number): IndexCore | null {
  try {
    if (bytes.byteLength === 0 || bytes.byteLength > 512) return null
    const parsed: unknown = JSON.parse(Buffer.from(bytes).toString('utf8'))
    if (!plainObject(parsed)) return null
    if (
      Object.keys(parsed).sort().join(',') !== 'hmac,identityHash,meetingId,recordBytes,revision,sha256,version' ||
      parsed.version !== 1 ||
      parsed.meetingId !== meetingId ||
      !validCounter(parsed.revision) ||
      parsed.revision === 0 ||
      (revision !== undefined && parsed.revision !== revision) ||
      !Number.isSafeInteger(parsed.recordBytes) ||
      (parsed.recordBytes as number) <= 0 ||
      !SHA256.test(parsed.identityHash as string) ||
      !SHA256.test(parsed.sha256 as string) ||
      !SHA256.test(parsed.hmac as string)
    )
      return null
    const index = parsed as IndexCore & { hmac: string }
    const { hmac, ...core } = index
    const expected = createHmac('sha256', key).update(JSON.stringify(core)).digest()
    const actual = Buffer.from(hmac, 'hex')
    if (!timingSafeEqual(expected, actual)) return null
    if (JSON.stringify({ ...core, hmac }) !== Buffer.from(bytes).toString('utf8')) return null
    return core
  } catch {
    return null
  }
}

export function encodeRecord(
  request: IncrementalAppendCommit,
  canonicalBytes: Uint8Array,
  key: Buffer,
  maxRecordBytes: number
): Buffer {
  const metadata: RecordMetadata = {
    identityKey: request.identityKey,
    sha256: request.sha256,
    clock: request.clock,
    wordCount: request.recordWordCount,
    linePayloadBytes: request.recordLinePayloadBytes
  }
  const metadataBytes = Buffer.from(JSON.stringify(metadata), 'utf8')
  if (
    !Number.isSafeInteger(request.canonicalByteLength) ||
    request.canonicalByteLength <= 0 ||
    request.canonicalByteLength > maxRecordBytes ||
    canonicalBytes.byteLength !== request.canonicalByteLength ||
    4 + metadataBytes.byteLength + request.canonicalByteLength + RECORD_HEADER_BYTES > maxRecordBytes
  )
    throw new Error('RECORD_METADATA_LIMIT')
  const plaintext = Buffer.allocUnsafe(4 + metadataBytes.byteLength + request.canonicalByteLength)
  plaintext.writeUInt32BE(metadataBytes.byteLength, 0)
  metadataBytes.copy(plaintext, 4)
  Buffer.from(canonicalBytes).copy(plaintext, 4 + metadataBytes.byteLength)
  const iv = randomBytes(12)
  const revision = Buffer.allocUnsafe(8)
  revision.writeBigUInt64BE(BigInt(request.nextRevision), 0)
  const identityHash = createHmac('sha256', key).update(request.identityKey).digest('hex')
  const aad = Buffer.from(`${request.meetingId}/${identityHash}/${request.nextRevision}`, 'utf8')
  const cipherKey = keyForRecord(key, request.meetingId)
  try {
    const cipher = createCipheriv('aes-256-gcm', cipherKey, iv)
    cipher.setAAD(aad)
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
    const result = Buffer.alloc(RECORD_HEADER_BYTES + ciphertext.byteLength)
    RECORD_MAGIC.copy(result, 0)
    revision.copy(result, 4)
    iv.copy(result, 12)
    cipher.getAuthTag().copy(result, 24)
    ciphertext.copy(result, RECORD_HEADER_BYTES)
    return result
  } finally {
    plaintext.fill(0)
    metadataBytes.fill(0)
    iv.fill(0)
    revision.fill(0)
    aad.fill(0)
    cipherKey.fill(0)
  }
}

export function decodeRecord(
  bytes: Uint8Array,
  key: Buffer,
  meetingId: string,
  identityHash: string,
  expectedRevision: number
): { metadata: RecordMetadata; canonicalBytes: Buffer } | null {
  if (bytes.byteLength < RECORD_HEADER_BYTES + 4 || !Buffer.from(bytes.subarray(0, 4)).equals(RECORD_MAGIC)) return null
  const value = Buffer.from(bytes)
  const revisionValue = value.readBigUInt64BE(4)
  if (revisionValue > BigInt(Number.MAX_SAFE_INTEGER) || Number(revisionValue) !== expectedRevision) return null
  const revision = Number(revisionValue)
  const iv = value.subarray(12, 24)
  const tag = value.subarray(24, RECORD_HEADER_BYTES)
  const ciphertext = value.subarray(RECORD_HEADER_BYTES)
  const aad = Buffer.from(`${meetingId}/${identityHash}/${revision}`, 'utf8')
  const cipherKey = keyForRecord(key, meetingId)
  let plaintext: Buffer | undefined
  try {
    const decipher = createDecipheriv('aes-256-gcm', cipherKey, iv)
    decipher.setAAD(aad)
    decipher.setAuthTag(tag)
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
    if (plaintext.byteLength < 4) return null
    const metadataLength = plaintext.readUInt32BE(0)
    if (metadataLength <= 0 || 4 + metadataLength > plaintext.byteLength) return null
    const metadata = JSON.parse(plaintext.subarray(4, 4 + metadataLength).toString('utf8')) as unknown
    if (
      !plainObject(metadata) ||
      Object.keys(metadata).sort().join(',') !== 'clock,identityKey,linePayloadBytes,sha256,wordCount' ||
      typeof metadata.identityKey !== 'string' ||
      !SHA256.test(metadata.sha256 as string) ||
      typeof metadata.clock !== 'string' ||
      !/^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(metadata.clock) ||
      !validCounter(metadata.wordCount) ||
      !validCounter(metadata.linePayloadBytes)
    )
      return null
    const canonicalBytes = Buffer.from(plaintext.subarray(4 + metadataLength))
    if (createHmac('sha256', key).update(metadata.identityKey).digest('hex') !== identityHash) {
      canonicalBytes.fill(0)
      return null
    }
    const actualDigest = createHash('sha256').update(canonicalBytes).digest('hex')
    if (actualDigest !== metadata.sha256) {
      canonicalBytes.fill(0)
      return null
    }
    return { metadata: metadata as RecordMetadata, canonicalBytes }
  } catch {
    return null
  } finally {
    plaintext?.fill(0)
    aad.fill(0)
    cipherKey.fill(0)
  }
}

export function identityHash(identityKey: string, key: Buffer): string {
  return createHmac('sha256', key).update(identityKey).digest('hex')
}
