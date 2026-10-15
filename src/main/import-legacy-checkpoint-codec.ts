import { createHash } from 'node:crypto'
import { TextDecoder } from 'node:util'
import type { ImportJobHeader, ImportLegacyBounds, ImportLegacyTotals } from './import-legacy-checkpoint-contract'
import type { LegacyV2Descriptor } from './import-legacy-checkpoint-protocol'
import { TranscriptLineSchema } from '@shared/transcript-line'

type JsonScalar = string | number | boolean | null
type JsonValue = JsonScalar | JsonValue[] | { [key: string]: JsonValue }
type Frame = {
  kind: 'object' | 'array'
  value: JsonValue[] | { [key: string]: JsonValue }
  state: 'key' | 'colon' | 'value' | 'comma'
  key?: string
  keys: Set<string>
  streamLines: boolean
  lineParent: boolean
  discard: boolean
  children: number
  afterComma: boolean
}

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
  'updatedAt',
  'lines'
])

export type CodecEvent =
  | { type: 'record'; recordJson: Uint8Array; recordSequence: number }
  | { type: 'complete'; header: ImportJobHeader; totals: ImportLegacyTotals }
  | { type: 'refused'; reason: 'LIMIT' | 'MALFORMED' }

/** Incremental strict JSON parser. It never builds the `lines` array; it pauses at one line. */
export class LegacyJobJsonParser {
  private readonly decoder = new TextDecoder('utf-8', { fatal: true })
  private readonly frames: Frame[] = []
  private token = ''
  private string = false
  private escaped = false
  private unicodeLeft = 0
  private root: Record<string, JsonValue> | undefined
  private rootDone = false
  private textTail = ''
  private decodedBytes = 0
  private recordCount = 0
  private wordCount = 0
  private payloadBytes = 0
  private sourceHash = createHash('sha256')
  private digestTaken = false
  private refused: 'LIMIT' | 'MALFORMED' | undefined
  private headerBytes = 0
  private recordBytes = 0
  private recordDepth = 0
  private recordNodes = 0

  constructor(private readonly bounds: ImportLegacyBounds) {}

  sourceDigest(): string {
    if (this.digestTaken) throw new Error('Legacy source digest was already finalized.')
    this.digestTaken = true
    return this.sourceHash.digest('hex')
  }

  feed(bytes: Uint8Array): CodecEvent | null {
    if (this.refused) return { type: 'refused', reason: this.refused }
    this.decodedBytes += bytes.byteLength
    if (this.decodedBytes > this.bounds.maxDecodedBytes) return this.fail('LIMIT')
    this.sourceHash.update(bytes)
    let text: string
    try {
      text = this.decoder.decode(bytes, { stream: true })
    } catch {
      return this.fail('MALFORMED')
    }
    const input = this.textTail + text
    this.textTail = ''
    for (let i = 0; i < input.length; i += 1) {
      const event = this.consume(input[i], encodedCharBytesAt(input, i))
      if (event) {
        this.textTail = input.slice(i + 1)
        return event
      }
      if (this.refused) return { type: 'refused', reason: this.refused }
    }
    return null
  }

  resume(): CodecEvent | null {
    if (!this.textTail) return null
    const tail = this.textTail
    this.textTail = ''
    for (let i = 0; i < tail.length; i += 1) {
      const event = this.consume(tail[i], encodedCharBytesAt(tail, i))
      if (event) {
        this.textTail = tail.slice(i + 1)
        return event
      }
      if (this.refused) return { type: 'refused', reason: this.refused }
    }
    return null
  }

  finish(): CodecEvent {
    if (this.refused) return { type: 'refused', reason: this.refused }
    try {
      const last = this.decoder.decode()
      if (last) {
        const event = this.feed(Buffer.from(last, 'utf8'))
        if (event) return event
      }
    } catch {
      return this.fail('MALFORMED')
    }
    if (this.string || this.frames.length || !this.rootDone || this.textTail.trim().length)
      return this.fail('MALFORMED')
    const header = this.validateHeader()
    if (!header) return this.fail('MALFORMED')
    return {
      type: 'complete',
      header,
      totals: {
        records: this.recordCount,
        words: this.wordCount,
        payloadBytes: this.payloadBytes,
        decodedBytes: this.decodedBytes,
        physicalBytes: 0,
        sourceDigest: this.sourceHash.copy().digest('hex')
      }
    }
  }

