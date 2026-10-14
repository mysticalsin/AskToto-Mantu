import { parentPort } from 'node:worker_threads'
import { LegacyJobJsonParser } from './import-legacy-checkpoint-codec'
import type { LegacyInput, LegacyOutput } from './import-legacy-checkpoint-protocol'
import { LegacyV2EnvelopeStream } from './import-legacy-checkpoint-envelope'
import {
  captureImportLegacyBounds,
  validateImportLegacyBounds,
  type ImportLegacyBounds
} from './import-legacy-checkpoint-contract'

if (!parentPort) throw new Error('Legacy checkpoint worker requires a parent port.')

let sessionId: string | undefined
let parser: LegacyJobJsonParser | undefined
let envelope: LegacyV2EnvelopeStream | undefined
let expectedSequence = 0
let recordWaiting: number | undefined
let heldChunk = false
let ended = false
let endRequested = false
let format: string | undefined
let bounds: ImportLegacyBounds | undefined
let inputBytes = 0

function emit(message: LegacyOutput): void {
  if (message.type === 'record') parentPort!.postMessage(message, [message.recordJson.buffer as ArrayBuffer])
  else parentPort!.postMessage(message)
}
function refuse(reason: 'LIMIT' | 'MALFORMED' | 'WORKER_FAILED'): void {
  if (!sessionId) return
  emit({ protocol: 1, type: 'refused', sessionId, reason })
  ended = true
}

function processBytes(bytes: Uint8Array): void {
  if ((!parser && !envelope) || !sessionId) return refuse('WORKER_FAILED')
  let event
  try {
    event = parser ? parser.feed(bytes) : envelope!.feed(bytes)
  } finally {
    bytes.fill(0)
  }
  if (!event) return
  if (event.type === 'record') {
    if (event.recordJson.byteLength > bounds!.maxRecordBytes) {
      event.recordJson.fill(0)
      return refuse('LIMIT')
    }
    recordWaiting = event.recordSequence
    heldChunk = true
    emit({ protocol: 1, type: 'record', sessionId, recordSequence: event.recordSequence, recordJson: event.recordJson })
  } else if (event.type === 'refused') refuse(event.reason)
  else if (event.type === 'scan-complete') {
    emit({
      protocol: 1,
      type: 'scan-complete',
      sessionId,
      descriptor: event.descriptor,
      sourceDigest: event.sourceDigest
    })
    ended = true
  } else if (event.type === 'complete' && 'event' in event) {
    emit({
      protocol: 1,
      type: 'complete',
      sessionId,
      header: event.event.header,
      totals: {
        records: event.event.totals.records,
        words: event.event.totals.words,
        payloadBytes: event.event.totals.payloadBytes,
        decodedBytes: event.event.totals.decodedBytes
      },
      sourceDigest: event.sourceDigest
    })
    ended = true
  } else refuse('WORKER_FAILED')
}

function drainHeld(): void {
  if (!heldChunk || (!parser && !envelope) || !sessionId || ended) return
  const event = parser ? parser.resume() : (envelope?.resume() ?? null)
  if (event?.type === 'record') {
    recordWaiting = event.recordSequence
    emit({ protocol: 1, type: 'record', sessionId, recordSequence: event.recordSequence, recordJson: event.recordJson })
    return
  }
  if (event?.type === 'refused') return refuse(event.reason)
  heldChunk = false
  recordWaiting = undefined
  if (endRequested) {
    finishSession()
    return
  }
  emit({ protocol: 1, type: 'input-credit', sessionId, nextSequence: expectedSequence })
}

function finishSession(): void {
  if (!sessionId || ended) return
  if (parser) {
    const result = parser.finish()
    if (result.type === 'refused') return refuse(result.reason)
    if (result.type !== 'complete') return refuse('WORKER_FAILED')
    emit({
      protocol: 1,
      type: 'complete',
      sessionId,
      header: result.header,
      totals: {
        records: result.totals.records,
        words: result.totals.words,
        payloadBytes: result.totals.payloadBytes,
        decodedBytes: result.totals.decodedBytes
      },
      sourceDigest: parser.sourceDigest()
    })
    ended = true
    return
  }
  const result = envelope?.finish()
  if (!result) return refuse('WORKER_FAILED')
  if (result.type === 'refused') return refuse(result.reason)
  if (result.type === 'record') {
    recordWaiting = result.recordSequence
    heldChunk = true
    emit({
      protocol: 1,
      type: 'record',
      sessionId,
      recordSequence: result.recordSequence,
      recordJson: result.recordJson
    })
    return
  }
  if (result.type === 'scan-complete') {
    emit({
      protocol: 1,
      type: 'scan-complete',
      sessionId,
      descriptor: result.descriptor,
      sourceDigest: result.sourceDigest
    })
    ended = true
    return
  }
  if (result.type === 'complete') {
    emit({
      protocol: 1,
      type: 'complete',
      sessionId,
      header: result.event.header,
      totals: {
        records: result.event.totals.records,
        words: result.event.totals.words,
        payloadBytes: result.event.totals.payloadBytes,
        decodedBytes: result.event.totals.decodedBytes
      },
      sourceDigest: result.sourceDigest
    })
    ended = true
    return
  }
}

