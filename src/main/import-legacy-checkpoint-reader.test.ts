import { createCipheriv, createHash, randomBytes } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  ImportLegacyAdapterError,
  type ImportLegacyBounds,
  type ImportLegacyCheckpointReaderOptions,
  type ImportLegacyHeldSource,
  type ImportLegacySourceAdmission,
  type ImportOperationScope
} from './import-legacy-checkpoint-contract'
import { LegacyJobJsonParser } from './import-legacy-checkpoint-codec'
import { LegacyV2EnvelopeStream } from './import-legacy-checkpoint-envelope'
import type { LegacyOutput } from './import-legacy-checkpoint-protocol'
import { createImportLegacyCheckpointReader } from './import-legacy-checkpoint-reader'

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function successfulPlainWorker(file: Buffer) {
  let message: ((value: unknown) => void) | undefined
  let sessionId = ''
  let nextSequence = 0
  const header = Object.fromEntries(Object.entries(fixture).filter(([key]) => key !== 'lines'))
  const sourceDigest = createHash('sha256').update(file).digest('hex')
  return {
    onMessage(listener: (value: unknown) => void) {
      message = listener
    },
    onError() {},
    onExit() {},
    post(value: unknown) {
      const input = value as { op?: string; sessionId?: string; sequence?: number }
      if (input.op === 'open') {
        sessionId = input.sessionId!
        message?.({ protocol: 1, type: 'input-credit', sessionId, nextSequence: 0 })
      } else if (input.op === 'chunk') {
        nextSequence = input.sequence! + 1
        message?.({ protocol: 1, type: 'input-credit', sessionId, nextSequence })
      } else if (input.op === 'end') {
        message?.({
          protocol: 1,
          type: 'complete',
          sessionId,
          header: header as never,
          totals: { records: 2, words: 5, payloadBytes: 80, decodedBytes: file.byteLength },
          sourceDigest
        })
      }
    },
    terminate: async () => {}
  }
}

function publishedReadHarness(options: {
  operationDeadlineMs: number
  close?: () => Promise<void>
  account?: () => Promise<void>
  abort?: () => Promise<void>
  onPublished?: () => void
  onCloseStarted?: () => void
  onAccountStarted?: () => void
  onAbortStarted?: () => void
}) {
  const file = Buffer.from(JSON.stringify(fixture))
  const version = { dev: 1, ino: 2, nlink: 1, size: file.byteLength, mtimeMs: 3, ctimeMs: 4 }
  const scope = Object.freeze({}) as ImportOperationScope
  const metrics = { settled: 0, abortRequests: 0, aborts: 0, quarantines: [] as string[] }
  const reader = createImportLegacyCheckpointReader({
    authority: { assertCurrent: () => {}, refreshSameScope: async () => {} },
    resources: {
      acquire: async () => ({
        settled: async () => {
          metrics.settled += 1
          options.onAccountStarted?.()
          await options.account?.()
        },
        quarantine: (reason) => metrics.quarantines.push(reason)
      })
    },
    source: {
      open: async () => ({
        version,
        readAt: async (position, target) => {
          const length = Math.min(target.byteLength, file.byteLength - position)
          target.set(file.subarray(position, position + length))
          return length
        },
        requestCancel: () => {},
        assertCurrentVersion: async () => {},
        admitOriginalSource: async () => ({ assertCurrent: () => {} }) as ImportLegacySourceAdmission,
        settled: async () => {},
        close: async () => {
          options.onCloseStarted?.()
          await options.close?.()
        }
      })
    },
    keys: { unwrapV2: async () => new Uint8Array(32) },
    candidate: {
      begin: async () => ({
        append: async () => {},
        requestAbortOwnedCandidate: () => {
          metrics.abortRequests += 1
        },
        abortOwnedCandidate: async () => {
          metrics.aborts += 1
          options.onAbortStarted?.()
          await options.abort?.()
        },
        publish: async () => {
          options.onPublished?.()
          return Object.freeze({}) as never
        }
      })
    },
    createWorker: async () => successfulPlainWorker(file),
    bounds: () => ({ ...bounds, operationDeadlineMs: options.operationDeadlineMs })
  })
  return { read: () => reader(fixture.jobId, scope), metrics }
}

const bounds: ImportLegacyBounds = {
  maxPhysicalBytes: 64 * 1024,
  maxDecodedBytes: 32 * 1024,
  maxDescriptorBytes: 4 * 1024,
  maxHeaderBytes: 8 * 1024,
  maxChunkBytes: 8 * 1024,
  maxResidentBytes: 256 * 1024,
  maxStagingBytes: 128 * 1024,
  maxGlobalResidentBytes: 256 * 1024,
  maxGlobalStagingBytes: 128 * 1024,
  maxGlobalReadSlots: 1,
  maxGlobalWriteSlots: 1,
  maxGlobalCredits: 1,
  maxGlobalSettlingOperations: 1,
  maxRecords: 20,
  maxWords: 1_000,
  maxFieldBytes: 4 * 1024,
  maxRecordBytes: 8 * 1024,
  maxPayloadBytes: 16 * 1024,
  operationDeadlineMs: 5_000,
  shutdownDeadlineMs: 2_000,
  nativeV1: { unavailable: true }
}

