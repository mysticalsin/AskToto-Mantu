export interface FixedFloat32View {
  view: Float32Array
  length: number
}

export type WorkletFrame = {
  type: 'pcm-frame'
  sequence: number
  sampleOffset: number
  sampleRate: number
  audio: Float32Array
}

export type FlushAck = {
  type: 'flush-ack'
  requestId: string
  finalSequence: number
  finalSampleOffset: number
}

export type WorkletPortMessage =
  | { kind: 'frame'; frame: WorkletFrame }
  | { kind: 'flush'; ack: FlushAck }
  | { kind: 'invalid-request' }
  | { kind: 'order' }

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}

export function isSafeNonnegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

export function parseWorkletFrame(value: unknown): WorkletFrame | null {
  if (
    !isPlainRecord(value) ||
    !exactKeys(value, ['type', 'sequence', 'sampleOffset', 'sampleRate', 'audio']) ||
    value.type !== 'pcm-frame' ||
    !isSafeNonnegativeInteger(value.sequence) ||
    !isSafeNonnegativeInteger(value.sampleOffset) ||
    typeof value.sampleRate !== 'number' ||
    !Number.isFinite(value.sampleRate)
  )
    return null
  return value as unknown as WorkletFrame
}

export function parseFlushAck(value: unknown): FlushAck | null {
  if (
    !isPlainRecord(value) ||
    !exactKeys(value, ['type', 'requestId', 'finalSequence', 'finalSampleOffset']) ||
    value.type !== 'flush-ack' ||
    typeof value.requestId !== 'string' ||
    !isSafeNonnegativeInteger(value.finalSequence) ||
    !isSafeNonnegativeInteger(value.finalSampleOffset)
  )
    return null
  return value as unknown as FlushAck
}

export function parseWorkletPortMessage(value: unknown): WorkletPortMessage {
  if (!isPlainRecord(value) || typeof value.type !== 'string') return { kind: 'invalid-request' }
  if (value.type === 'pcm-frame') {
    const frame = parseWorkletFrame(value)
    return frame ? { kind: 'frame', frame } : { kind: 'invalid-request' }
  }
  if (value.type === 'flush-ack') {
    const ack = parseFlushAck(value)
    return ack ? { kind: 'flush', ack } : { kind: 'order' }
  }
  return { kind: 'invalid-request' }
}

const typedArrayPrototype = Object.getPrototypeOf(Float32Array.prototype) as object
const typedArrayBufferGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')?.get
const typedArrayByteOffsetGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset')?.get
const typedArrayByteLengthGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')?.get
const typedArrayLengthGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'length')?.get
const arrayBufferByteLengthGetter = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')?.get
const arrayBufferResizableGetter = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get

export function getFixedFloat32View(value: unknown): FixedFloat32View | null {
  if (
    !ArrayBuffer.isView(value) ||
    !typedArrayBufferGetter ||
    !typedArrayByteOffsetGetter ||
    !typedArrayByteLengthGetter ||
    !typedArrayLengthGetter
  )
    return null
  try {
    const buffer = typedArrayBufferGetter.call(value) as unknown
    if (!(buffer instanceof ArrayBuffer) || !arrayBufferByteLengthGetter) return null
    const bufferLength = arrayBufferByteLengthGetter.call(buffer) as number
    if (arrayBufferResizableGetter?.call(buffer) === true) return null
    const byteOffset = typedArrayByteOffsetGetter.call(value) as number
    const byteLength = typedArrayByteLengthGetter.call(value) as number
    const length = typedArrayLengthGetter.call(value) as number
    if (
      Object.getPrototypeOf(value) !== Float32Array.prototype ||
      !Number.isSafeInteger(bufferLength) ||
      !Number.isSafeInteger(byteOffset) ||
      !Number.isSafeInteger(byteLength) ||
      !Number.isSafeInteger(length) ||
      byteLength !== length * Float32Array.BYTES_PER_ELEMENT ||
      byteOffset + byteLength > bufferLength ||
      length <= 0
    )
      return null
    return { view: value as Float32Array, length }
  } catch {
    return null
  }
}

export function convertFloat32ToPcm16le(view: Float32Array, length: number): ArrayBuffer {
  const pcm16le = new ArrayBuffer(length * 2)
  const data = new DataView(pcm16le)
  for (let index = 0; index < length; index += 1) {
    const sample = Math.max(-1, Math.min(1, view[index]))
    const pcm = sample < 0 ? Math.round(sample * 32_768) : Math.round(sample * 32_767)
    data.setInt16(index * 2, pcm, true)
  }
  return pcm16le
}
