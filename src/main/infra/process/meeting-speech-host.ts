import { Worker } from 'node:worker_threads'
import { performance } from 'node:perf_hooks'
import { join } from 'node:path'
import type { SpeechDecoded, SpeechProvenanceLimits } from '@shared/meeting-speech-contract'
import type { TranscriptLine } from '@shared/transcript-line'
import { IncrementalMeetingIdentitySchema, type CanonicalIncrementalRecord } from '@shared/incremental-meeting'
import {
  issueIncrementalRecordReceipt,
  type IncrementalRecordReceipt,
  type IncrementalRecordReceiptBinding
} from './incremental-record-receipt'
import {
  isMeetingSpeechReply,
  type MeetingSpeechFailureCode,
  type MeetingSpeechOperation,
  type MeetingSpeechPolicy,
  type MeetingSpeechReply,
  type MeetingSpeechRequest
} from './meeting-speech-protocol'

export interface MeetingSpeechWorkerPort {
  on(event: 'message', listener: (message: unknown) => void): this
  on(event: 'error', listener: (error: unknown) => void): this
  on(event: 'exit', listener: (code: number) => void): this
  postMessage(message: MeetingSpeechRequest): void
  postMessage(message: MeetingSpeechRequest, transferList: ArrayBuffer[]): void
  terminate(): Promise<number>
}

export type MeetingSpeechWorkerFactory = (entryPath: string) => MeetingSpeechWorkerPort

export interface MeetingSpeechServiceOptions {
  /** Existing meeting-speech module budget getter; the service does not maintain another copy. */
  readLimits: () => SpeechProvenanceLimits | undefined
  /** Root-installed finite resource limits. The service refuses work if any field is absent or invalid. */
  readBounds: () => MeetingSpeechServiceBounds | undefined
  /** Main-only ownership predicate. It is never serialized into the worker protocol. */
  isCurrent?: () => boolean
  /** Timing-only observer; values are monotonic durations and never include request content. */
  onTiming?: (metric: MeetingSpeechTiming) => void
  workerFactory?: MeetingSpeechWorkerFactory
  entryPath?: string
}

export type MeetingSpeechTimingName =
  | 'admission-preflight'
  | 'input-snapshot'
  | 'queue-wait'
  | 'worker-round-trip'
  | 'worker-execution'
  | 'mock-native-key-wrap'
export interface MeetingSpeechTiming {
  name: MeetingSpeechTimingName
  durationMs: number
}

export interface MeetingSpeechServiceBounds {
  maxInputBytes: number
  maxOutputBytes: number
  operationDeadlineMs: number
  shutdownDeadlineMs: number
}

export interface MeetingSpeechPersistenceService {
  reportTiming(name: MeetingSpeechTimingName, durationMs: number): void
  readLimitBytes(): number | undefined
  render(lines: TranscriptLine[]): Promise<string>
  decode(text: string): Promise<SpeechDecoded>
  rewrite(text: string, lines: TranscriptLine[]): Promise<string | null>
  project(text: string): Promise<string>
  encryptEnvelopeV2(
    content: string,
    contentKey: Uint8Array,
    iv: Uint8Array,
    kLocal: string,
    kEscrow?: string
  ): Promise<Buffer>
  decryptEnvelopeV2(envelopeJson: Uint8Array, contentKey: Uint8Array, kLocal: string): Promise<string>
  rewrapEnvelopeV2(envelopeJson: Uint8Array, kLocal: string): Promise<Buffer>
  canonicalizeIncrementalRecord(
    recordJson: Uint8Array,
    binding: IncrementalRecordReceiptBinding
  ): Promise<IncrementalRecordReceipt>
  /** Rejects pending callers immediately and waits for an invalidated worker's exact exit. */
  invalidateCurrent(): Promise<void>
  /** Refuses future work and waits for the child to report its own exit. */
  dispose(): Promise<void>
}