const fixture = {
  lines: [
    { speaker: 'you', text: 'first 🧪 line', t: 1_700_000_000_001, name: 'Owner' },
    { speaker: 'unknown', text: 'second line', t: 1_700_000_000_002, lang: 'English' }
  ],
  unknownFutureField: { nested: ['ignored', { safely: true }] },
  jobId: '7a29e174-80f0-4f32-b97e-2cc9c8c80b77',
  sourcePath: '/synthetic/meeting.wav',
  sourceName: 'meeting.wav',
  sourceSizeBytes: 99,
  sourceMtimeMs: 1_700_000_000_000.5,
  title: 'Synthetic import',
  state: 'transcribing',
  cursor: 2,
  totalChunks: 3,
  pipeline: 'vad-v2',
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_100
}

function consumeParser(bytes: Uint8Array, step: number): { records: string[]; completed: boolean } {
  const parser = new LegacyJobJsonParser(bounds)
  const records: string[] = []
  for (let offset = 0; offset < bytes.byteLength; offset += step) {
    let event = parser.feed(bytes.subarray(offset, Math.min(bytes.byteLength, offset + step)))
    while (event) {
      if (event.type === 'refused') throw new Error(event.reason)
      if (event.type === 'record') records.push(new TextDecoder().decode(event.recordJson))
      event = parser.resume()
    }
  }
  const final = parser.finish()
  if (final.type !== 'complete') throw new Error(final.type === 'refused' ? final.reason : 'record')
  return { records, completed: true }
}

function drainParser(parser: LegacyJobJsonParser, bytes: Uint8Array) {
  let event = parser.feed(bytes)
  while (event?.type === 'record') event = parser.resume()
  return event ?? parser.finish()
}

function consumeEnvelope(stream: LegacyV2EnvelopeStream, bytes: Uint8Array, step: number): LegacyOutput | null {
  for (let offset = 0; offset < bytes.byteLength; offset += step) {
    let event = stream.feed(bytes.subarray(offset, Math.min(bytes.byteLength, offset + step)))
    if (event?.type === 'record') {
      event = stream.resume()
      while (event?.type === 'record') event = stream.resume()
    }
    if (event?.type === 'refused') return { protocol: 1, type: 'refused', sessionId: 's', reason: event.reason }
  }
  const final = stream.finish()
  if (final.type === 'refused') return { protocol: 1, type: 'refused', sessionId: 's', reason: final.reason }
  if (final.type === 'scan-complete')
    return {
      protocol: 1,
      type: 'scan-complete',
      sessionId: 's',
      descriptor: final.descriptor,
      sourceDigest: final.sourceDigest
    }
  if (final.type === 'complete')
    return {
      protocol: 1,
      type: 'complete',
      sessionId: 's',
      header: final.event.header,
      totals: {
        records: final.event.totals.records,
        words: final.event.totals.words,
        payloadBytes: final.event.totals.payloadBytes,
        decodedBytes: final.event.totals.decodedBytes
      },
      sourceDigest: final.sourceDigest
    }
  return null
}