  private consume(ch: string, byteLength: number): CodecEvent | null {
    if (this.rootDone) return isJsonWhitespace(ch) ? null : this.fail('MALFORMED')
    const startsRecord =
      ch === '{' &&
      this.frames[this.frames.length - 1]?.kind === 'array' &&
      this.frames[this.frames.length - 1]?.streamLines
    const startsLinesArray =
      ch === '[' && this.frames.length === 1 && this.frames[0]?.kind === 'object' && this.frames[0]?.key === 'lines'
    const insideLinesArray = this.frames.some((frame) => frame.kind === 'array' && frame.streamLines)
    if (startsRecord) this.recordBytes = 0
    if (this.inRecord() || startsRecord) {
      this.recordBytes += byteLength
      if (this.recordBytes > this.bounds.maxRecordBytes) return this.fail('LIMIT')
    } else if (!insideLinesArray && !startsLinesArray) {
      this.headerBytes += byteLength
      if (this.headerBytes > this.bounds.maxHeaderBytes) return this.fail('LIMIT')
    }
    if (this.string) {
      this.token += ch
      const tokenLimit = this.inRecord() ? this.bounds.maxRecordBytes : this.bounds.maxHeaderBytes
      if (this.token.length > Math.min(tokenLimit, this.bounds.maxFieldBytes * 6 + 16)) return this.fail('LIMIT')
      if (this.unicodeLeft > 0) {
        if (!/[0-9a-f]/i.test(ch)) return this.fail('MALFORMED')
        this.unicodeLeft -= 1
      } else if (this.escaped) {
        if (ch === 'u') this.unicodeLeft = 4
        else if (!'"\\/bfnrt'.includes(ch)) return this.fail('MALFORMED')
        this.escaped = false
      } else if (ch === '\\') this.escaped = true
      else if (ch === '"') {
        this.string = false
        const raw = this.token
        this.token = ''
        let value: string
        try {
          value = JSON.parse(raw) as string
        } catch {
          return this.fail('MALFORMED')
        }
        if (Buffer.byteLength(value, 'utf8') > this.bounds.maxFieldBytes) return this.fail('LIMIT')
        const top = this.frames[this.frames.length - 1]
        if (top?.kind === 'object' && top.state === 'key') {
          if (top.keys.has(value)) return this.fail('MALFORMED')
          if (++top.children > 32 || Buffer.byteLength(value, 'utf8') > 128) return this.fail('LIMIT')
          top.keys.add(value)
          top.key = value
          top.state = 'colon'
          top.afterComma = false
          if (this.inRecord()) this.recordNodes += 1
          return null
        }
        return this.value(value)
      }
      return null
    }
    if (isJsonWhitespace(ch)) {
      if (this.token) {
        const event = this.flushPrimitive()
        if (event) return event
      }
      return null
    }
    const top = this.frames[this.frames.length - 1]
    if (ch === '"') {
      if (this.token) return this.fail('MALFORMED')
      this.string = true
      this.token = '"'
      return null
    }
    if (ch === '{' || ch === '[') {
      if (this.token) return this.fail('MALFORMED')
      if (this.frames.length >= 8) return this.fail('LIMIT')
      const lineItem = top?.kind === 'array' && top.streamLines && ch === '{'
      const rootValue = this.frames.length === 1 && top?.kind === 'object'
      if (rootValue && (top.key !== 'lines' || ch !== '[')) {
        if (top.key && HEADER_FIELDS.has(top.key)) return this.fail('MALFORMED')
      }
      if (this.inRecord() || lineItem) {
        this.recordNodes += 1
        if (this.recordNodes > Math.min(4_096, this.bounds.maxRecordBytes) || this.frames.length > 8)
          return this.fail('LIMIT')
      }
      if (lineItem && top.children >= this.bounds.maxRecords) return this.fail('LIMIT')
      if (top?.kind === 'array' && !top.streamLines && top.children >= 256) return this.fail('LIMIT')
      const value: JsonValue[] | Record<string, JsonValue> =
        ch === '{' ? (Object.create(null) as Record<string, JsonValue>) : []
      const isLinesArray = ch === '[' && this.frames.length === 1 && top?.kind === 'object' && top.key === 'lines'
      const isLineRecord = lineItem
      const discard = this.discardsChild(top)
      const attached = this.attach(value as JsonValue)
      if (!attached) return this.fail('MALFORMED')
      this.frames.push({
        kind: ch === '{' ? 'object' : 'array',
        value,
        state: ch === '{' ? 'key' : 'value',
        keys: new Set(),
        streamLines: Boolean(isLinesArray),
        lineParent: Boolean(isLineRecord && ch === '{'),
        discard,
        children: 0,
        afterComma: false
      })
      if (isLineRecord) {
        this.recordDepth = 1
        this.recordNodes = 1
      } else if (this.recordDepth > 0) this.recordDepth += 1
      return null
    }
    if (ch === '}' || ch === ']') {
      const value = this.flushPrimitive()
      if (value) return value
      return this.close(ch)
    }
    if (ch === ':' || ch === ',') {
      if (ch === ':' && this.token) return this.fail('MALFORMED')
      const value = ch === ',' ? this.flushPrimitive() : null
      if (value) return value
      return this.punctuation(ch)
    }
    this.token += ch
    if (this.token.length > 128) return this.fail('LIMIT')
    return null
  }

