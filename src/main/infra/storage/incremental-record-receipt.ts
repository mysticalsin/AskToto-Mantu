import { createHash } from 'node:crypto'
import type { SpeechProvenanceLimits } from '@shared/meeting-speech-contract'
import { IncrementalMeetingRecordSchema, type CanonicalIncrementalRecord } from '@shared/incremental-meeting'
import { fitsIncrementalMeetingRecordPreflight } from './incremental-record-canonical'

export interface IncrementalRecordReceiptBinding {
  readonly ownerToken: object
  readonly meetingId: string
  readonly limits: SpeechProvenanceLimits
  readonly maxCanonicalBytes: number
  readonly isCurrent: () => boolean
}

export interface IncrementalRecordReceipt {
  readonly identityKey: string
  readonly sha256: string
  readonly canonicalByteLength: number
  readonly wordCount: number
  readonly linePayloadBytes: number
  readonly clock: string
}

type ReceiptBody = Omit<CanonicalIncrementalRecord, 'canonicalBytes'> & { canonicalBytes: Uint8Array }

const issued = new WeakMap<
  object,
  { binding: string; ownerToken: object; isCurrent: () => boolean; body: ReceiptBody }
>()
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const receiptKeys = 'canonicalByteLength,canonicalBytes,clock,identityKey,linePayloadBytes,sha256,wordCount'
const limitKeys = 'maxFieldBytes,maxPayloadBytes,maxRecordBytes,maxRecords,maxWords'

function safeCurrent(check: () => boolean): boolean {
  try {
    return check() === true
  } catch {
    return false
  }
}

function safeBinding(binding: IncrementalRecordReceiptBinding): boolean {
  try {
    return Boolean(
      binding &&
        typeof binding === 'object' &&
        binding.ownerToken &&
        typeof binding.ownerToken === 'object' &&
        uuid.test(binding.meetingId) &&
        typeof binding.isCurrent === 'function' &&
        binding.isCurrent() === true &&
        Object.keys(binding.limits).sort().join(',') === limitKeys &&
        Object.values(binding.limits).every((value) => Number.isSafeInteger(value) && value > 0) &&
        Number.isSafeInteger(binding.maxCanonicalBytes) &&
        binding.maxCanonicalBytes > 0
    )
  } catch {
    return false
  }
}

function bindingKey(binding: IncrementalRecordReceiptBinding): string {
  const values = ['maxFieldBytes', 'maxPayloadBytes', 'maxRecordBytes', 'maxRecords', 'maxWords'] as const
  return `${binding.meetingId}/${binding.maxCanonicalBytes}/${values.map((key) => binding.limits[key]).join('/')}`
}

function fixedByteCopy(value: unknown, maxBytes: number): Uint8Array | null {
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
    if (!(buffer instanceof ArrayBuffer) || offset !== 0 || length <= 0 || length > maxBytes) return null
    if (arrayBufferLengthGetter.call(buffer) !== length || resizableGetter.call(buffer) !== false) return null
    const copy = new Uint8Array(new ArrayBuffer(length))
    copy.set(new Uint8Array(buffer, 0, length))
    return copy
  } catch {
    return null
  }
}

function canonicalJson(value: unknown): string {
  const result = JSON.stringify(value)
  if (typeof result !== 'string') throw new Error('INVALID_RECORD')
  return result.replaceAll('<', '\\u003c').replaceAll('>', '\\u003e')
}

function displayClock(timestamp: number): string {
  const date = new Date(timestamp)
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map((part) => String(part).padStart(2, '0')).join(':')
}

function dataObject(value: unknown): value is Record<string, unknown> {
  try {
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    )
      return false
    return Object.values(Object.getOwnPropertyDescriptors(value)).every((descriptor) => 'value' in descriptor)
  } catch {
    return false
  }
}

