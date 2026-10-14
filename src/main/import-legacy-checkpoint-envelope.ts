import { createDecipheriv, createHash, type DecipherGCM } from 'node:crypto'
import { TextDecoder } from 'node:util'
import type { ImportLegacyBounds } from './import-legacy-checkpoint-contract'
import { LegacyJobJsonParser, type CodecEvent } from './import-legacy-checkpoint-codec'
import type { LegacyV2Descriptor } from './import-legacy-checkpoint-protocol'

export type EnvelopeEvent =
  | { type: 'record'; recordJson: Uint8Array; recordSequence: number }
  | { type: 'scan-complete'; descriptor: LegacyV2Descriptor; sourceDigest: string }
  | { type: 'complete'; event: Extract<CodecEvent, { type: 'complete' }>; sourceDigest: string }
  | { type: 'refused'; reason: 'LIMIT' | 'MALFORMED' }

/** Flat ATKENC2 envelope lexer. Ciphertext is decoded in quartets and never retained. */
export class LegacyV2EnvelopeStream {
  private readonly decoder = new TextDecoder('utf-8', { fatal: true })
  private readonly sourceHash = createHash('sha256')
  private readonly ctHash = createHash('sha256')
  private readonly keys = new Set<string>()
  private state: 'open' | 'key' | 'colon' | 'value' | 'comma' | 'done' = 'open'
  private inString = false
  private escaping = false
  private unicode: string | undefined
  private raw = ''
  private key = ''
  private currentValue = ''
  private readingKey = false
  private skipping = false
  private skipDepth = 0
  private skipRaw = ''
  private quote = false
  private skipEscape = false
  private ctQuartet = ''
  private ctEnded = false
  private ctBytes = 0
  private version: number | undefined
  private iv: string | undefined
  private tag: string | undefined
  private kLocal: string | undefined
  private kEscrow: string | undefined
  private decipher: DecipherGCM | undefined
  private gcmFinished = false
  private job: LegacyJobJsonParser | undefined
  private pinned: LegacyV2Descriptor | undefined
  private textTail = ''
  private failed: 'LIMIT' | 'MALFORMED' | undefined
  private descriptorBytes = 0

  constructor(
    private readonly bounds: ImportLegacyBounds,
    private readonly mode: 'scan' | 'decrypt'
  ) {}