interface Pending {
  request: MeetingSpeechRequest
  transfers: ArrayBuffer[]
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout> | undefined
  settled: boolean
  submittedAt: number
  snapshotMs: number
  dispatchedAt: number | undefined
  queueWaitMs: number
}

interface WorkerState {
  port: MeetingSpeechWorkerPort
  stopping: boolean
  shutdownDeadlineMs: number
  exitPromise: Promise<void>
  resolveExit: () => void
}

function failure(code: MeetingSpeechFailureCode): Error {
  const message: Record<MeetingSpeechFailureCode, string> = {
    UNCONFIGURED: 'Speech persistence is not configured.',
    RESOURCE_LIMIT: 'Speech persistence request exceeded its admitted resource budget.',
    QUEUE_FULL: 'Speech persistence is busy; the request was not admitted.',
    CANCELLED: 'Speech persistence request was cancelled.',
    WORKER_FAILED: 'Speech persistence could not complete.'
  }
  const error = new Error(message[code])
  error.name = code
  return error
}

function validPolicy(value: MeetingSpeechPolicy | undefined): value is MeetingSpeechPolicy {
  if (
    !value ||
    Object.keys(value).sort().join(',') !== 'limits,maxInputBytes,maxOutputBytes,operationDeadlineMs,shutdownDeadlineMs'
  )
    return false
  const keys = ['maxFieldBytes', 'maxPayloadBytes', 'maxRecordBytes', 'maxRecords', 'maxWords']
  return (
    Boolean(value.limits) &&
    Object.keys(value.limits).sort().join(',') === keys.join(',') &&
    Object.values(value.limits).every((n) => Number.isSafeInteger(n) && n > 0) &&
    [value.maxInputBytes, value.maxOutputBytes, value.operationDeadlineMs, value.shutdownDeadlineMs].every(
      (n) => Number.isSafeInteger(n) && n > 0
    )
  )
}

/** Estimate JSON-compatible input size without constructing a second full JSON string on main. */
function estimatedBytes(root: unknown, limit: number, limits: SpeechProvenanceLimits): number {
  const stack: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }]
  const seen = new Set<object>()
  const derivedNodeLimit = Math.min(Number.MAX_SAFE_INTEGER, 64 + limits.maxRecords * 64 + limits.maxWords * 16)
  let size = 0
  let nodes = 0
  while (stack.length) {
    const { value, depth } = stack.pop()!
    if (++nodes > derivedNodeLimit || depth > 16) return limit + 1
    if (typeof value === 'string') size += Buffer.byteLength(value, 'utf8') + 2
    else if (typeof value === 'number') size += Number.isFinite(value) ? String(value).length : limit + 1
    else if (typeof value === 'boolean') size += value ? 4 : 5
    else if (value === null) size += 4
    else if (value === undefined) continue
    else if (value instanceof Uint8Array) size += value.byteLength
    else if (Array.isArray(value)) {
      if (seen.has(value)) return limit + 1
      seen.add(value)
      // Reject before expanding a hostile array onto the traversal stack. The array is already
      // caller-owned; duplicating a huge element list here would itself block the main thread.
      if (value.length > derivedNodeLimit - nodes - stack.length || size + 2 + value.length > limit) return limit + 1
      size += 2 + value.length
      for (const item of value) stack.push({ value: item, depth: depth + 1 })
    } else if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
      if (seen.has(value)) return limit + 1
      seen.add(value)
      size += 2
      for (const key in value) {
        if (!Object.hasOwn(value, key)) continue
        size += Buffer.byteLength(key, 'utf8') + 3
        if (size > limit) return limit + 1
        if (nodes + stack.length >= derivedNodeLimit) return limit + 1
        stack.push({ value: (value as Record<string, unknown>)[key], depth: depth + 1 })
      }
    } else return limit + 1
    if (size > limit) return size
  }
  return size
}

function defaultWorker(entryPath: string): Worker {
  return new Worker(entryPath)
}