  private punctuation(ch: ':' | ','): CodecEvent | null {
    const top = this.frames[this.frames.length - 1]
    if (!top) return this.fail('MALFORMED')
    if (ch === ':' && top.kind === 'object' && top.state === 'colon') {
      top.state = 'value'
      return null
    }
    if (ch === ',' && top.state === 'comma') {
      top.state = top.kind === 'object' ? 'key' : 'value'
      top.key = undefined
      top.afterComma = true
      return null
    }
    return this.fail('MALFORMED')
  }

  private flushPrimitive(): CodecEvent | null {
    if (!this.token) return null
    const raw = this.token
    this.token = ''
    let value: JsonValue
    if (raw === 'true') value = true
    else if (raw === 'false') value = false
    else if (raw === 'null') value = null
    else {
      if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(raw)) return this.fail('MALFORMED')
      value = Number(raw)
      if (!Number.isFinite(value)) return this.fail('MALFORMED')
    }
    return this.value(value)
  }

  private close(ch: '}' | ']'): CodecEvent | null {
    const frame = this.frames.pop()
    if (
      !frame ||
      (ch === '}' ? frame.kind !== 'object' : frame.kind !== 'array') ||
      (frame.state !== 'comma' &&
        !(frame.state === 'key' && frame.kind === 'object' && frame.children === 0) &&
        !(frame.state === 'value' && frame.kind === 'array' && frame.children === 0)) ||
      frame.afterComma
    )
      return this.fail('MALFORMED')
    if (this.recordDepth > 0) this.recordDepth -= 1
    if (this.frames.length === 0) {
      this.rootDone = true
      return null
    }
    if (frame.lineParent) return this.lineEvent(frame.value as Record<string, JsonValue>)
    return null
  }

  private value(value: JsonValue): CodecEvent | null {
    const top = this.frames[this.frames.length - 1]
    if (!top) {
      if (this.root || typeof value !== 'object' || value === null || Array.isArray(value))
        return this.fail('MALFORMED')
      this.root = value as Record<string, JsonValue>
      return null
    }
    if (top.state !== 'value') return this.fail('MALFORMED')
    if (top.kind === 'object') {
      if (typeof top.key !== 'string' || !top.keys.has(top.key)) return this.fail('MALFORMED')
      if (this.frames.length === 1 && top.key === 'lines' && !Array.isArray(value)) return this.fail('MALFORMED')
      if (!this.discardsChild(top))
        Object.defineProperty(top.value, top.key, { value, enumerable: true, configurable: true, writable: true })
      if (this.frames.length === 1 && top.key === 'lines') {
        return this.fail('MALFORMED')
      }
    } else if (top.streamLines) return this.fail('MALFORMED')
    else {
      if (++top.children > 256) return this.fail('LIMIT')
      if (!top.discard) (top.value as JsonValue[]).push(value)
    }
    if (this.inRecord()) this.recordNodes += 1
    if (this.recordNodes > Math.min(4_096, this.bounds.maxRecordBytes)) return this.fail('LIMIT')
    top.state = 'comma'
    top.afterComma = false
    return null
  }

  private attach(value: JsonValue): boolean {
    const top = this.frames[this.frames.length - 1]
    if (!top) {
      if (this.root || typeof value !== 'object' || value === null || Array.isArray(value)) return false
      this.root = value as Record<string, JsonValue>
      return true
    }
    if (top.state !== 'value') return false
    if (top.kind === 'object') {
      if (typeof top.key !== 'string' || !top.keys.has(top.key)) return false
      if (this.frames.length === 1 && top.key === 'lines' && !Array.isArray(value)) return false
      const discard = this.discardsChild(top)
      if (!discard)
        Object.defineProperty(top.value, top.key, { value, enumerable: true, configurable: true, writable: true })
      if (this.frames.length === 1 && top.key === 'lines') {
        if (!Array.isArray(value)) return false
      }
    } else if (top.streamLines) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false
      top.children += 1
      if (top.children > this.bounds.maxRecords) return false
    } else {
      if (++top.children > 256) return false
      if (!top.discard) (top.value as JsonValue[]).push(value)
    }
    top.state = 'comma'
    top.afterComma = false
    return true
  }

  private lineEvent(value: Record<string, JsonValue>): CodecEvent {
    const parsed = TranscriptLineSchema.safeParse(value)
    if (!parsed.success) return this.fail('MALFORMED')
    const serialized = JSON.stringify(parsed.data)
    const bytes = safeJsonByteLength(serialized, this.bounds.maxRecordBytes)
    if (bytes === undefined || this.recordCount >= this.bounds.maxRecords) return this.fail('LIMIT')
    const text = parsed.data.text
    const words = text.trim() ? text.trim().split(/\s+/u).length : 0
    const textBytes = Buffer.byteLength(text, 'utf8')
    const payload = bytes
    if (
      textBytes > this.bounds.maxFieldBytes ||
      this.wordCount + words > this.bounds.maxWords ||
      this.payloadBytes + payload > this.bounds.maxPayloadBytes
    )
      return this.fail('LIMIT')
    const recordJson = encodeSafeJson(serialized, payload)
    this.recordCount += 1
    this.wordCount += words
    this.payloadBytes += payload
    return { type: 'record', recordJson, recordSequence: this.recordCount - 1 }
  }

  private validateHeader(): ImportJobHeader | null {
    const v = this.root
    if (
      !v ||
      !Array.isArray(v.lines) ||
      v.lines.length !== 0 ||
      typeof v.jobId !== 'string' ||
      !/^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|[0-9a-f]{32})$/.test(
        v.jobId
      ) ||
      typeof v.sourcePath !== 'string' ||
      typeof v.sourceName !== 'string' ||
      typeof v.title !== 'string' ||
      ![
        'queued',
        'decoding',
        'transcribing',
        'saving',
        'recapping',
        'done',
        'failed',
        'policy-held',
        'cancelled'
      ].includes(String(v.state)) ||
      !Number.isSafeInteger(v.sourceSizeBytes) ||
      (v.sourceSizeBytes as number) <= 0 ||
      !Number.isFinite(v.sourceMtimeMs) ||
      !Number.isSafeInteger(v.cursor) ||
      !Number.isSafeInteger(v.totalChunks) ||
      !Number.isSafeInteger(v.createdAt) ||
      !Number.isSafeInteger(v.updatedAt)
    )
      return null
    const allowed = [
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
      'updatedAt',
      'lines'
    ]
    for (const key of ['file', 'error', 'recapError', 'mode'])
      if (v[key] !== undefined && typeof v[key] !== 'string') return null
    for (const key of ['chunkSec', 'durationMs'])
      if (v[key] !== undefined && (!Number.isFinite(v[key]) || (v[key] as number) < 0)) return null
    if (
      (v.cursor as number) < 0 ||
      (v.totalChunks as number) < 0 ||
      (v.createdAt as number) < 0 ||
      (v.updatedAt as number) < 0
    )
      return null
    if (
      v.progressPct !== undefined &&
      (!Number.isFinite(v.progressPct) || (v.progressPct as number) < 0 || (v.progressPct as number) > 100)
    )
      return null
    if (v.pipeline !== undefined && v.pipeline !== 'vad-v1' && v.pipeline !== 'vad-v2') return null
    const header = Object.create(null) as Record<string, JsonValue>
    for (const key of allowed) if (key !== 'lines' && Object.hasOwn(v, key)) header[key] = v[key]
    if (header.pipeline === undefined) header.pipeline = 'vad-v1'
    return header as unknown as ImportJobHeader
  }

  private fail(reason: 'LIMIT' | 'MALFORMED'): CodecEvent {
    this.refused = reason
    return { type: 'refused', reason }
  }

  private inRecord(): boolean {
    return this.recordDepth > 0
  }

  private discardsChild(parent: Frame | undefined): boolean {
    if (!parent) return false
    if (parent.discard) return true
    return (
      this.frames.length === 1 &&
      parent.kind === 'object' &&
      typeof parent.key === 'string' &&
      !HEADER_FIELDS.has(parent.key)
    )
  }
}

