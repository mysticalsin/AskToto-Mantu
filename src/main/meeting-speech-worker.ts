import { parentPort } from 'node:worker_threads'
import { performance } from 'node:perf_hooks'
import { createCipheriv, createDecipheriv } from 'node:crypto'
import type {
  MeetingSpeechReply,
  MeetingSpeechRequest,
  MeetingSpeechResult
} from './infra/process/meeting-speech-protocol'
import {
  decodeMeetingSpeech,
  encodeSpeechTranscript,
  projectMeetingSpeech,
  rewriteSpeechTranscript
} from './features/meetings/speech-provenance'
import { formatTranscript } from './features/meetings/transcript-format'
import { canonicalizeIncrementalMeetingRecord } from './features/meetings/incremental-record-canonical'

function requestInputByteLength(
  operation: MeetingSpeechRequest['operation'],
  input: unknown,
  limits: MeetingSpeechRequest['policy']['limits'],
  byteLimit = Number.MAX_SAFE_INTEGER
): number {
  if (operation === 'canonical-record' && input && typeof input === 'object') {
    const value = input as { recordJson?: unknown }
    if (
      Object.keys(input).sort().join(',') === 'recordJson' &&
      value.recordJson instanceof Uint8Array &&
      value.recordJson.buffer instanceof ArrayBuffer &&
      value.recordJson.byteOffset === 0 &&
      value.recordJson.byteLength === value.recordJson.buffer.byteLength
    )
      return value.recordJson.byteLength
    return Number.POSITIVE_INFINITY
  }
  if (operation === 'decrypt-v2' && input && typeof input === 'object') {
    const value = input as { envelopeJson?: unknown; contentKey?: unknown; kLocal?: unknown }
    if (
      value.envelopeJson instanceof Uint8Array &&
      value.contentKey instanceof Uint8Array &&
      typeof value.kLocal === 'string'
    )
      return value.envelopeJson.byteLength + value.contentKey.byteLength + Buffer.byteLength(value.kLocal, 'utf8') + 64
  }
  if (operation === 'rewrap-v2' && input && typeof input === 'object') {
    const value = input as { envelopeJson?: unknown; kLocal?: unknown }
    if (value.envelopeJson instanceof Uint8Array && typeof value.kLocal === 'string')
      return value.envelopeJson.byteLength + Buffer.byteLength(value.kLocal, 'utf8') + 32
  }
  const stack: Array<{ value: unknown; depth: number }> = [{ value: input, depth: 0 }]
  const seen = new Set<object>()
  let size = 0
  let nodes = 0
  const nodeLimit = Math.min(Number.MAX_SAFE_INTEGER, 64 + limits.maxRecords * 64 + limits.maxWords * 16)
  while (stack.length) {
    const { value, depth } = stack.pop()!
    if (++nodes > nodeLimit || depth > 16) return Number.POSITIVE_INFINITY
    if (typeof value === 'string') size += Buffer.byteLength(value, 'utf8') + 2
    else if (typeof value === 'number') size += Number.isFinite(value) ? String(value).length : Number.POSITIVE_INFINITY
    else if (typeof value === 'boolean') size += value ? 4 : 5
    else if (value === null) size += 4
    else if (value === undefined) continue
    else if (value instanceof Uint8Array) size += value.byteLength
    else if (Array.isArray(value)) {
      if (seen.has(value)) return Number.POSITIVE_INFINITY
      seen.add(value)
      if (value.length > nodeLimit - nodes - stack.length || size + 2 + value.length > byteLimit)
        return Number.POSITIVE_INFINITY
      size += 2 + value.length
      for (const item of value) stack.push({ value: item, depth: depth + 1 })
    } else if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
      if (seen.has(value)) return Number.POSITIVE_INFINITY
      seen.add(value)
      size += 2
      for (const key in value) {
        if (!Object.hasOwn(value, key)) continue
        size += Buffer.byteLength(key, 'utf8') + 3
        if (size > byteLimit) return Number.POSITIVE_INFINITY
        if (nodes + stack.length >= nodeLimit) return Number.POSITIVE_INFINITY
        stack.push({ value: (value as Record<string, unknown>)[key], depth: depth + 1 })
      }
    } else return Number.POSITIVE_INFINITY
    if (!Number.isFinite(size)) return size
  }
  return size
}