function exactOwnedUint8Length(value: unknown): number | null {
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
    if (byteOffset !== 0 || byteLength !== bufferLength || !Number.isSafeInteger(byteLength) || byteLength <= 0)
      return null
    const resizableGetter = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get
    if (resizableGetter?.call(buffer) === true) return null
    return byteLength
  } catch {
    return null
  }
}

function validValue(
  operation: MeetingSpeechOperation,
  value: unknown,
  maxOutputBytes: number,
  maxWords: number,
  maxRecordBytes: number
): boolean {
  if (operation === 'render' || operation === 'project' || operation === 'decrypt-v2')
    return typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= maxOutputBytes
  if (operation === 'rewrite')
    return value === null || (typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= maxOutputBytes)
  if (operation === 'encrypt-v2')
    return value instanceof Uint8Array && value.byteLength >= 8 && value.byteLength <= maxOutputBytes
  if (operation === 'rewrap-v2')
    return value instanceof Uint8Array && value.byteLength > 0 && value.byteLength <= maxOutputBytes
  if (operation === 'canonical-record') {
    if (!value || typeof value !== 'object') return false
    const canonical = value as Partial<CanonicalIncrementalRecord>
    if (
      Object.keys(value).sort().join(',') !==
        'canonicalByteLength,canonicalBytes,clock,identityKey,linePayloadBytes,sha256,wordCount' ||
      typeof canonical.identityKey !== 'string' ||
      canonical.identityKey.length > maxOutputBytes ||
      typeof canonical.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(canonical.sha256) ||
      typeof canonical.clock !== 'string' ||
      !/^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(canonical.clock) ||
      !Number.isSafeInteger(canonical.wordCount) ||
      canonical.wordCount! < 0 ||
      canonical.wordCount! > maxWords ||
      !Number.isSafeInteger(canonical.linePayloadBytes) ||
      canonical.linePayloadBytes! <= 0 ||
      canonical.linePayloadBytes! > maxRecordBytes ||
      !Number.isSafeInteger(canonical.canonicalByteLength) ||
      !(canonical.canonicalBytes instanceof Uint8Array) ||
      canonical.canonicalBytes.byteOffset !== 0 ||
      canonical.canonicalBytes.byteLength !== canonical.canonicalByteLength ||
      canonical.canonicalBytes.buffer.byteLength !== canonical.canonicalByteLength ||
      canonical.canonicalByteLength! > maxOutputBytes
    )
      return false
    try {
      const identity = JSON.parse(canonical.identityKey) as unknown
      const parsed = IncrementalMeetingIdentitySchema.safeParse(identity)
      return parsed.success && JSON.stringify(parsed.data) === canonical.identityKey
    } catch {
      return false
    }
  }
  if (!value || typeof value !== 'object') return false
  const decoded = value as {
    ok?: unknown
    status?: unknown
    publicMarkdown?: unknown
    reason?: unknown
    lines?: unknown
    clocks?: unknown
  }
  if (decoded.ok === false)
    return Object.keys(decoded).sort().join(',') === 'ok,reason' && decoded.reason === 'FRAME_AMBIGUOUS'
  if (decoded.ok !== true || typeof decoded.publicMarkdown !== 'string') return false
  if (decoded.status === 'absent' || decoded.status === 'unavailable')
    return Object.keys(decoded).sort().join(',') === 'ok,publicMarkdown,status'
  return (
    decoded.status === 'valid' &&
    Object.keys(decoded).sort().join(',') === 'clocks,lines,ok,publicMarkdown,status' &&
    Array.isArray(decoded.lines) &&
    Array.isArray(decoded.clocks) &&
    Buffer.byteLength(decoded.publicMarkdown, 'utf8') <= maxOutputBytes
  )
}