  setKey(descriptor: LegacyV2Descriptor, key: Uint8Array): void {
    if (
      this.mode !== 'decrypt' ||
      this.pinned ||
      key.byteLength !== 32 ||
      key.byteOffset !== 0 ||
      key.buffer.byteLength !== 32
    )
      throw new Error('Invalid legacy V2 key handoff.')
    this.pinned = descriptor
    this.decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(descriptor.iv, 'base64'))
    this.decipher.setAuthTag(Buffer.from(descriptor.tag, 'base64'))
    this.job = new LegacyJobJsonParser(this.bounds)
    key.fill(0)
  }

  feed(bytes: Uint8Array): EnvelopeEvent | null {
    if (this.failed) return { type: 'refused', reason: this.failed }
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
      const event = this.consume(input[i])
      if (event) {
        this.textTail = input.slice(i + 1)
        return event
      }
      if (this.failed) return { type: 'refused', reason: this.failed }
    }
    return null
  }

  resume(): EnvelopeEvent | null {
    if (this.mode === 'decrypt' && this.job) {
      const event = this.job.resume()
      if (event?.type === 'record') return event
      if (event?.type === 'refused') return this.fail(event.reason)
    }
    const text = this.textTail
    this.textTail = ''
    for (let i = 0; i < text.length; i += 1) {
      const event = this.consume(text[i])
      if (event) {
        this.textTail = text.slice(i + 1)
        return event
      }
      if (this.failed) return { type: 'refused', reason: this.failed }
    }
    return null
  }

  finish(): EnvelopeEvent {
    if (this.failed) return { type: 'refused', reason: this.failed }
    try {
      const tail = this.decoder.decode()
      if (tail) {
        const event = this.feed(Buffer.from(tail, 'utf8'))
        if (event) return event
      }
    } catch {
      return this.fail('MALFORMED')
    }
    if (this.state !== 'done' || this.inString || this.skipping || this.ctQuartet !== '') return this.fail('MALFORMED')
    const descriptor = this.descriptor()
    if (!descriptor) return this.fail('MALFORMED')
    if (this.mode === 'scan') return { type: 'scan-complete', descriptor, sourceDigest: this.sourceHash.digest('hex') }
    if (!this.decipher || !this.job || !this.pinned || !sameDescriptor(descriptor, this.pinned))
      return this.fail('MALFORMED')
    try {
      if (!this.gcmFinished) {
        const final = this.decipher.final()
        this.gcmFinished = true
        try {
          const event = final.byteLength ? this.job.feed(final) : null
          if (event?.type === 'record') return event
          if (event?.type === 'refused') return this.fail(event.reason)
        } finally {
          final.fill(0)
        }
      }
      const completed = this.job.finish()
      if (completed.type !== 'complete') return this.fail('MALFORMED')
      return { type: 'complete', event: completed, sourceDigest: this.sourceHash.digest('hex') }
    } catch {
      return this.fail('MALFORMED')
    }
  }

  private consume(ch: string): EnvelopeEvent | null {
    const ciphertextValue = this.inString && !this.readingKey && this.key === 'ct'
    const ciphertextClosingQuote = ciphertextValue && ch === '"' && !this.escaping && this.unicode === undefined
    if (!ciphertextValue || ciphertextClosingQuote) {
      this.descriptorBytes += encodedCharBytes(ch)
      if (this.descriptorBytes > this.bounds.maxDescriptorBytes) return this.fail('LIMIT')
    }
    if (this.skipping) {
      this.skipRaw += ch
      if (this.skipRaw.length > this.bounds.maxDescriptorBytes) return this.fail('LIMIT')
      if (this.quote) {
        if (this.skipEscape) this.skipEscape = false
        else if (ch === '\\') this.skipEscape = true
        else if (ch === '"') this.quote = false
      } else if (ch === '"') this.quote = true
      else if (ch === '{' || ch === '[') this.skipDepth += 1
      else if (ch === '}' || ch === ']') {
        this.skipDepth -= 1
        if (this.skipDepth === 0) {
          try {
            JSON.parse(this.skipRaw)
          } catch {
            return this.fail('MALFORMED')
          }
          this.skipping = false
          this.state = 'comma'
          this.skipRaw = ''
        }
      }
      return null
    }
    if (this.inString) return this.stringChar(ch)
    if (this.state === 'done') return isJsonWhitespace(ch) ? null : this.fail('MALFORMED')
    if (this.state === 'value' && this.currentValue) {
      if (isJsonWhitespace(ch) || ch === ',' || ch === '}') {
        const result = this.finishScalar()
        if (result) return result
        if (isJsonWhitespace(ch)) return null
      } else if (/[0-9a-z+.-]/i.test(ch)) {
        this.currentValue += ch
        return null
      } else return this.fail('MALFORMED')
    }
    if (isJsonWhitespace(ch)) return null
    if (this.state === 'open' && ch === '{') {
      this.state = 'key'
      return null
    }
    if (this.state === 'key' && ch === '"') {
      this.inString = true
      this.readingKey = true
      this.raw = '"'
      return null
    }
    if (this.state === 'colon' && ch === ':') {
      this.state = 'value'
      return null
    }
    if (this.state === 'value' && ch === '"') {
      this.inString = true
      this.readingKey = false
      this.raw = known(this.key) && this.key !== 'ct' ? '"' : ''
      this.currentValue = ''
      return null
    }
    if (this.state === 'value' && (ch === '{' || ch === '[')) {
      if (known(this.key)) return this.fail('MALFORMED')
      this.skipping = true
      this.skipDepth = 1
      this.skipRaw = ch
      return null
    }
    if (this.state === 'value' && /[-0-9tfn]/.test(ch)) {
      this.currentValue = ch
      return null
    }
    if (this.state === 'comma' && ch === ',') {
      this.state = 'key'
      return null
    }
    if (this.state === 'comma' && ch === '}') {
      this.state = 'done'
      return null
    }
    return this.fail('MALFORMED')
  }

  private stringChar(ch: string): EnvelopeEvent | null {
    const keepRaw = this.readingKey || (known(this.key) && this.key !== 'ct')
    if (keepRaw) this.raw += ch
    if (this.raw.length > this.bounds.maxDescriptorBytes + 8) return this.fail('LIMIT')
    if (this.unicode !== undefined) {
      if (!/[0-9a-f]/i.test(ch)) return this.fail('MALFORMED')
      this.unicode += ch
      if (this.unicode.length === 4) {
        const value = String.fromCharCode(Number.parseInt(this.unicode, 16))
        this.unicode = undefined
        if (!this.readingKey && this.key === 'ct') {
          const event = this.ctChar(value)
          if (event) return event
        }
      }
      return null
    }
    if (ch.charCodeAt(0) < 0x20) return this.fail('MALFORMED')
    if (this.escaping) {
      this.escaping = false
      if (ch === 'u') {
        this.unicode = ''
        return null
      }
      if (!'"\\/bfnrt'.includes(ch)) return this.fail('MALFORMED')
      if (!this.readingKey && this.key === 'ct') {
        const escaped: Record<string, string> = {
          '"': '"',
          '\\': '\\',
          '/': '/',
          b: '\b',
          f: '\f',
          n: '\n',
          r: '\r',
          t: '\t'
        }
        const event = this.ctChar(escaped[ch])
        if (event) return event
      }
      return null
    }
    if (ch === '\\') {
      this.escaping = true
      return null
    }
    if (ch === '"') {
      this.inString = false
      if (this.readingKey) {
        let value: string
        try {
          value = JSON.parse(this.raw) as string
        } catch {
          return this.fail('MALFORMED')
        }
        if (this.keys.has(value)) return this.fail('MALFORMED')
        this.keys.add(value)
        this.key = value
        this.state = 'colon'
      } else {
        if (this.key === 'ct') {
          if (this.ctQuartet) return this.fail('MALFORMED')
          this.state = 'comma'
        } else if (!known(this.key)) {
          this.state = 'comma'
        } else {
          let value: string
          try {
            value = JSON.parse(this.raw) as string
          } catch {
            return this.fail('MALFORMED')
          }
          this.currentValue = value
          const event = this.finishStringValue()
          if (event) return event
        }
      }
      this.raw = ''
    } else if (!this.readingKey && this.key === 'ct') {
      const event = this.ctChar(ch)
      if (event) return event
    }
    return null
  }

  private ctChar(ch: string): EnvelopeEvent | null {
    if (this.ctEnded) return this.fail('MALFORMED')
    if (!/[A-Za-z0-9+/=]/.test(ch)) return this.fail('MALFORMED')
    this.ctQuartet += ch
    if (this.ctQuartet.length < 4) return null
    if (!/^(?:[A-Za-z0-9+/]{4}|[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)$/.test(this.ctQuartet))
      return this.fail('MALFORMED')
    const decoded = Buffer.from(this.ctQuartet, 'base64')
    try {
      if (decoded.toString('base64') !== this.ctQuartet) return this.fail('MALFORMED')
      if (this.ctQuartet.includes('=')) this.ctEnded = true
      this.ctHash.update(decoded)
      this.ctBytes += decoded.byteLength
      if (this.ctBytes > this.bounds.maxPhysicalBytes) return this.fail('LIMIT')
      this.ctQuartet = ''
      if (this.mode === 'decrypt') {
        if (!this.decipher || !this.job) return this.fail('MALFORMED')
        const plaintext = this.decipher.update(decoded)
        try {
          if (plaintext.byteLength) {
            const event = this.job.feed(plaintext)
            if (event?.type === 'record') return event
            if (event?.type === 'refused') return this.fail(event.reason)
          }
        } finally {
          plaintext.fill(0)
        }
      }
      return null
    } finally {
      decoded.fill(0)
    }
  }

  private finishStringValue(): EnvelopeEvent | null {
    if (!known(this.key)) {
      this.state = 'comma'
      return null
    }
    if (this.key === 'iv') this.iv = this.currentValue
    else if (this.key === 'tag') this.tag = this.currentValue
    else if (this.key === 'kLocal') this.kLocal = this.currentValue
    else if (this.key === 'kEscrow') this.kEscrow = this.currentValue
    else return this.fail('MALFORMED')
    if (Buffer.byteLength(this.currentValue, 'utf8') > this.bounds.maxDescriptorBytes) return this.fail('LIMIT')
    this.currentValue = ''
    this.state = 'comma'
    return null
  }

  private finishScalar(): EnvelopeEvent | null {
    if (
      !(
        this.currentValue === 'true' ||
        this.currentValue === 'false' ||
        this.currentValue === 'null' ||
        /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(this.currentValue)
      )
    )
      return this.fail('MALFORMED')
    if (this.key === 'v') {
      if (this.currentValue !== '2') return this.fail('MALFORMED')
      this.version = 2
    } else if (known(this.key)) return this.fail('MALFORMED')
    this.currentValue = ''
    this.state = 'comma'
    return null
  }

  private descriptor(): LegacyV2Descriptor | null {
    if (this.version !== 2 || !this.iv || !this.tag || !this.kLocal || this.ctBytes <= 0) return null
    const iv = strictBase64(this.iv)
    const tag = strictBase64(this.tag)
    if (!iv || iv.byteLength !== 12 || !tag || tag.byteLength !== 16) return null
    const descriptor: LegacyV2Descriptor = {
      v: 2,
      iv: this.iv,
      tag: this.tag,
      kLocal: this.kLocal,
      ...(this.kEscrow === undefined ? {} : { kEscrow: this.kEscrow }),
      ciphertextBytes: this.ctBytes,
      ciphertextSha256: this.ctHash.copy().digest('hex')
    }
    if (this.mode === 'decrypt' && this.pinned && !sameDescriptor(descriptor, this.pinned)) return null
    return descriptor
  }

  private fail(reason: 'LIMIT' | 'MALFORMED'): EnvelopeEvent {
    this.failed = reason
    return { type: 'refused', reason }
  }
}

function known(key: string): boolean {
  return ['v', 'iv', 'tag', 'ct', 'kLocal', 'kEscrow'].includes(key)
}
function strictBase64(value: string): Buffer | null {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return null
  const decoded = Buffer.from(value, 'base64')
  return decoded.toString('base64') === value ? decoded : null
}
function sameDescriptor(a: LegacyV2Descriptor, b: LegacyV2Descriptor): boolean {
  return (
    a.v === b.v &&
    a.iv === b.iv &&
    a.tag === b.tag &&
    a.kLocal === b.kLocal &&
    a.kEscrow === b.kEscrow &&
    a.ciphertextBytes === b.ciphertextBytes &&
    a.ciphertextSha256 === b.ciphertextSha256
  )
}

function encodedCharBytes(value: string): number {
  const code = value.charCodeAt(0)
  return code <= 0x7f ? 1 : code <= 0x7ff ? 2 : 3
}

function isJsonWhitespace(value: string): boolean {
  return value === ' ' || value === '\t' || value === '\n' || value === '\r'
}