describe('bounded legacy checkpoint codec', () => {
  it('preserves the old job header and streams records through arbitrary UTF-8, escape, and field-order splits', () => {
    const document = Buffer.from(JSON.stringify(fixture).replace('🧪', '\\uD83E\\uDDEA'))
    const expected = fixture.lines.map((line) => JSON.stringify(line))
    for (let size = 1; size <= 17; size += 1) {
      const result = consumeParser(document, size)
      expect(result.completed).toBe(true)
      expect(result.records).toEqual(expected)
    }
  })

  it('rejects duplicate keys, trailing documents, and a header over its admitted limit', () => {
    const duplicate = Buffer.from(
      '{"jobId":"7a29e174-80f0-4f32-b97e-2cc9c8c80b77","jobId":"7a29e174-80f0-4f32-b97e-2cc9c8c80b77"}'
    )
    const parser = new LegacyJobJsonParser(bounds)
    for (const byte of duplicate) parser.feed(Uint8Array.of(byte))
    expect(parser.finish()).toMatchObject({ type: 'refused', reason: 'MALFORMED' })

    const trailing = new LegacyJobJsonParser(bounds)
    const valid = Buffer.from(JSON.stringify(fixture) + '{}')
    for (let offset = 0; offset < valid.length; offset += 13) trailing.feed(valid.subarray(offset, offset + 13))
    expect(trailing.finish()).toMatchObject({ type: 'refused', reason: 'MALFORMED' })

    const limited = new LegacyJobJsonParser({ ...bounds, maxHeaderBytes: 8 })
    expect(limited.feed(Buffer.from(JSON.stringify(fixture)))).toMatchObject({ type: 'refused', reason: 'LIMIT' })
  })

  it('keeps the header budget active after streamed lines and counts ordinary array children once', () => {
    const validHeader = {
      jobId: fixture.jobId,
      sourcePath: fixture.sourcePath,
      sourceName: fixture.sourceName,
      sourceSizeBytes: fixture.sourceSizeBytes,
      sourceMtimeMs: fixture.sourceMtimeMs,
      title: fixture.title,
      state: fixture.state,
      cursor: fixture.cursor,
      totalChunks: fixture.totalChunks,
      createdAt: fixture.createdAt,
      updatedAt: fixture.updatedAt
    }
    const headerBounds = {
      ...bounds,
      maxHeaderBytes: 512,
      maxFieldBytes: 128,
      maxRecordBytes: 128,
      maxDecodedBytes: 65_536
    }
    const oversizedUnknown = Array.from({ length: 200 }, () => 'x'.repeat(100))
    const orderedHeaders = [
      { lines: [], ...validHeader, future: oversizedUnknown },
      { ...validHeader, lines: [], future: oversizedUnknown },
      { ...validHeader, future: oversizedUnknown, lines: [] }
    ]
    for (const header of orderedHeaders) {
      const headerBound = new LegacyJobJsonParser(headerBounds)
      expect(headerBound.feed(Buffer.from(JSON.stringify(header)))).toMatchObject({ type: 'refused', reason: 'LIMIT' })
    }

    const line = { speaker: 'you', text: 'ok', t: 1 }
    const retainedHeader = JSON.stringify({ ...validHeader, lines: [line] })
    const retainedHeaderBytes = Buffer.byteLength(retainedHeader) - Buffer.byteLength(JSON.stringify([line]))
    const exactHeader = new LegacyJobJsonParser({ ...bounds, maxHeaderBytes: retainedHeaderBytes })
    let exactEvent = exactHeader.feed(Buffer.from(retainedHeader))
    while (exactEvent?.type === 'record') exactEvent = exactHeader.resume()
    expect(exactEvent ?? exactHeader.finish()).toMatchObject({ type: 'complete' })
    const shortHeader = new LegacyJobJsonParser({ ...bounds, maxHeaderBytes: retainedHeaderBytes - 1 })
    expect(drainParser(shortHeader, Buffer.from(retainedHeader))).toMatchObject({ type: 'refused', reason: 'LIMIT' })

    const childValues = [
      Array.from({ length: 256 }, (_, index) => index),
      Array.from({ length: 256 }, () => ({ value: 1 })),
      Array.from({ length: 256 }, () => [1])
    ]
    for (const values of childValues) {
      const atLimit = new LegacyJobJsonParser(bounds)
      expect(drainParser(atLimit, Buffer.from(JSON.stringify({ ...fixture, future: values })))).toMatchObject({
        type: 'complete'
      })
      const overLimit = new LegacyJobJsonParser(bounds)
      expect(
        drainParser(overLimit, Buffer.from(JSON.stringify({ ...fixture, future: [...values, values[0]] })))
      ).toMatchObject({ type: 'refused', reason: 'LIMIT' })
    }
  })

  it('counts line records once, supports histories above 256, and charges exact UTF-8 record bytes', () => {
    const oneLine = {
      lines: [fixture.lines[0]],
      ...Object.fromEntries(Object.entries(fixture).filter(([key]) => key !== 'lines'))
    }
    const one = consumeParser(Buffer.from(JSON.stringify(oneLine)), 7)
    expect(one.records).toHaveLength(1)

    const manyLines = Array.from({ length: 257 }, (_, index) => ({
      speaker: 'you',
      text: '🧪 line',
      t: 1_700_000_000_001 + index
    }))
    const many = { ...oneLine, lines: manyLines }
    const manyBounds = {
      ...bounds,
      maxDecodedBytes: 64_000,
      maxRecords: 300,
      maxWords: 1_000,
      maxPayloadBytes: 32_000,
      maxHeaderBytes: 1_024
    }
    const parser = new LegacyJobJsonParser(manyBounds)
    const bytes = Buffer.from(JSON.stringify(many))
    let records = 0
    for (let offset = 0; offset < bytes.byteLength; offset += 1_000) {
      let event = parser.feed(bytes.subarray(offset, Math.min(bytes.byteLength, offset + 1_000)))
      while (event) {
        if (event.type === 'refused') throw new Error(event.reason)
        records += 1
        event = parser.resume()
      }
    }
    expect(parser.finish()).toMatchObject({ type: 'complete', totals: { records: 257 } })
    expect(records).toBe(257)

    const rowJson = JSON.stringify(manyLines[0])
    const rowBytes = Buffer.byteLength(rowJson)
    const exactLimit = new LegacyJobJsonParser({ ...bounds, maxRecordBytes: rowBytes, maxPayloadBytes: 16_384 })
    for (const byte of Buffer.from(JSON.stringify({ ...oneLine, lines: [manyLines[0]] }))) {
      const event = exactLimit.feed(Uint8Array.of(byte))
      if (event?.type === 'record') exactLimit.resume()
    }
    expect(exactLimit.finish()).toMatchObject({ type: 'complete' })
    const belowLimit = new LegacyJobJsonParser({ ...bounds, maxRecordBytes: rowBytes - 1, maxPayloadBytes: 16_384 })
    expect(belowLimit.feed(Buffer.from(JSON.stringify({ ...oneLine, lines: [manyLines[0]] })))).toMatchObject({
      type: 'refused',
      reason: 'LIMIT'
    })
  })

  it('defaults the missing legacy pipeline to the historical fixed-slab API value', () => {
    const legacy = { ...fixture, pipeline: undefined }
    const parser = new LegacyJobJsonParser(bounds)
    const bytes = Buffer.from(JSON.stringify(legacy))
    for (let offset = 0; offset < bytes.byteLength; offset += 23) parser.feed(bytes.subarray(offset, offset + 23))
    expect(parser.finish()).toMatchObject({ type: 'complete', header: { pipeline: 'vad-v1' } })
  })

  it('accepts JSON with a __proto__ data key without changing header prototype semantics', () => {
    const encoded = JSON.stringify(fixture).replace('"unknownFutureField":', '"__proto__":')
    const parsed = new LegacyJobJsonParser(bounds)
    for (let offset = 0; offset < encoded.length; offset += 11)
      parsed.feed(Buffer.from(encoded.slice(offset, offset + 11)))
    const result = parsed.finish()
    expect(result.type).toBe('complete')
    if (result.type === 'complete') {
      expect(result.header.jobId).toBe(fixture.jobId)
      expect(Object.getPrototypeOf(result.header)).toBeNull()
      expect(Object.hasOwn(result.header, '__proto__')).toBe(false)
    }
  })

  it.each([
    (value: string) => value.replace('"updatedAt":1700000000100', '"updatedAt":'),
    (value: string) => value.replace('"title":"Synthetic import"', '"title":"Synthetic import"\u000b'),
    (value: string) => value.replace('"title":"Synthetic import"', '"title":"Synthetic import"\u00a0')
  ])('refuses job JSON that JSON.parse also rejects at every byte split', (mutate) => {
    const invalid = mutate(JSON.stringify(fixture))
    expect(() => JSON.parse(invalid)).toThrow()
    const bytes = Buffer.from(invalid)
    for (let split = 0; split <= bytes.byteLength; split += 1) {
      const parser = new LegacyJobJsonParser(bounds)
      let event = parser.feed(bytes.subarray(0, split))
      while (event?.type === 'record') event = parser.resume()
      if (!event || event.type === 'complete') event = parser.feed(bytes.subarray(split))
      while (event?.type === 'record') event = parser.resume()
      if (!event) event = parser.finish()
      expect(event).toMatchObject({ type: 'refused', reason: 'MALFORMED' })
    }
  })

  it.each(['true', '123'])('rejects a valid job followed by the un-delimited JSON token %s', (trailer) => {
    const encoded = Buffer.from(`${JSON.stringify(fixture)}${trailer}`)
    const parser = new LegacyJobJsonParser(bounds)
    let event = parser.feed(encoded)
    while (event?.type === 'record') event = parser.resume()
    if (!event) event = parser.finish()
    expect(event).toMatchObject({ type: 'refused', reason: 'MALFORMED' })
  })

  it('rejects a new string token after a complete primitive in an ignored header field', () => {
    const encoded = JSON.stringify(fixture).replace(
      '"unknownFutureField":{"nested":["ignored",{"safely":true}]}',
      '"unknownFutureField":1"ok"'
    )
    expect(() => JSON.parse(encoded)).toThrow()
    const parser = new LegacyJobJsonParser(bounds)
    let event = parser.feed(Buffer.from(encoded))
    while (event?.type === 'record') event = parser.resume()
    if (!event) event = parser.finish()
    expect(event).toMatchObject({ type: 'refused', reason: 'MALFORMED' })
  })

  it('counts safe-JSON escaped record bytes without materializing an expanded string', () => {
    const line = { speaker: 'you', text: '<'.repeat(100), t: 1_700_000_000_001 }
    const row = JSON.stringify(line)
    const safeBytes = Buffer.byteLength(row) + 5 * line.text.length
    const parser = new LegacyJobJsonParser({
      ...bounds,
      maxFieldBytes: 256,
      maxRecordBytes: safeBytes,
      maxPayloadBytes: safeBytes
    })
    const encoded = Buffer.from(JSON.stringify({ ...fixture, lines: [line] }))
    let event = parser.feed(encoded)
    while (event?.type === 'record') {
      expect(event.recordJson.byteLength).toBe(safeBytes)
      expect(new TextDecoder().decode(event.recordJson)).toBe(row.replaceAll('<', '\\u003c'))
      event = parser.resume()
    }
    expect(parser.finish()).toMatchObject({ type: 'complete', totals: { payloadBytes: safeBytes } })
    const short = new LegacyJobJsonParser({
      ...bounds,
      maxFieldBytes: 256,
      maxRecordBytes: safeBytes - 1,
      maxPayloadBytes: safeBytes
    })
    expect(short.feed(encoded)).toMatchObject({ type: 'refused', reason: 'LIMIT' })
  })

  it('rejects ciphertext bytes after a padded base64 quartet', () => {
    const envelope = Buffer.from(
      JSON.stringify({
        v: 2,
        iv: randomBytes(12).toString('base64'),
        tag: randomBytes(16).toString('base64'),
        ct: 'AA==A',
        kLocal: 'F:wrapped'
      })
    )
    expect(consumeEnvelope(new LegacyV2EnvelopeStream(bounds, 'scan'), envelope, 5)).toMatchObject({
      type: 'refused',
      reason: 'MALFORMED'
    })
  })

  it.each([
    '{"v":2 "iv":"AAAAAAAAAAAAAAAA","tag":"AAAAAAAAAAAAAAAAAAAAAA==","ct":"AAAA","kLocal":"F:key"}',
    '{"v":2,"iv":"AAAAAAAAAAAAAAAA","tag":"AAAAAAAAAAAAAAAAAAAAAA==","ct":"AAAA","kLocal":"F:key","future":}',
    '{"v":2,\u000b"iv":"AAAAAAAAAAAAAAAA","tag":"AAAAAAAAAAAAAAAAAAAAAA==","ct":"AAAA","kLocal":"F:key"}'
  ])('refuses invalid v2 envelope JSON that JSON.parse rejects', (json) => {
    expect(() => JSON.parse(json)).toThrow()
    expect(consumeEnvelope(new LegacyV2EnvelopeStream(bounds, 'scan'), Buffer.from(json), 2)).toMatchObject({
      type: 'refused',
      reason: 'MALFORMED'
    })
  })

  it.each([
    '"future":1 2',
    '"future":1"ok"',
    '"future":true false'
  ])('rejects invalid ignored envelope scalar grammar: %s', (field) => {
    const prefix = '{"v":2,"iv":"AAAAAAAAAAAAAAAA","tag":"AAAAAAAAAAAAAAAAAAAAAA==","ct":"AAAA","kLocal":"F:key",'
    const malformed = `${prefix}${field}}`
    expect(() => JSON.parse(malformed)).toThrow()
    for (let step = 1; step <= 11; step += 1)
      expect(consumeEnvelope(new LegacyV2EnvelopeStream(bounds, 'scan'), Buffer.from(malformed), step)).toMatchObject({
        type: 'refused',
        reason: 'MALFORMED'
      })
  })

  it.each(['true', '123'])('rejects valid V2 envelope followed by %s', (trailer) => {
    const valid = '{"v":2,"iv":"AAAAAAAAAAAAAAAA","tag":"AAAAAAAAAAAAAAAAAAAAAA==","ct":"AAAA","kLocal":"F:key"}'
    const malformed = `${valid}${trailer}`
    expect(() => JSON.parse(malformed)).toThrow()
    expect(consumeEnvelope(new LegacyV2EnvelopeStream(bounds, 'scan'), Buffer.from(malformed), 1)).toMatchObject({
      type: 'refused',
      reason: 'MALFORMED'
    })
  })

  it.each([
    'true',
    'false',
    'null',
    '-12',
    '1.5',
    '1e+2',
    '-2.5E-3'
  ])('accepts valid ignored JSON primitive metadata across byte boundaries: %s', (literal) => {
    const prefix = '{"v":2,"iv":"AAAAAAAAAAAAAAAA","tag":"AAAAAAAAAAAAAAAAAAAAAA==","kLocal":"F:key",'
    const beforeCiphertext = Buffer.from(`${prefix}"future":${literal},"ct":"AAAA"}`)
    const afterCiphertext = Buffer.from(`${prefix}"ct":"AAAA","future":${literal}}`)
    for (const bytes of [beforeCiphertext, afterCiphertext]) {
      expect(() => JSON.parse(bytes.toString('utf8'))).not.toThrow()
      expect(consumeEnvelope(new LegacyV2EnvelopeStream(bounds, 'scan'), bytes, 1)).toMatchObject({
        type: 'scan-complete'
      })
    }
  })

  it('scans v2 ciphertext before the key and authenticates the second pass before completion', () => {
    const key = randomBytes(32)
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    const plaintext = Buffer.from(JSON.stringify(fixture))
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
    const envelope = Buffer.from(
      JSON.stringify({
        ct: ciphertext.toString('base64'),
        kEscrow: 'ignored-escrow-metadata',
        unknown: { nested: ['skip', 2] },
        kLocal: 'F:wrapped-local-key',
        v: 2,
        tag: cipher.getAuthTag().toString('base64'),
        iv: iv.toString('base64')
      })
    )
    const scan = consumeEnvelope(new LegacyV2EnvelopeStream(bounds, 'scan'), envelope, 1)
    expect(scan).toMatchObject({ type: 'scan-complete' })
    if (scan?.type !== 'scan-complete') return

    const decrypt = new LegacyV2EnvelopeStream(bounds, 'decrypt')
    decrypt.setKey(scan.descriptor, new Uint8Array(key))
    const complete = consumeEnvelope(decrypt, envelope, 7)
    expect(complete).toMatchObject({ type: 'complete', header: { jobId: fixture.jobId } })
  })

  it.each(['wrong-key', 'bad-tag'] as const)('withholds v2 completion after %s authentication failure', (failure) => {
    const key = randomBytes(32)
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    const plain = Buffer.from(JSON.stringify(fixture))
    const ct = Buffer.concat([cipher.update(plain), cipher.final()])
    const tag = cipher.getAuthTag()
    if (failure === 'bad-tag') tag[0] ^= 1
    const envelope = Buffer.from(
      JSON.stringify({
        v: 2,
        iv: iv.toString('base64'),
        tag: tag.toString('base64'),
        ct: ct.toString('base64'),
        kLocal: 'S:wrapped'
      })
    )
    const scan = consumeEnvelope(new LegacyV2EnvelopeStream(bounds, 'scan'), envelope, 9)
    if (scan?.type !== 'scan-complete') throw new Error('scan failed')
    const decrypt = new LegacyV2EnvelopeStream(bounds, 'decrypt')
    decrypt.setKey(scan.descriptor, new Uint8Array(failure === 'wrong-key' ? randomBytes(32) : key))
    expect(consumeEnvelope(decrypt, envelope, 11)).toMatchObject({ type: 'refused' })
  })
})