function safeJsonByteLength(value: string, maxBytes: number): number | undefined {
  let length = 0
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code === 0x3c || code === 0x3e) length += 6
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        length += 4
        index += 1
      } else length += 3
    } else length += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : 3
    if (length > maxBytes) return undefined
  }
  return length
}

function encodeSafeJson(value: string, byteLength: number): Uint8Array {
  const encoded = new Uint8Array(byteLength)
  let output = 0
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code === 0x3c || code === 0x3e) {
      encoded[output++] = 0x5c
      encoded[output++] = 0x75
      encoded[output++] = 0x30
      encoded[output++] = 0x30
      encoded[output++] = 0x33
      encoded[output++] = code === 0x3c ? 0x63 : 0x65
    } else if (code <= 0x7f) encoded[output++] = code
    else if (code <= 0x7ff) {
      encoded[output++] = 0xc0 | (code >> 6)
      encoded[output++] = 0x80 | (code & 0x3f)
    } else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        const point = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00)
        encoded[output++] = 0xf0 | (point >> 18)
        encoded[output++] = 0x80 | ((point >> 12) & 0x3f)
        encoded[output++] = 0x80 | ((point >> 6) & 0x3f)
        encoded[output++] = 0x80 | (point & 0x3f)
        index += 1
      } else {
        encoded[output++] = 0xef
        encoded[output++] = 0xbf
        encoded[output++] = 0xbd
      }
    } else {
      encoded[output++] = 0xe0 | (code >> 12)
      encoded[output++] = 0x80 | ((code >> 6) & 0x3f)
      encoded[output++] = 0x80 | (code & 0x3f)
    }
  }
  return encoded
}

function encodedCharBytesAt(value: string, index: number): number {
  const code = value.charCodeAt(index)
  if (code >= 0xdc00 && code <= 0xdfff) return 0
  if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
    const next = value.charCodeAt(index + 1)
    if (next >= 0xdc00 && next <= 0xdfff) return 4
  }
  return code <= 0x7f ? 1 : code <= 0x7ff ? 2 : 3
}

function isJsonWhitespace(value: string): boolean {
  return value === ' ' || value === '\t' || value === '\n' || value === '\r'
}

export function legacySourceDigest(hash: ReturnType<typeof createHash>): string {
  return hash.digest('hex')
}
export type LegacyCodecCompletion = { header: ImportJobHeader; totals: ImportLegacyTotals }
export type LegacyCodecDescriptor = LegacyV2Descriptor