function canonicalResultByteLength(value: unknown): number {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return Number.POSITIVE_INFINITY
  const canonical = value as {
    identityKey?: unknown
    sha256?: unknown
    canonicalBytes?: unknown
    canonicalByteLength?: unknown
    wordCount?: unknown
    linePayloadBytes?: unknown
    clock?: unknown
  }
  const keys = Object.keys(value).sort().join(',')
  if (
    keys !== 'canonicalByteLength,canonicalBytes,clock,identityKey,linePayloadBytes,sha256,wordCount' ||
    typeof canonical.identityKey !== 'string' ||
    typeof canonical.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(canonical.sha256) ||
    typeof canonical.clock !== 'string' ||
    !Number.isSafeInteger(canonical.wordCount) ||
    !Number.isSafeInteger(canonical.linePayloadBytes) ||
    !(canonical.canonicalBytes instanceof Uint8Array) ||
    canonical.canonicalBytes.byteOffset !== 0 ||
    canonical.canonicalBytes.byteLength !== canonical.canonicalBytes.buffer.byteLength ||
    canonical.canonicalByteLength !== canonical.canonicalBytes.byteLength
  )
    return Number.POSITIVE_INFINITY
  const metadataBytes =
    Buffer.byteLength(canonical.identityKey, 'utf8') +
    Buffer.byteLength(canonical.sha256, 'utf8') +
    Buffer.byteLength(canonical.clock, 'utf8') +
    String(canonical.wordCount).length +
    String(canonical.linePayloadBytes).length +
    String(canonical.canonicalByteLength).length +
    32
  const size = canonical.canonicalBytes.byteLength + metadataBytes
  return Number.isSafeInteger(size) ? size : Number.POSITIVE_INFINITY
}

function policyValid(policy: MeetingSpeechRequest['policy']): boolean {
  const keys = ['maxFieldBytes', 'maxPayloadBytes', 'maxRecordBytes', 'maxRecords', 'maxWords']
  return Boolean(
    policy &&
      Object.keys(policy).sort().join(',') ===
        'limits,maxInputBytes,maxOutputBytes,operationDeadlineMs,shutdownDeadlineMs' &&
      policy.limits &&
      Object.keys(policy.limits).sort().join(',') === keys.join(',') &&
      Object.values(policy.limits).every((n) => Number.isSafeInteger(n) && n > 0) &&
      [policy.maxInputBytes, policy.maxOutputBytes, policy.operationDeadlineMs, policy.shutdownDeadlineMs].every(
        (n) => Number.isSafeInteger(n) && n > 0
      )
  )
}