describe('bounded legacy reader scope settlement', () => {
  it('successfully publishes through the coordinator and settles physical resources once', async () => {
    const published = deferred<void>()
    const harness = publishedReadHarness({ operationDeadlineMs: 2_000, onPublished: () => published.resolve() })

    await expect(harness.read()).resolves.toMatchObject({ status: 'ready', header: { jobId: fixture.jobId } })
    await published.promise
    expect(harness.metrics).toMatchObject({ settled: 1, abortRequests: 0, aborts: 0, quarantines: [] })
  })

  it('holds lease settlement until deadline-started abort finishes after successful publication and held source close', async () => {
    vi.useFakeTimers()
    const close = deferred<void>()
    const abort = deferred<void>()
    const published = deferred<void>()
    const closeStarted = deferred<void>()
    const abortStarted = deferred<void>()
    const settledStarted = deferred<void>()
    const harness = publishedReadHarness({
      operationDeadlineMs: 250,
      close: () => close.promise,
      abort: () => abort.promise,
      onPublished: () => published.resolve(),
      onCloseStarted: () => closeStarted.resolve(),
      onAbortStarted: () => abortStarted.resolve(),
      onAccountStarted: () => settledStarted.resolve()
    })
    const operation = harness.read()

    try {
      await published.promise
      await closeStarted.promise
      vi.setSystemTime(Date.now() + 250)
      await vi.advanceTimersByTimeAsync(250)
      await expect(operation).resolves.toEqual({ status: 'refused', reason: 'DEADLINE' })
      await abortStarted.promise
      close.resolve()
      await vi.advanceTimersByTimeAsync(1)
      expect(harness.metrics.settled).toBe(0)
      abort.resolve()
      await settledStarted.promise
      expect(harness.metrics).toMatchObject({ settled: 1, abortRequests: 1, aborts: 1 })
    } finally {
      close.resolve()
      abort.resolve()
      try {
        await vi.advanceTimersByTimeAsync(250)
        await operation
      } finally {
        vi.useRealTimers()
      }
    }
  })

  it('keeps a published candidate quarantined when deadline-started abort rejects', async () => {
    vi.useFakeTimers()
    const close = deferred<void>()
    const abort = deferred<void>()
    const published = deferred<void>()
    const closeStarted = deferred<void>()
    const abortStarted = deferred<void>()
    const settledStarted = deferred<void>()
    const harness = publishedReadHarness({
      operationDeadlineMs: 250,
      close: () => close.promise,
      abort: () => abort.promise,
      onPublished: () => published.resolve(),
      onCloseStarted: () => closeStarted.resolve(),
      onAbortStarted: () => abortStarted.resolve(),
      onAccountStarted: () => settledStarted.resolve()
    })
    const operation = harness.read()

    try {
      await published.promise
      await closeStarted.promise
      vi.setSystemTime(Date.now() + 250)
      await vi.advanceTimersByTimeAsync(250)
      await expect(operation).resolves.toEqual({ status: 'refused', reason: 'DEADLINE' })
      await abortStarted.promise
      close.resolve()
      await vi.advanceTimersByTimeAsync(1)
      abort.resolve(Promise.reject(new Error('candidate abort failed')))
      await vi.advanceTimersByTimeAsync(1)
      expect(harness.metrics.settled).toBe(0)
      expect(harness.metrics.quarantines).toContain('CLEANUP_FAILED')
    } finally {
      close.resolve()
      abort.resolve()
      try {
        await vi.advanceTimersByTimeAsync(250)
        await operation
      } finally {
        vi.useRealTimers()
      }
    }
  })

  it('does not start new candidate cleanup after resource accounting release has begun', async () => {
    vi.useFakeTimers()
    const account = deferred<void>()
    const published = deferred<void>()
    const accountingStarted = deferred<void>()
    const harness = publishedReadHarness({
      operationDeadlineMs: 250,
      account: () => account.promise,
      onPublished: () => published.resolve(),
      onAccountStarted: () => accountingStarted.resolve()
    })
    const operation = harness.read()

    try {
      await published.promise
      await accountingStarted.promise
      vi.setSystemTime(Date.now() + 250)
      await vi.advanceTimersByTimeAsync(250)
      await expect(operation).resolves.toEqual({ status: 'refused', reason: 'DEADLINE' })
      expect(harness.metrics.abortRequests).toBe(0)
      expect(harness.metrics.aborts).toBe(0)
    } finally {
      account.resolve()
      try {
        await vi.advanceTimersByTimeAsync(250)
        await operation
      } finally {
        vi.useRealTimers()
      }
    }
  })

  it('refuses an unconfigured policy before touching scope, source, resources, keys, workers, or candidates', async () => {
    let calls = 0
    const fail = async (): Promise<never> => {
      calls += 1
      throw new Error('unconfigured reader called an adapter')
    }
    const reader = createImportLegacyCheckpointReader({
      authority: { assertCurrent: () => (calls += 1), refreshSameScope: fail },
      resources: { acquire: fail },
      source: { open: fail },
      keys: { unwrapV2: fail },
      candidate: { begin: fail },
      createWorker: fail,
      bounds: () => undefined
    })
    await expect(reader(fixture.jobId, Object.freeze({}) as ImportOperationScope)).resolves.toEqual({
      status: 'refused',
      reason: 'UNCONFIGURED'
    })
    expect(calls).toBe(0)
  })

  it('rechecks the original scope after a held source read before starting worker or candidate work', async () => {
    let current = true
    let readStarted!: () => void
    let releaseRead!: () => void
    let workers = 0
    let candidates = 0
    let settled = 0
    let closed = 0
    const started = new Promise<void>((resolve) => {
      readStarted = resolve
    })
    const held = new Promise<void>((resolve) => {
      releaseRead = resolve
    })
    const file = Buffer.from(JSON.stringify(fixture))
    const version = { dev: 1, ino: 2, nlink: 1, size: file.byteLength, mtimeMs: 3, ctimeMs: 4 }
    const scope = Object.freeze({}) as ImportOperationScope
    const reader = createImportLegacyCheckpointReader({
      authority: {
        assertCurrent: () => {
          if (!current) throw new ImportLegacyAdapterError('STALE_SCOPE')
        },
        refreshSameScope: async () => {}
      },
      resources: {
        acquire: async () => ({ settled: async () => {}, quarantine: () => {} })
      },
      source: {
        open: async () => ({
          version,
          readAt: async (position, target, expected, _scope, guard) => {
            guard.assertCurrent()
            expect(expected).toEqual(version)
            readStarted()
            await held
            guard.assertCurrent()
            const length = Math.min(target.byteLength, file.byteLength - position)
            target.set(file.subarray(position, position + length))
            return length
          },
          requestCancel: () => {},
          assertCurrentVersion: async () => {},
          admitOriginalSource: async () => ({ assertCurrent: () => {} }) as ImportLegacySourceAdmission,
          close: async () => {
            closed += 1
          },
          settled: async () => {
            settled += 1
          }
        })
      },
      keys: { unwrapV2: async () => new Uint8Array(32) },
      candidate: {
        begin: async () => {
          candidates += 1
          throw new Error('unexpected candidate')
        }
      },
      createWorker: async () => {
        workers += 1
        throw new Error('unexpected worker')
      },
      bounds: () => bounds
    })
    const operation = reader(fixture.jobId, scope)
    await started
    current = false
    releaseRead()
    await expect(operation).resolves.toEqual({ status: 'refused', reason: 'STALE_SCOPE' })
    expect({ workers, candidates, settled, closed }).toEqual({ workers: 0, candidates: 0, settled: 1, closed: 1 })
  })

  it('returns at the operation deadline while retaining a held source lease until settlement', async () => {
    let readStarted!: () => void
    let releaseRead!: () => void
    let settledSource!: () => void
    let quarantineReason: string | undefined
    let cancelRequested = 0
    const started = new Promise<void>((resolve) => {
      readStarted = resolve
    })
    const held = new Promise<void>((resolve) => {
      releaseRead = resolve
    })
    const sourceSettled = new Promise<void>((resolve) => {
      settledSource = resolve
    })
    const file = Buffer.from(JSON.stringify(fixture))
    const version = { dev: 1, ino: 2, nlink: 1, size: file.byteLength, mtimeMs: 3, ctimeMs: 4 }
    const scope = Object.freeze({}) as ImportOperationScope
    const reader = createImportLegacyCheckpointReader({
      authority: { assertCurrent: () => {}, refreshSameScope: async () => {} },
      resources: {
        acquire: async () => ({
          settled: async () => {},
          quarantine: (reason) => {
            quarantineReason = reason
          }
        })
      },
      source: {
        open: async () => ({
          version,
          readAt: async (position, target) => {
            readStarted()
            await held
            const length = Math.min(target.byteLength, file.byteLength - position)
            target.set(file.subarray(position, position + length))
            return length
          },
          requestCancel: () => {
            cancelRequested += 1
          },
          assertCurrentVersion: async () => {},
          admitOriginalSource: async () => ({ assertCurrent: () => {} }) as ImportLegacySourceAdmission,
          close: async () => {},
          settled: async () => settledSource()
        })
      },
      keys: { unwrapV2: async () => new Uint8Array(32) },
      candidate: {
        begin: async () => {
          throw new Error('unexpected candidate')
        }
      },
      createWorker: async () => {
        throw new Error('unexpected worker')
      },
      bounds: () => ({ ...bounds, operationDeadlineMs: 60 })
    })
    const operation = reader(fixture.jobId, scope)
    await started
    await expect(operation).resolves.toEqual({ status: 'refused', reason: 'DEADLINE' })
    expect(quarantineReason).toBe('DEADLINE')
    expect(cancelRequested).toBe(1)
    releaseRead()
    await sourceSettled
  })

  it('quarantines a lease that resolves after the caller deadline without opening its source', async () => {
    let startAcquire!: () => void
    let resolveAcquire!: (lease: {
      settled(): Promise<void>
      quarantine(reason: 'DEADLINE' | 'CLEANUP_FAILED'): void
    }) => void
    let sourceOpens = 0
    let quarantineReason: string | undefined
    let leaseSettled!: () => void
    const acquireStarted = new Promise<void>((resolve) => {
      startAcquire = resolve
    })
    const acquisition = new Promise<{
      settled(): Promise<void>
      quarantine(reason: 'DEADLINE' | 'CLEANUP_FAILED'): void
    }>((resolve) => {
      resolveAcquire = resolve
    })
    const settled = new Promise<void>((resolve) => {
      leaseSettled = resolve
    })
    const reader = createImportLegacyCheckpointReader({
      authority: { assertCurrent: () => {}, refreshSameScope: async () => {} },
      resources: {
        acquire: () => {
          startAcquire()
          return acquisition
        }
      },
      source: {
        open: async () => {
          sourceOpens += 1
          throw new Error('late lease must not open a source')
        }
      },
      keys: { unwrapV2: async () => new Uint8Array(32) },
      candidate: {
        begin: async () => {
          throw new Error('late lease must not create a candidate')
        }
      },
      createWorker: async () => {
        throw new Error('late lease must not create a worker')
      },
      bounds: () => ({ ...bounds, operationDeadlineMs: 60 })
    })
    const operation = reader(fixture.jobId, Object.freeze({}) as ImportOperationScope)
    await acquireStarted
    await expect(operation).resolves.toEqual({ status: 'refused', reason: 'DEADLINE' })
    resolveAcquire({
      quarantine: (reason) => {
        quarantineReason = reason
      },
      settled: async () => leaseSettled()
    })
    await settled
    expect({ quarantineReason, sourceOpens }).toEqual({ quarantineReason: 'DEADLINE', sourceOpens: 0 })
  })

  it.each([
    { rejectTermination: false, rejectAbort: false, throwDeadlineQuarantine: false },
    { rejectTermination: true, rejectAbort: false, throwDeadlineQuarantine: false },
    { rejectTermination: false, rejectAbort: true, throwDeadlineQuarantine: false },
    { rejectTermination: false, rejectAbort: false, throwDeadlineQuarantine: true }
  ])('accounts for late worker and candidate cleanup when termination rejects=$rejectTermination, abort rejects=$rejectAbort, deadline quarantine throws=$throwDeadlineQuarantine', async ({
    rejectTermination,
    rejectAbort,
    throwDeadlineQuarantine
  }) => {
    let workerCreationStarted!: () => void
    let resolveWorker!: (worker: {
      onMessage(listener: (message: unknown) => void): void
      onError(listener: () => void): void
      onExit(listener: (code: number) => void): void
      post(message: unknown, transfer?: ArrayBuffer[]): void
      terminate(): Promise<void>
    }) => void
    let terminationStarted!: () => void
    let finalized!: () => void
    let terminations = 0
    let settled = 0
    let aborts = 0
    let publications = 0
    const quarantineReasons: string[] = []
    const workerStarted = new Promise<void>((resolve) => (workerCreationStarted = resolve))
    const workerAcquisition = new Promise<Parameters<typeof resolveWorker>[0]>((resolve) => {
      resolveWorker = resolve
    })
    const termination = new Promise<void>((resolve) => (terminationStarted = resolve))
    const cleanupFinished = new Promise<void>((resolve) => (finalized = resolve))
    const file = Buffer.from(JSON.stringify(fixture))
    const version = { dev: 1, ino: 2, nlink: 1, size: file.byteLength, mtimeMs: 3, ctimeMs: 4 }
    const reader = createImportLegacyCheckpointReader({
      authority: { assertCurrent: () => {}, refreshSameScope: async () => {} },
      resources: {
        acquire: async () => ({
          settled: async () => {
            settled += 1
            finalized()
          },
          quarantine: (reason) => {
            quarantineReasons.push(reason)
            if (reason === 'DEADLINE' && throwDeadlineQuarantine) throw new Error('quarantine callback failed')
            if (reason === 'CLEANUP_FAILED') finalized()
          }
        })
      },
      source: {
        open: async () => ({
          version,
          readAt: async (position, target) => {
            const length = Math.min(target.byteLength, file.byteLength - position)
            target.set(file.subarray(position, position + length))
            return length
          },
          requestCancel: () => {},
          assertCurrentVersion: async () => {},
          admitOriginalSource: async () => ({ assertCurrent: () => {} }) as ImportLegacySourceAdmission,
          close: async () => {},
          settled: async () => {}
        })
      },
      keys: { unwrapV2: async () => new Uint8Array(32) },
      candidate: {
        begin: async () => ({
          append: async () => {},
          requestAbortOwnedCandidate: () => {},
          abortOwnedCandidate: async () => {
            aborts += 1
            if (rejectAbort) throw new Error('candidate abort did not settle')
          },
          publish: async () => {
            publications += 1
            return Object.freeze({}) as never
          }
        })
      },
      createWorker: () => {
        workerCreationStarted()
        return workerAcquisition
      },
      bounds: () => ({ ...bounds, operationDeadlineMs: 60 })
    })
    const operation = reader(fixture.jobId, Object.freeze({}) as ImportOperationScope)
    await workerStarted
    await expect(operation).resolves.toEqual({ status: 'refused', reason: 'DEADLINE' })
    resolveWorker({
      onMessage: () => {},
      onError: () => {},
      onExit: () => {},
      post: () => {},
      terminate: () => {
        terminations += 1
        terminationStarted()
        return rejectTermination ? Promise.reject(new Error('worker did not prove exit')) : Promise.resolve()
      }
    })
    await termination
    await cleanupFinished
    const cleanupFailed = rejectTermination || rejectAbort || throwDeadlineQuarantine
    expect([terminations, settled, aborts, publications]).toEqual([1, cleanupFailed ? 0 : 1, 1, 0])
    expect(quarantineReasons.at(-1)).toBe(cleanupFailed ? 'CLEANUP_FAILED' : 'DEADLINE')
  })
})