/** One lazy child, one active request and one queued request; stale receipts never reach a caller. */
export function createMeetingSpeechPersistenceService(
  options: MeetingSpeechServiceOptions
): MeetingSpeechPersistenceService {
  let generation = 0
  let nextId = 0
  let disposed = false
  let child: WorkerState | null = null
  let active: Pending | null = null
  let queued: Pending | null = null
  const workerFactory = options.workerFactory ?? defaultWorker
  const entryPath = options.entryPath ?? join(__dirname, 'meeting-speech-worker.js')

  const settle = (pending: Pending, error?: Error, value?: unknown): void => {
    if (pending.settled) return
    pending.settled = true
    if (pending.timer) clearTimeout(pending.timer)
    pending.timer = undefined
    if (error) {
      for (const buffer of pending.transfers) {
        try {
          if (buffer.byteLength) new Uint8Array(buffer).fill(0)
        } catch {
          // The worker may already own (and later wipe) a transferred buffer.
        }
      }
    }
    if (error) pending.reject(error)
    else pending.resolve(value)
  }

  const reportTiming = (name: MeetingSpeechTimingName, durationMs: number): void => {
    try {
      if (Number.isFinite(durationMs) && durationMs >= 0) options.onTiming?.({ name, durationMs })
    } catch {
      // Timing instrumentation is observational and cannot alter persistence results.
    }
  }

  const spawn = (): WorkerState => {
    let resolveExit!: () => void
    const state: WorkerState = {
      port: workerFactory(entryPath),
      stopping: false,
      shutdownDeadlineMs: active?.request.policy.shutdownDeadlineMs ?? Number.NaN,
      exitPromise: new Promise<void>((resolve) => {
        resolveExit = resolve
      }),
      resolveExit: () => resolveExit()
    }
    child = state
    state.port.on('message', (message) => {
      if (child !== state || !active || !isMeetingSpeechReply(message)) return
      const reply = message as MeetingSpeechReply
      if (reply.id !== active.request.id || reply.generation !== active.request.generation) return
      const completed = active
      active = null
      reportTiming('input-snapshot', completed.snapshotMs)
      if (completed.dispatchedAt !== undefined) {
        reportTiming('queue-wait', completed.queueWaitMs)
        reportTiming('worker-round-trip', performance.now() - completed.dispatchedAt)
      }
      if (reply.workerDurationMs !== undefined) reportTiming('worker-execution', reply.workerDurationMs)
      const wipeCanonicalOutput = (): void => {
        if (
          reply.result.ok &&
          completed.request.operation === 'canonical-record' &&
          reply.result.value &&
          typeof reply.result.value === 'object' &&
          'canonicalBytes' in reply.result.value &&
          reply.result.value.canonicalBytes instanceof Uint8Array
        )
          reply.result.value.canonicalBytes.fill(0)
      }
      if (completed.request.generation !== generation || !isOwnerCurrent()) {
        wipeCanonicalOutput()
        settle(completed, failure('CANCELLED'))
      } else if (!reply.result.ok) {
        settle(completed, failure(reply.result.code === 'RESOURCE_LIMIT' ? 'RESOURCE_LIMIT' : 'WORKER_FAILED'))
      } else if (
        !validValue(
          completed.request.operation,
          reply.result.value,
          completed.request.policy.maxOutputBytes,
          completed.request.policy.limits.maxWords,
          completed.request.policy.limits.maxRecordBytes
        )
      ) {
        wipeCanonicalOutput()
        settle(completed, failure('WORKER_FAILED'))
        stopAfterFailure(state)
      } else settle(completed, undefined, reply.result.value)
      dispatchQueued()
    })
    state.port.on('error', () => stopAfterFailure(state))
    state.port.on('exit', () => {
      if (child === state) child = null
      state.resolveExit()
      if (active && !active.settled) {
        settle(active, failure('WORKER_FAILED'))
        active = null
      }
      if (state.stopping) {
        if (queued) {
          settle(queued, failure('CANCELLED'))
          queued = null
        }
      } else dispatchQueued()
    })
    return state
  }

  const stopAfterFailure = (state: WorkerState): void => {
    if (child !== state || state.stopping) return
    state.stopping = true
    if (active) {
      settle(active, failure('WORKER_FAILED'))
      active = null
    }
    if (queued) {
      settle(queued, failure('WORKER_FAILED'))
      queued = null
    }
    void state.port.terminate().catch(() => undefined)
  }

  const isOwnerCurrent = (): boolean => {
    try {
      return options.isCurrent?.() ?? true
    } catch {
      return false
    }
  }

  const readPolicy = (): MeetingSpeechPolicy | undefined => {
    try {
      const limits = options.readLimits()
      const bounds = options.readBounds()
      if (!limits || !bounds) return undefined
      const policy = Object.freeze({
        limits: Object.freeze({ ...limits }),
        maxInputBytes: bounds.maxInputBytes,
        maxOutputBytes: bounds.maxOutputBytes,
        operationDeadlineMs: bounds.operationDeadlineMs,
        shutdownDeadlineMs: bounds.shutdownDeadlineMs
      })
      return validPolicy(policy) ? policy : undefined
    } catch {
      return undefined
    }
  }

  const dispatchQueued = (): void => {
    if (disposed || active || !queued || (child && child.stopping)) return
    const request = queued
    queued = null
    if (request.request.generation !== generation || !isOwnerCurrent()) {
      settle(request, failure('CANCELLED'))
      dispatchQueued()
      return
    }
    active = request
    request.dispatchedAt = performance.now()
    request.queueWaitMs = Math.max(0, request.dispatchedAt - request.submittedAt - request.snapshotMs)
    if (!child) {
      try {
        spawn()
      } catch {
        settle(request, failure('WORKER_FAILED'))
        active = null
        return
      }
    }
    const state = child
    if (!state) {
      settle(request, failure('WORKER_FAILED'))
      active = null
      return
    }
    request.timer = setTimeout(() => {
      if (active !== request || child !== state) return
      settle(request, failure('WORKER_FAILED'))
      active = null
      if (queued) {
        settle(queued, failure('CANCELLED'))
        queued = null
      }
      state.stopping = true
      void state.port.terminate().catch(() => undefined)
    }, request.request.policy.operationDeadlineMs)
    try {
      if (request.transfers?.length) state.port.postMessage(request.request, request.transfers)
      else state.port.postMessage(request.request)
    } catch {
      stopAfterFailure(state)
    }
  }

  const submit = <T>(
    operation: MeetingSpeechOperation,
    input: MeetingSpeechRequest['input'],
    transferFields: string[] = [],
    capturedPolicy?: MeetingSpeechPolicy
  ): Promise<T> => {
    const wipeInput = (): void => {
      for (const field of transferFields) {
        const value = (input as Record<string, unknown>)[field]
        if (value instanceof Uint8Array) value.fill(0)
      }
    }
    if (disposed) {
      wipeInput()
      return Promise.reject(failure('CANCELLED'))
    }
    const policy = capturedPolicy ?? readPolicy()
    if (!validPolicy(policy)) {
      wipeInput()
      return Promise.reject(failure('UNCONFIGURED'))
    }
    if (child?.stopping) {
      wipeInput()
      return Promise.reject(failure('CANCELLED'))
    }
    if (!isOwnerCurrent()) {
      wipeInput()
      return Promise.reject(failure('CANCELLED'))
    }
    if (queued) {
      wipeInput()
      return Promise.reject(failure('QUEUE_FULL'))
    }
    const admissionStartedAt = performance.now()
    let inputBytes: number
    try {
      if (operation === 'canonical-record') {
        const recordJson = input && typeof input === 'object' ? (input as { recordJson?: unknown }).recordJson : null
        const recordByteLength = exactOwnedUint8Length(recordJson)
        inputBytes = recordByteLength === null ? policy.maxInputBytes + 1 : recordByteLength
      } else inputBytes = estimatedBytes(input, policy.maxInputBytes, policy.limits)
    } catch {
      wipeInput()
      return Promise.reject(failure('RESOURCE_LIMIT'))
    }
    reportTiming('admission-preflight', performance.now() - admissionStartedAt)
    if (inputBytes > policy.maxInputBytes) {
      wipeInput()
      return Promise.reject(failure('RESOURCE_LIMIT'))
    }
    let inputSnapshot: MeetingSpeechRequest['input']
    let transfers: ArrayBuffer[] = []
    const submittedAt = performance.now()
    const snapshotStartedAt = performance.now()
    try {
      const transferValues = transferFields.map((key) => {
        const value = (input as Record<string, unknown>)[key]
        if (!(value instanceof Uint8Array) || value.byteOffset !== 0 || value.byteLength !== value.buffer.byteLength)
          throw new Error('Transfer field is not an exact owned byte array.')
        return value.buffer as ArrayBuffer
      })
      inputSnapshot = transferValues.length
        ? structuredClone(input, { transfer: transferValues })
        : structuredClone(input)
      transfers = transferFields.map((key) => {
        const value = (inputSnapshot as Record<string, unknown>)[key]
        if (!(value instanceof Uint8Array) || value.byteOffset !== 0 || value.byteLength !== value.buffer.byteLength)
          throw new Error('Transferred request snapshot is invalid.')
        return value.buffer as ArrayBuffer
      })
    } catch {
      wipeInput()
      return Promise.reject(failure('RESOURCE_LIMIT'))
    }
    const snapshotMs = performance.now() - snapshotStartedAt
    let snapshotBytes: number
    try {
      if (operation === 'canonical-record') {
        const recordJson =
          inputSnapshot && typeof inputSnapshot === 'object'
            ? (inputSnapshot as { recordJson?: unknown }).recordJson
            : null
        const byteLength = exactOwnedUint8Length(recordJson)
        snapshotBytes = byteLength === null ? policy.maxInputBytes + 1 : byteLength
      } else snapshotBytes = estimatedBytes(inputSnapshot, policy.maxInputBytes, policy.limits)
    } catch {
      for (const buffer of transfers) new Uint8Array(buffer).fill(0)
      return Promise.reject(failure('RESOURCE_LIMIT'))
    }
    if (snapshotBytes > policy.maxInputBytes) {
      for (const buffer of transfers) new Uint8Array(buffer).fill(0)
      return Promise.reject(failure('RESOURCE_LIMIT'))
    }
    if (queued) {
      for (const buffer of transfers) new Uint8Array(buffer).fill(0)
      return Promise.reject(failure('QUEUE_FULL'))
    }
    const request: MeetingSpeechRequest = {
      protocol: 1,
      id: ++nextId,
      generation,
      operation,
      policy,
      input: inputSnapshot
    }
    const promise = new Promise<T>((resolve, reject) => {
      const pending: Pending = {
        request,
        transfers,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer: undefined,
        settled: false,
        submittedAt,
        snapshotMs,
        dispatchedAt: undefined,
        queueWaitMs: 0
      }
      if (active) queued = pending
      else {
        queued = pending
        dispatchQueued()
      }
    })
    return promise
  }

  return {
    reportTiming,
    readLimitBytes() {
      return readPolicy()?.maxInputBytes
    },
    render: (lines) => submit('render', lines),
    decode: (text) => submit('decode', text),
    rewrite: (text, lines) => submit('rewrite', { text, lines }),
    project: (text) => submit('project', text),
    canonicalizeIncrementalRecord(recordJson, binding) {
      if (!options.isCurrent) return Promise.reject(failure('UNCONFIGURED'))
      if (exactOwnedUint8Length(recordJson) === null) return Promise.reject(failure('RESOURCE_LIMIT'))
      if (binding.meetingId.length > 64 || !options.isCurrent()) return Promise.reject(failure('CANCELLED'))
      const capturedPolicy = readPolicy()
      if (!capturedPolicy) return Promise.reject(failure('UNCONFIGURED'))
      if (
        Object.keys(binding.limits).sort().join(',') !== Object.keys(capturedPolicy.limits).sort().join(',') ||
        Object.keys(binding.limits).some(
          (key) =>
            binding.limits[key as keyof SpeechProvenanceLimits] !==
            capturedPolicy.limits[key as keyof SpeechProvenanceLimits]
        )
      )
        return Promise.reject(failure('CANCELLED'))
      return submit<CanonicalIncrementalRecord>(
        'canonical-record',
        { recordJson },
        ['recordJson'],
        capturedPolicy
      ).then((canonical) => {
        const currentPolicy = readPolicy()
        if (
          !options.isCurrent?.() ||
          !currentPolicy ||
          Object.keys(capturedPolicy.limits).some(
            (key) =>
              currentPolicy.limits[key as keyof SpeechProvenanceLimits] !==
              capturedPolicy.limits[key as keyof SpeechProvenanceLimits]
          )
        )
          throw failure('CANCELLED')
        const receipt = issueIncrementalRecordReceipt(canonical, binding)
        if (!receipt) throw failure('WORKER_FAILED')
        return receipt
      })
    },
    encryptEnvelopeV2(content, contentKey, iv, kLocal, kEscrow) {
      const ownedKey = Uint8Array.from(contentKey)
      const ownedIv = Uint8Array.from(iv)
      return submit<Uint8Array>(
        'encrypt-v2',
        { content, contentKey: ownedKey, iv: ownedIv, kLocal, ...(kEscrow ? { kEscrow } : {}) },
        ['contentKey', 'iv']
      ).then((bytes) => Buffer.from(bytes))
    },
    decryptEnvelopeV2(envelopeJson, contentKey, kLocal) {
      const policy = readPolicy()
      if (!policy) return Promise.reject(failure('UNCONFIGURED'))
      if (envelopeJson.byteLength > policy.maxInputBytes) return Promise.reject(failure('RESOURCE_LIMIT'))
      const ownedEnvelope = Uint8Array.from(envelopeJson)
      const ownedKey = Uint8Array.from(contentKey)
      return submit<string>(
        'decrypt-v2',
        { envelopeJson: ownedEnvelope, contentKey: ownedKey, kLocal },
        ['envelopeJson', 'contentKey'],
        policy
      )
    },
    rewrapEnvelopeV2(envelopeJson, kLocal) {
      const policy = readPolicy()
      if (!policy) return Promise.reject(failure('UNCONFIGURED'))
      if (envelopeJson.byteLength > policy.maxInputBytes) return Promise.reject(failure('RESOURCE_LIMIT'))
      const ownedEnvelope = Uint8Array.from(envelopeJson)
      return submit<Uint8Array>('rewrap-v2', { envelopeJson: ownedEnvelope, kLocal }, ['envelopeJson'], policy).then(
        (bytes) => Buffer.from(bytes)
      )
    },
    async invalidateCurrent() {
      generation++
      if (queued) {
        settle(queued, failure('CANCELLED'))
        queued = null
      }
      const state = child
      if (!state) {
        if (active) {
          settle(active, failure('CANCELLED'))
          active = null
        }
        return
      }
      if (active) {
        settle(active, failure('CANCELLED'))
        active = null
      }
      state.stopping = true
      if (!Number.isSafeInteger(state.shutdownDeadlineMs) || state.shutdownDeadlineMs <= 0)
        throw failure('WORKER_FAILED')
      let timer: ReturnType<typeof setTimeout> | undefined
      const waitingForExit = Promise.race([
        state.exitPromise.then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), state.shutdownDeadlineMs)
        })
      ])
      const termination = state.port.terminate().catch(() => undefined)
      const exited = await waitingForExit
      clearTimeout(timer)
      void termination
      if (!exited) throw failure('WORKER_FAILED')
    },
    async dispose() {
      disposed = true
      await this.invalidateCurrent()
    }
  }
}