parentPort.on('message', (raw: unknown) => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return refuse('WORKER_FAILED')
  const input = raw as Partial<LegacyInput>
  if (input.protocol !== 1 || typeof input.op !== 'string') return refuse('WORKER_FAILED')
  if (input.op === 'open') {
    if (
      sessionId ||
      Object.keys(raw).sort().join(',') !== 'bounds,format,op,protocol,sessionId' ||
      typeof input.sessionId !== 'string' ||
      !input.sessionId ||
      !['plain', 'native-v1-plaintext', 'v2-scan', 'v2-decrypt'].includes(String(input.format)) ||
      !validateImportLegacyBounds(input.bounds as ImportLegacyBounds | undefined)
    )
      return refuse('WORKER_FAILED')
    sessionId = input.sessionId
    format = input.format
    bounds = captureImportLegacyBounds(input.bounds as ImportLegacyBounds)
    if (input.format === 'v2-scan' || input.format === 'v2-decrypt')
      envelope = new LegacyV2EnvelopeStream(
        input.bounds as ImportLegacyBounds,
        input.format === 'v2-scan' ? 'scan' : 'decrypt'
      )
    else parser = new LegacyJobJsonParser(input.bounds as ImportLegacyBounds)
    emit({ protocol: 1, type: 'input-credit', sessionId, nextSequence: 0 })
    return
  }
  if (!sessionId || input.sessionId !== sessionId || ended) return refuse('WORKER_FAILED')
  if (input.op === 'chunk') {
    if (
      Object.keys(raw).sort().join(',') !== 'bytes,op,protocol,sequence,sessionId' ||
      heldChunk ||
      recordWaiting !== undefined ||
      input.sequence !== expectedSequence ||
      !(input.bytes instanceof Uint8Array) ||
      input.bytes.byteOffset !== 0 ||
      input.bytes.byteLength !== input.bytes.buffer.byteLength ||
      input.bytes.byteLength === 0
    )
      return refuse('WORKER_FAILED')
    const maxInputBytes =
      format === 'v2-scan' || format === 'v2-decrypt' ? bounds!.maxPhysicalBytes : bounds!.maxDecodedBytes
    if (input.bytes.byteLength > bounds!.maxChunkBytes || inputBytes + input.bytes.byteLength > maxInputBytes) {
      input.bytes.fill(0)
      return refuse('LIMIT')
    }
    inputBytes += input.bytes.byteLength
    expectedSequence += 1
    processBytes(input.bytes)
    if (!heldChunk && !ended) emit({ protocol: 1, type: 'input-credit', sessionId, nextSequence: expectedSequence })
    return
  }
  if (input.op === 'key') {
    if (
      Object.keys(raw).sort().join(',') !== 'descriptor,key,op,protocol,sessionId' ||
      !envelope ||
      !(input.key instanceof Uint8Array) ||
      input.key.byteOffset !== 0 ||
      input.key.byteLength !== input.key.buffer.byteLength ||
      input.key.byteLength !== 32 ||
      !input.descriptor
    )
      return refuse('WORKER_FAILED')
    try {
      envelope.setKey(input.descriptor, input.key)
    } catch {
      return refuse('WORKER_FAILED')
    }
    return
  }
  if (input.op === 'record-ack') {
    if (
      Object.keys(raw).sort().join(',') !== 'op,protocol,recordSequence,sessionId' ||
      input.recordSequence !== recordWaiting
    )
      return refuse('WORKER_FAILED')
    drainHeld()
    return
  }
  if (input.op === 'end') {
    if (
      Object.keys(raw).sort().join(',') !== 'op,protocol,sessionId' ||
      heldChunk ||
      recordWaiting !== undefined ||
      (!parser && !envelope)
    )
      return refuse('WORKER_FAILED')
    if (format === 'v2-scan') {
      finishSession()
      return
    }
    endRequested = true
    finishSession()
    return
  }
  if (input.op === 'cancel') {
    ended = true
    return
  }
  refuse('WORKER_FAILED')
})