export function processMeetingSpeechRequest(raw: unknown): MeetingSpeechReply | null {
  if (!raw || typeof raw !== 'object') return null
  const request = raw as Partial<MeetingSpeechRequest>
  if (
    request.protocol !== 1 ||
    Object.keys(request).sort().join(',') !== 'generation,id,input,operation,policy,protocol' ||
    !Number.isSafeInteger(request.id) ||
    !Number.isSafeInteger(request.generation) ||
    !['render', 'decode', 'rewrite', 'project', 'canonical-record', 'encrypt-v2', 'decrypt-v2', 'rewrap-v2'].includes(
      String(request.operation)
    ) ||
    !policyValid(request.policy as MeetingSpeechRequest['policy'])
  )
    return null
  const { id, generation, operation, policy, input } = request as MeetingSpeechRequest
  const failure = (code: 'INVALID_REQUEST' | 'RESOURCE_LIMIT' | 'CODEC_FAILURE'): MeetingSpeechReply => ({
    protocol: 1,
    id,
    generation,
    result: { ok: false, code }
  })
  if (requestInputByteLength(operation, input, policy.limits, policy.maxInputBytes) > policy.maxInputBytes)
    return failure('RESOURCE_LIMIT')
  try {
    let value: Extract<MeetingSpeechResult, { ok: true }>['value']
    if (operation === 'render') {
      if (!Array.isArray(input)) return failure('INVALID_REQUEST')
      value = input.some((line) => Boolean(line && typeof line === 'object' && 'speech' in line && line.speech))
        ? encodeSpeechTranscript(input, policy.limits)
        : formatTranscript(input)
    } else if (operation === 'decode') {
      if (typeof input !== 'string') return failure('INVALID_REQUEST')
      value = decodeMeetingSpeech(input, policy.limits)
    } else if (operation === 'project') {
      if (typeof input !== 'string') return failure('INVALID_REQUEST')
      const projected = projectMeetingSpeech(input)
      if (!projected.ok) return failure('CODEC_FAILURE')
      value = projected.publicMarkdown
    } else if (operation === 'rewrite') {
      if (!input || typeof input !== 'object' || Array.isArray(input) || !('text' in input) || !('lines' in input))
        return failure('INVALID_REQUEST')
      const requestInput = input as { text: string; lines: import('@shared/transcript-line').TranscriptLine[] }
      if (typeof requestInput.text !== 'string' || !Array.isArray(requestInput.lines)) return failure('INVALID_REQUEST')
      value = rewriteSpeechTranscript(requestInput.text, requestInput.lines, policy.limits)
    } else if (operation === 'canonical-record') {
      if (!input || typeof input !== 'object' || Array.isArray(input)) return failure('INVALID_REQUEST')
      const recordInput = input as { recordJson?: unknown }
      if (
        Object.keys(input).sort().join(',') !== 'recordJson' ||
        !(recordInput.recordJson instanceof Uint8Array) ||
        !(recordInput.recordJson.buffer instanceof ArrayBuffer) ||
        recordInput.recordJson.byteOffset !== 0 ||
        recordInput.recordJson.byteLength !== recordInput.recordJson.buffer.byteLength
      )
        return failure('INVALID_REQUEST')
      const decoded = new TextDecoder('utf-8', { fatal: true }).decode(recordInput.recordJson)
      const canonical = canonicalizeIncrementalMeetingRecord(JSON.parse(decoded), policy.limits, policy.maxInputBytes)
      if (!canonical.ok)
        return failure(
          canonical.reason === 'RESOURCE_LIMIT' || canonical.reason === 'INVALID_LIMITS'
            ? 'RESOURCE_LIMIT'
            : 'INVALID_REQUEST'
        )
      value = canonical.value
    } else if (operation === 'encrypt-v2') {
      if (!input || typeof input !== 'object' || Array.isArray(input)) return failure('INVALID_REQUEST')
      const envelopeInput = input as {
        content: unknown
        contentKey: unknown
        iv: unknown
        kLocal: unknown
        kEscrow?: unknown
      }
      if (
        Object.keys(input).sort().join(',') !== 'content,contentKey,iv,kLocal' &&
        Object.keys(input).sort().join(',') !== 'content,contentKey,iv,kEscrow,kLocal'
      )
        return failure('INVALID_REQUEST')
      if (
        typeof envelopeInput.content !== 'string' ||
        !(envelopeInput.contentKey instanceof Uint8Array) ||
        envelopeInput.contentKey.byteLength !== 32 ||
        !(envelopeInput.iv instanceof Uint8Array) ||
        envelopeInput.iv.byteLength !== 12 ||
        typeof envelopeInput.kLocal !== 'string' ||
        (envelopeInput.kEscrow !== undefined && typeof envelopeInput.kEscrow !== 'string')
      )
        return failure('INVALID_REQUEST')
      try {
        const cipher = createCipheriv('aes-256-gcm', envelopeInput.contentKey, envelopeInput.iv)
        const ciphertext = Buffer.concat([cipher.update(envelopeInput.content, 'utf8'), cipher.final()])
        const envelope = {
          v: 2,
          iv: Buffer.from(envelopeInput.iv).toString('base64'),
          tag: cipher.getAuthTag().toString('base64'),
          ct: ciphertext.toString('base64'),
          kLocal: envelopeInput.kLocal,
          ...(typeof envelopeInput.kEscrow === 'string' ? { kEscrow: envelopeInput.kEscrow } : {})
        }
        const json = Buffer.from(JSON.stringify(envelope), 'utf8')
        const output = new Uint8Array(Buffer.byteLength('ATKENC2\n') + json.byteLength)
        output.set(Buffer.from('ATKENC2\n'), 0)
        output.set(json, Buffer.byteLength('ATKENC2\n'))
        value = output
      } finally {
        envelopeInput.contentKey.fill(0)
        envelopeInput.iv.fill(0)
      }
    } else if (operation === 'decrypt-v2') {
      if (!input || typeof input !== 'object' || Array.isArray(input)) return failure('INVALID_REQUEST')
      const decryptInput = input as { envelopeJson: unknown; contentKey: unknown; kLocal: unknown }
      if (
        Object.keys(input).sort().join(',') !== 'contentKey,envelopeJson,kLocal' ||
        !(decryptInput.envelopeJson instanceof Uint8Array) ||
        !(decryptInput.contentKey instanceof Uint8Array) ||
        decryptInput.contentKey.byteLength !== 32 ||
        typeof decryptInput.kLocal !== 'string'
      )
        return failure('INVALID_REQUEST')
      try {
        const envelope = JSON.parse(Buffer.from(decryptInput.envelopeJson).toString('utf8')) as {
          v?: unknown
          iv?: unknown
          tag?: unknown
          ct?: unknown
          kLocal?: unknown
          kEscrow?: unknown
        }
        const keys = Object.keys(envelope).sort().join(',')
        if (
          (keys !== 'ct,iv,kLocal,tag,v' && keys !== 'ct,iv,kEscrow,kLocal,tag,v') ||
          envelope.v !== 2 ||
          typeof envelope.iv !== 'string' ||
          typeof envelope.tag !== 'string' ||
          typeof envelope.ct !== 'string' ||
          typeof envelope.kLocal !== 'string' ||
          envelope.kLocal !== decryptInput.kLocal ||
          (envelope.kEscrow !== undefined && typeof envelope.kEscrow !== 'string') ||
          !/^[A-Za-z0-9+/]+={0,2}$/.test(envelope.iv) ||
          !/^[A-Za-z0-9+/]+={0,2}$/.test(envelope.tag) ||
          !/^[A-Za-z0-9+/]*={0,2}$/.test(envelope.ct)
        )
          return failure('INVALID_REQUEST')
        const iv = Buffer.from(envelope.iv, 'base64')
        const tag = Buffer.from(envelope.tag, 'base64')
        if (iv.byteLength !== 12 || tag.byteLength !== 16) return failure('INVALID_REQUEST')
        const ciphertext = Buffer.from(envelope.ct, 'base64')
        const decipher = createDecipheriv('aes-256-gcm', decryptInput.contentKey, iv)
        decipher.setAuthTag(tag)
        value = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
      } finally {
        decryptInput.contentKey.fill(0)
      }
    } else {
      if (!input || typeof input !== 'object' || Array.isArray(input)) return failure('INVALID_REQUEST')
      const rewrapInput = input as { envelopeJson: unknown; kLocal: unknown }
      if (
        Object.keys(input).sort().join(',') !== 'envelopeJson,kLocal' ||
        !(rewrapInput.envelopeJson instanceof Uint8Array) ||
        typeof rewrapInput.kLocal !== 'string'
      )
        return failure('INVALID_REQUEST')
      const envelope = JSON.parse(Buffer.from(rewrapInput.envelopeJson).toString('utf8')) as Record<string, unknown>
      const keys = Object.keys(envelope).sort().join(',')
      if (
        (keys !== 'ct,iv,kLocal,tag,v' && keys !== 'ct,iv,kEscrow,kLocal,tag,v') ||
        envelope.v !== 2 ||
        typeof envelope.iv !== 'string' ||
        typeof envelope.tag !== 'string' ||
        typeof envelope.ct !== 'string' ||
        typeof envelope.kLocal !== 'string' ||
        (envelope.kEscrow !== undefined && typeof envelope.kEscrow !== 'string') ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(envelope.iv) ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(envelope.tag) ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(envelope.ct)
      )
        return failure('INVALID_REQUEST')
      envelope.kLocal = rewrapInput.kLocal
      value = Uint8Array.from(Buffer.from(JSON.stringify(envelope), 'utf8'))
    }
    const outputBytes =
      operation === 'canonical-record'
        ? canonicalResultByteLength(value)
        : value instanceof Uint8Array
          ? value.byteLength
          : typeof value === 'string'
            ? Buffer.byteLength(value, 'utf8')
            : requestInputByteLength(operation, value, policy.limits, policy.maxOutputBytes)
    if (outputBytes > policy.maxOutputBytes) return failure('RESOURCE_LIMIT')
    return { protocol: 1, id, generation, result: { ok: true, value } }
  } catch {
    return failure('CODEC_FAILURE')
  }
}