/** Called only after the main worker host has accepted a response for the still-current owner. */
export function issueIncrementalRecordReceipt(
  value: unknown,
  binding: IncrementalRecordReceiptBinding
): IncrementalRecordReceipt | null {
  if (!safeBinding(binding) || !dataObject(value) || Object.keys(value).sort().join(',') !== receiptKeys) return null
  const capturedBinding: IncrementalRecordReceiptBinding = Object.freeze({
    ownerToken: binding.ownerToken,
    meetingId: binding.meetingId,
    limits: Object.freeze({ ...binding.limits }),
    maxCanonicalBytes: binding.maxCanonicalBytes,
    isCurrent: binding.isCurrent
  })
  if (!safeBinding(capturedBinding)) return null
  const candidate = value as Partial<CanonicalIncrementalRecord>
  const bytes = fixedByteCopy(candidate.canonicalBytes, capturedBinding.maxCanonicalBytes)
  if (
    !bytes ||
    typeof candidate.identityKey !== 'string' ||
    typeof candidate.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(candidate.sha256) ||
    !Number.isSafeInteger(candidate.wordCount) ||
    candidate.wordCount! < 0 ||
    candidate.wordCount! > capturedBinding.limits.maxWords ||
    !Number.isSafeInteger(candidate.linePayloadBytes) ||
    candidate.linePayloadBytes! <= 0 ||
    candidate.linePayloadBytes! > capturedBinding.limits.maxRecordBytes ||
    candidate.canonicalByteLength !== bytes.byteLength ||
    typeof candidate.clock !== 'string' ||
    !/^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(candidate.clock)
  ) {
    bytes?.fill(0)
    return null
  }
  let stored = false
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    const parsed = IncrementalMeetingRecordSchema.safeParse(JSON.parse(text))
    if (!parsed.success) return null
    const record = parsed.data
    if (!fitsIncrementalMeetingRecordPreflight(record, capturedBinding.limits, capturedBinding.maxCanonicalBytes))
      return null
    const identityKey = canonicalJson(record.identity)
    const expected = Buffer.from(canonicalJson(record), 'utf8')
    try {
      const wordCount = record.line.speech?.words?.length ?? 0
      const linePayloadBytes = Buffer.byteLength(canonicalJson(record.line), 'utf8')
      const sha256 = createHash('sha256').update(expected).digest('hex')
      if (
        !expected.equals(bytes) ||
        identityKey !== candidate.identityKey ||
        sha256 !== candidate.sha256 ||
        wordCount !== candidate.wordCount ||
        linePayloadBytes !== candidate.linePayloadBytes ||
        displayClock(record.line.t) !== candidate.clock
      )
        return null
      const body: ReceiptBody = {
        identityKey,
        sha256,
        canonicalByteLength: bytes.byteLength,
        canonicalBytes: bytes,
        wordCount,
        linePayloadBytes,
        clock: candidate.clock
      }
      const receipt = Object.freeze({
        identityKey,
        sha256,
        canonicalByteLength: bytes.byteLength,
        wordCount,
        linePayloadBytes,
        clock: candidate.clock
      })
      issued.set(receipt, {
        binding: bindingKey(capturedBinding),
        ownerToken: capturedBinding.ownerToken,
        isCurrent: capturedBinding.isCurrent,
        body
      })
      stored = true
      return receipt
    } finally {
      expected.fill(0)
    }
  } catch {
    return null
  } finally {
    if (!stored) bytes.fill(0)
  }
}

/** Consumes a one-use receipt and returns its private byte copy only to its captured owner. */
export function consumeIncrementalRecordReceipt(
  receipt: IncrementalRecordReceipt,
  binding: IncrementalRecordReceiptBinding
): CanonicalIncrementalRecord | null {
  if (!safeBinding(binding) || !receipt || typeof receipt !== 'object') return null
  const value = issued.get(receipt)
  if (
    !value ||
    value.ownerToken !== binding.ownerToken ||
    value.isCurrent !== binding.isCurrent ||
    value.binding !== bindingKey(binding) ||
    !safeCurrent(value.isCurrent)
  )
    return null
  issued.delete(receipt)
  return value.body
}

export function inspectIncrementalRecordReceipt(
  receipt: IncrementalRecordReceipt,
  binding: IncrementalRecordReceiptBinding
): Omit<CanonicalIncrementalRecord, 'canonicalBytes'> | null {
  if (!safeBinding(binding) || !receipt || typeof receipt !== 'object') return null
  const value = issued.get(receipt)
  if (
    !value ||
    value.ownerToken !== binding.ownerToken ||
    value.isCurrent !== binding.isCurrent ||
    value.binding !== bindingKey(binding) ||
    !safeCurrent(value.isCurrent)
  )
    return null
  const { canonicalBytes: _canonicalBytes, ...metadata } = value.body
  return Object.freeze({ ...metadata })
}

export function discardIncrementalRecordReceipt(receipt: IncrementalRecordReceipt | undefined): void {
  if (!receipt || typeof receipt !== 'object') return
  const value = issued.get(receipt)
  if (!value) return
  issued.delete(receipt)
  value.body.canonicalBytes.fill(0)
}