const workerPort = parentPort
if (workerPort) {
  workerPort.on('message', (request: unknown) => {
    const startedAt = performance.now()
    const reply = processMeetingSpeechRequest(request)
    const operation =
      request && typeof request === 'object' && 'operation' in request
        ? (request as { operation?: unknown }).operation
        : undefined
    if (request && typeof request === 'object' && 'input' in request) {
      const raw = request as { operation?: unknown; input?: unknown }
      if (raw.input && typeof raw.input === 'object') {
        const input = raw.input as Record<string, unknown>
        const wipeKeys =
          raw.operation === 'encrypt-v2'
            ? ['contentKey', 'iv']
            : raw.operation === 'canonical-record'
              ? ['recordJson']
              : ['contentKey']
        for (const key of wipeKeys) {
          const secret = input[key]
          if (secret instanceof Uint8Array) secret.fill(0)
        }
      }
    }
    if (reply) {
      const measured = { ...reply, workerDurationMs: Math.max(0, performance.now() - startedAt) }
      const value = reply.result.ok ? reply.result.value : undefined
      if (value instanceof Uint8Array) workerPort.postMessage(measured, [value.buffer as ArrayBuffer])
      else if (
        operation === 'canonical-record' &&
        value &&
        typeof value === 'object' &&
        'canonicalBytes' in value &&
        value.canonicalBytes instanceof Uint8Array
      )
        workerPort.postMessage(measured, [value.canonicalBytes.buffer as ArrayBuffer])
      else workerPort.postMessage(measured)
    }
  })
}
