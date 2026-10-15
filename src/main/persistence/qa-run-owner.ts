import { createReadStream, createWriteStream, type ReadStream, type WriteStream } from 'node:fs'
import { app } from 'electron'
import { QA_IDENTITY_BUILD } from '../qa-identity'
import {
  QA_CONTROL_MAX_BYTES,
  QA_HANDSHAKE_TIMEOUT_MS,
  QA_HEARTBEAT_MAX_AGE_MS,
  QA_MAX_RUN_MS,
  compiledQaPersistenceRunContext,
  newQaPersistenceBootChallenge,
  qaPersistenceCanonical,
  readVerifiedQaPersistenceLaunch,
  verifyQaPersistenceHeartbeat,
  verifyQaPersistenceLaunchEnvelope,
  type VerifiedQaPersistenceLaunch
} from './qa-run-protocol'
import {
  assertQaProfileCurrent,
  assertQaProfilePhysicalCurrent,
  prepareQaProfileRoot,
  settleQaProfileRootPreparation,
  retireQaProfileRoot,
  type QaPersistenceProfileRoot
} from './qa-profile-root-owner'
import {
  assertQaPersistenceRunWindowCurrent,
  captureQaPersistenceRunWindowProof,
  qaPersistenceRunWindowRetirementSignal,
  type QaPersistenceRunWindowProof
} from './qa-main-action-owner'
import { assertPersistenceNativeKeyIntentCurrent, PERSISTENCE_ORIGINAL_NATIVE_KEY_INTENT } from './native-key-intent'

declare const runPermitBrand: unique symbol
export type QaPersistenceRunPermit = Readonly<{ [runPermitBrand]: true }>

export type QaPersistenceRunRefusal =
  | 'not-qa-build'
  | 'not-packaged'
  | 'wrong-runtime-name'
  | 'build-stamp-missing'
  | 'unsupported-target'
  | 'not-single-instance'
  | 'run-already-owned'
  | 'transport-unavailable'
  | 'transport-malformed'
  | 'launch-signature-invalid'
  | 'launch-context-invalid'
  | 'native-key-intent-changed'
  | 'profile-owner-invalid'
  | 'heartbeat-invalid'
  | 'run-expired'
  | 'run-retired'
  | 'window-proof-unavailable'

export class QaPersistenceRunError extends Error {
  readonly code: QaPersistenceRunRefusal

  constructor(code: QaPersistenceRunRefusal) {
    super(code)
    this.name = 'QaPersistenceRunError'
    this.code = code
  }
}

type FixedDuplexTransport = {
  readonly reader: ReadStream
  readonly writer: WriteStream
  close(): Promise<void>
}

type RunRecord = {
  readonly launch: VerifiedQaPersistenceLaunch
  readonly profile: QaPersistenceProfileRoot
  readonly transport: FixedDuplexTransport
  readonly windowProof: QaPersistenceRunWindowProof
  readonly windowSignal: AbortSignal
  readonly attempt: PendingHandshake
  readonly startedAtMonotonic: number
  readonly runGeneration: number
  readonly expiresAt: number
  readonly signedExpiryMonotonicCap: number
  lastSequence: number
  lastHeartbeatMonotonic: number
  lastWall: number
  timer: ReturnType<typeof setTimeout> | null
  retired: boolean
  disposed: boolean
  settlePromise: Promise<void> | null
}

type PendingHandshake = {
  readonly challenge: string
  transport: FixedDuplexTransport | null
  readonly windowProof: QaPersistenceRunWindowProof
  readonly windowSignal: AbortSignal
  readonly resolve: (result: { launch: VerifiedQaPersistenceLaunch; profile: QaPersistenceProfileRoot }) => void
  readonly reject: (error: QaPersistenceRunError) => void
  buffer: Buffer
  phase: 'launch' | 'active' | 'settling' | 'settled'
  launch: VerifiedQaPersistenceLaunch | null
  run: QaPersistenceRunPermit | null
  processing: boolean
  failure: QaPersistenceRunError | null
  profileWork: Promise<QaPersistenceProfileRoot> | null
  helloWrite: Promise<void> | null
  settlement: Promise<void> | null
  pumpPromise: Promise<void> | null
  readonly abortWindow: () => void
  timeout: ReturnType<typeof setTimeout> | null
}

const records = new WeakMap<object, RunRecord>()
const MAX_PENDING_BUFFER_BYTES = QA_CONTROL_MAX_BYTES * 2 + 8
let current: QaPersistenceRunPermit | null = null
let pending: PendingHandshake | null = null
let highestAcceptedRunGeneration = 0

function reject(code: QaPersistenceRunRefusal): never {
  throw new QaPersistenceRunError(code)
}

function runtimeTargetSupported(): boolean {
  const stamp = compiledQaPersistenceRunContext()
  if (!stamp) return false
  const expected = stamp.context.target
  return (
    (expected === 'win32-x64' && process.platform === 'win32' && process.arch === 'x64') ||
    (expected === 'darwin-x64' && process.platform === 'darwin' && process.arch === 'x64') ||
    (expected === 'darwin-arm64' && process.platform === 'darwin' && process.arch === 'arm64')
  )
}

function packagedRuntime(): QaPersistenceRunRefusal | null {
  if (!QA_IDENTITY_BUILD) return 'not-qa-build'
  try {
    if (!app.isPackaged) return 'not-packaged'
    if (app.getName() !== 'asktoto-qa') return 'wrong-runtime-name'
    if (!app.hasSingleInstanceLock()) return 'not-single-instance'
    return null
  } catch {
    return 'not-packaged'
  }
}

function frame(bytes: Uint8Array): Buffer {
  if (bytes.byteLength === 0 || bytes.byteLength > QA_CONTROL_MAX_BYTES) reject('transport-malformed')
  const output = Buffer.allocUnsafe(4 + bytes.byteLength)
  output.writeUInt32BE(bytes.byteLength, 0)
  Buffer.from(bytes).copy(output, 4)
  return output
}

function openFixedTransport(): FixedDuplexTransport {
  try {
    // D/E launches the exact installed executable with stdio slots 3 and 4 as the dedicated
    // inherited control duplex. No env path, socket, fd discovery or unsigned fallback is accepted.
    const reader = createReadStream('', { fd: 3, autoClose: true, highWaterMark: 8192 })
    const writer = createWriteStream('', { fd: 4, autoClose: true, highWaterMark: 8192 })
    const closeErrors: unknown[] = []
    const readerClosed = new Promise<void>((resolveClose) => reader.once('close', resolveClose))
    const writerClosed = new Promise<void>((resolveClose) => writer.once('close', resolveClose))
    reader.on('error', (error) => closeErrors.push(error))
    writer.on('error', (error) => closeErrors.push(error))
    const closed = Promise.all([readerClosed, writerClosed]).then(() => {
      if (closeErrors.length > 0) throw closeErrors[0]
    })
    void closed.catch(() => undefined)
    let closeStarted = false
    return {
      reader,
      writer,
      close: () => {
        if (!closeStarted) {
          closeStarted = true
          reader.destroy()
          writer.destroy()
        }
        return closed
      }
    }
  } catch {
    reject('transport-unavailable')
  }
}

function writeFrame(transport: FixedDuplexTransport, bytes: Uint8Array): Promise<void> {
  return new Promise((resolve, rejectWrite) => {
    let encoded: Buffer
    try {
      encoded = frame(bytes)
    } catch (error) {
      rejectWrite(error)
      return
    }
    transport.writer.write(encoded, (error) => {
      if (error) rejectWrite(new QaPersistenceRunError('transport-unavailable'))
      else resolve()
    })
  })
}

function signedIntentMatches(launch: VerifiedQaPersistenceLaunch): boolean {
  const claims = readVerifiedQaPersistenceLaunch(launch)
  return (
    claims !== null &&
    claims.nativeKeyIntent.present === PERSISTENCE_ORIGINAL_NATIVE_KEY_INTENT.present &&
    claims.nativeKeyIntent.value === PERSISTENCE_ORIGINAL_NATIVE_KEY_INTENT.value
  )
}

function intentIsCurrent(): boolean {
  try {
    assertPersistenceNativeKeyIntentCurrent()
    return true
  } catch {
    return false
  }
}

function assertWindowProof(state: Pick<PendingHandshake, 'windowProof' | 'windowSignal'>): void {
  if (state.windowSignal.aborted) reject('window-proof-unavailable')
  try {
    assertQaPersistenceRunWindowCurrent(state.windowProof)
  } catch {
    reject('window-proof-unavailable')
  }
}

function validClockSample(wall: number, monotonic: number): boolean {
  return (
    Number.isFinite(wall) &&
    wall >= 0 &&
    wall <= Number.MAX_SAFE_INTEGER &&
    Number.isFinite(monotonic) &&
    monotonic >= 0 &&
    monotonic <= Number.MAX_SAFE_INTEGER
  )
}

function scheduleHeartbeatRetirement(run: QaPersistenceRunPermit, record: RunRecord): void {
  if (record.timer) clearTimeout(record.timer)
  const wallNow = Date.now()
  const monotonicNow = performance.now()
  if (!validClockSample(wallNow, monotonicNow)) {
    retireQaPersistenceRun(run, 'run-retired')
    return
  }
  const deadlines = [
    record.lastHeartbeatMonotonic + QA_HEARTBEAT_MAX_AGE_MS,
    record.startedAtMonotonic + QA_MAX_RUN_MS,
    record.signedExpiryMonotonicCap,
    monotonicNow + Math.max(0, record.expiresAt - wallNow)
  ]
  const nextDeadline = Math.min(...deadlines)
  const delay = Math.max(1, nextDeadline - monotonicNow)
  record.timer = setTimeout(() => {
    record.timer = null
    try {
      assertQaPersistenceRunCurrent(run)
    } catch {
      return
    }
    scheduleHeartbeatRetirement(run, record)
  }, delay)
  record.timer.unref?.()
}

function hasCompleteFrame(buffer: Buffer): boolean {
  if (buffer.byteLength < 4) return false
  const length = buffer.readUInt32BE(0)
  return length === 0 || length > QA_CONTROL_MAX_BYTES || buffer.byteLength >= length + 4
}

function activateRun(
  state: PendingHandshake,
  launch: VerifiedQaPersistenceLaunch,
  profile: QaPersistenceProfileRoot
): QaPersistenceRunPermit {
  const claims = readVerifiedQaPersistenceLaunch(launch)
  if (!claims) reject('launch-signature-invalid')
  if (!signedIntentMatches(launch) || !intentIsCurrent()) {
    retireQaProfileRoot(profile)
    reject('native-key-intent-changed')
  }
  assertWindowProof(state)
  const stamp = compiledQaPersistenceRunContext()
  if (
    !stamp ||
    claims.runtime.platform !== process.platform ||
    claims.runtime.arch !== process.arch ||
    claims.runtime.node !== process.versions.node ||
    claims.runtime.electron !== process.versions.electron ||
    claims.runtime.v8 !== process.versions.v8 ||
    claims.runtime.modules !== process.versions.modules ||
    claims.runGeneration < 1
  ) {
    retireQaProfileRoot(profile)
    reject('launch-context-invalid')
  }
  highestAcceptedRunGeneration = claims.runGeneration
  const run = Object.freeze({}) as QaPersistenceRunPermit
  const now = performance.now()
  const wall = Date.now()
  if (!validClockSample(wall, now) || wall >= claims.expiresAt) {
    retireQaProfileRoot(profile)
    reject('run-expired')
  }
  const record: RunRecord = {
    launch,
    profile,
    transport: state.transport ?? reject('transport-unavailable'),
    windowProof: state.windowProof,
    windowSignal: state.windowSignal,
    attempt: state,
    startedAtMonotonic: now,
    runGeneration: claims.runGeneration,
    expiresAt: claims.expiresAt,
    signedExpiryMonotonicCap: now + Math.max(0, claims.expiresAt - wall),
    lastSequence: 0,
    lastHeartbeatMonotonic: now,
    lastWall: wall,
    timer: null,
    retired: false,
    disposed: false,
    settlePromise: null
  }
  records.set(run, record)
  current = run
  state.run = run
  state.phase = 'active'
  scheduleHeartbeatRetirement(run, record)
  return run
}

async function processFrame(state: PendingHandshake, bytes: Buffer): Promise<void> {
  if (state.failure || state.phase === 'settling' || state.phase === 'settled') return
  if (state.phase === 'launch') {
    const launch = verifyQaPersistenceLaunchEnvelope(bytes, state.challenge)
    if (!launch) throw new QaPersistenceRunError('launch-signature-invalid')
    const claims = readVerifiedQaPersistenceLaunch(launch)
    if (!claims || !runtimeTargetSupported()) throw new QaPersistenceRunError('launch-context-invalid')
    if (!signedIntentMatches(launch) || !intentIsCurrent()) throw new QaPersistenceRunError('native-key-intent-changed')
    if (claims.runGeneration <= highestAcceptedRunGeneration) throw new QaPersistenceRunError('launch-context-invalid')
    highestAcceptedRunGeneration = claims.runGeneration
    assertWindowProof(state)
    state.launch = launch
    let profile: QaPersistenceProfileRoot
    try {
      state.profileWork = prepareQaProfileRoot(launch)
      profile = await state.profileWork
    } catch {
      throw new QaPersistenceRunError('profile-owner-invalid')
    }
    if (state.failure) return
    assertWindowProof(state)
    try {
      assertQaProfileCurrent(profile)
    } catch {
      throw new QaPersistenceRunError('profile-owner-invalid')
    }
    let run: QaPersistenceRunPermit
    try {
      run = activateRun(state, launch, profile)
    } catch (error) {
      throw error
    }
    if (state.timeout) clearTimeout(state.timeout)
    state.resolve({ launch, profile })
    return
  }
  const run = state.run
  if (!run) throw new QaPersistenceRunError('run-retired')
  const record = recordFor(run)
  const nowWall = Date.now()
  const nowMonotonic = performance.now()
  assertWindowProof(record)
  if (!intentIsCurrent()) throw new QaPersistenceRunError('native-key-intent-changed')
  if (!validClockSample(nowWall, nowMonotonic) || nowWall < record.lastWall)
    throw new QaPersistenceRunError('heartbeat-invalid')
  const heartbeat = verifyQaPersistenceHeartbeat(
    bytes,
    record.launch,
    record.lastSequence,
    record.lastHeartbeatMonotonic,
    nowWall,
    nowMonotonic
  )
  if (!heartbeat) throw new QaPersistenceRunError('heartbeat-invalid')
  assertQaProfileCurrent(record.profile)
  record.lastSequence = heartbeat.sequence
  record.lastHeartbeatMonotonic = nowMonotonic
  record.lastWall = nowWall
  scheduleHeartbeatRetirement(run, record)
}

function recordFor(run: QaPersistenceRunPermit): RunRecord {
  const record = run && typeof run === 'object' ? records.get(run as object) : undefined
  if (!record || record.retired || record.disposed) reject('run-retired')
  assertQaPersistenceRunCurrent(run)
  return record
}

function dispatchFailure(state: PendingHandshake, error: QaPersistenceRunError): void {
  if (state.failure || state.phase === 'settled' || state.phase === 'settling') return
  state.failure = error
  state.buffer = Buffer.alloc(0)
  if (state.timeout) clearTimeout(state.timeout)
  state.timeout = null

  if (state.phase === 'active') {
    if (state.run) retireQaPersistenceRun(state.run, error.code)
    return
  }

  state.phase = 'settling'
  state.reject(error)
  const close = state.transport?.close()
  if (close) void close.catch(() => undefined)
  state.settlement = (async () => {
    if (state.profileWork) await state.profileWork.catch(() => undefined)
    if (state.pumpPromise) await state.pumpPromise
    if (state.helloWrite) await state.helloWrite.catch(() => undefined)
    if (state.launch) await settleQaProfileRootPreparation(state.launch)
    if (state.transport) await state.transport.close()
    state.windowSignal.removeEventListener('abort', state.abortWindow)
    state.phase = 'settled'
    if (pending === state) pending = null
  })()
  void state.settlement.catch(() => undefined)
}

function dispatchTransportFailure(state: PendingHandshake): void {
  if (state.phase === 'settling' || state.phase === 'settled' || state.failure) return
  dispatchFailure(state, new QaPersistenceRunError('transport-unavailable'))
}

function pumpFrames(state: PendingHandshake): void {
  if (state.processing || state.failure || state.phase === 'settling' || state.phase === 'settled') return
  state.processing = true
  const pump = (async () => {
    while (!state.failure && state.phase !== 'settling' && state.phase !== 'settled') {
      if (state.buffer.byteLength < 4) return
      const length = state.buffer.readUInt32BE(0)
      if (length === 0 || length > QA_CONTROL_MAX_BYTES) throw new QaPersistenceRunError('transport-malformed')
      if (state.buffer.byteLength < length + 4) return
      const message = state.buffer.subarray(4, length + 4)
      state.buffer = state.buffer.subarray(length + 4)
      await processFrame(state, message)
    }
  })()
  state.pumpPromise = pump.then(
    () => undefined,
    (error: unknown) => {
      dispatchFailure(
        state,
        error instanceof QaPersistenceRunError ? error : new QaPersistenceRunError('transport-malformed')
      )
    }
  )
  void state.pumpPromise.then(() => {
    state.processing = false
    state.pumpPromise = null
    if (hasCompleteFrame(state.buffer) && !state.failure) pumpFrames(state)
  })
}

function observeTransport(state: PendingHandshake): void {
  const transport = state.transport
  if (!transport) return
  transport.reader.on('data', (chunk: Buffer | string) => {
    if (state.failure || state.phase === 'settling' || state.phase === 'settled') return
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    if (state.buffer.byteLength + bytes.byteLength > MAX_PENDING_BUFFER_BYTES) {
      dispatchFailure(state, new QaPersistenceRunError('transport-malformed'))
      return
    }
    state.buffer = Buffer.concat([state.buffer, bytes])
    pumpFrames(state)
  })
  transport.reader.on('end', () => dispatchTransportFailure(state))
  transport.reader.on('close', () => dispatchTransportFailure(state))
  transport.reader.on('error', () => dispatchTransportFailure(state))
  transport.writer.on('error', () => dispatchTransportFailure(state))
}

/**
 * Read-only preparation. The caller supplies no paths, keys, identities or callbacks. The only
 * transport is inherited duplex fd 3/4 and a missing compiled D/E stamp always refuses.
 */
export async function prepareQaPersistenceRun(): Promise<QaPersistenceRunPermit> {
  if (pending || current) reject('run-already-owned')
  const windowProof = captureQaPersistenceRunWindowProof()
  if (!windowProof) reject('window-proof-unavailable')
  let windowSignal: AbortSignal
  try {
    assertQaPersistenceRunWindowCurrent(windowProof)
    windowSignal = qaPersistenceRunWindowRetirementSignal(windowProof)
  } catch {
    reject('window-proof-unavailable')
  }
  if (windowSignal.aborted) reject('window-proof-unavailable')
  const runtime = packagedRuntime()
  if (runtime) reject(runtime)
  if (!compiledQaPersistenceRunContext()) reject('build-stamp-missing')
  if (!runtimeTargetSupported()) reject('unsupported-target')

  assertQaPersistenceRunWindowCurrent(windowProof)
  const challenge = newQaPersistenceBootChallenge()
  assertQaPersistenceRunWindowCurrent(windowProof)
  const transport = openFixedTransport()
  let resolveResult!: (result: { launch: VerifiedQaPersistenceLaunch; profile: QaPersistenceProfileRoot }) => void
  let rejectResult!: (error: QaPersistenceRunError) => void
  const result = new Promise<{ launch: VerifiedQaPersistenceLaunch; profile: QaPersistenceProfileRoot }>(
    (resolve, reject) => {
      resolveResult = resolve
      rejectResult = reject
    }
  )
  const state: PendingHandshake = {
    challenge,
    transport,
    windowProof,
    windowSignal,
    resolve: resolveResult,
    reject: rejectResult,
    buffer: Buffer.alloc(0),
    phase: 'launch',
    launch: null,
    run: null,
    processing: false,
    failure: null,
    profileWork: null,
    helloWrite: null,
    settlement: null,
    pumpPromise: null,
    abortWindow: () => dispatchFailure(state, new QaPersistenceRunError('window-proof-unavailable')),
    timeout: null
  }
  pending = state
  windowSignal.addEventListener('abort', state.abortWindow, { once: true })
  observeTransport(state)
  void result.catch(() => undefined)
  state.timeout = setTimeout(
    () => dispatchFailure(state, new QaPersistenceRunError('transport-unavailable')),
    QA_HANDSHAKE_TIMEOUT_MS
  )
  state.timeout.unref?.()

  try {
    const hello = Buffer.from(
      qaPersistenceCanonical({ bootChallenge: challenge, schema: 'metis-persistence-qa-hello/v1' }),
      'utf8'
    )
    state.helloWrite = writeFrame(transport, hello)
    await state.helloWrite
  } catch {
    dispatchFailure(state, new QaPersistenceRunError('transport-unavailable'))
  }
  await result
  const run = current
  if (!run || state.run !== run) reject('run-retired')
  return run
}

/** No-I/O lookup; the returned value is always a live, privately registered run member. */
export function captureCurrentQaPersistenceRun(): QaPersistenceRunPermit | null {
  const run = current
  if (!run) return null
  try {
    assertQaPersistenceRunCurrent(run)
    return run
  } catch {
    return null
  }
}

export function assertQaPersistenceRunCurrent(run: QaPersistenceRunPermit): void {
  const record = run && typeof run === 'object' ? records.get(run as object) : undefined
  if (!record || record.retired || record.disposed) reject('run-retired')
  const nowMonotonic = performance.now()
  const nowWall = Date.now()
  const runtime = packagedRuntime()
  const clockValid =
    validClockSample(nowWall, nowMonotonic) &&
    nowWall >= record.lastWall &&
    nowMonotonic >= record.startedAtMonotonic &&
    nowMonotonic >= record.lastHeartbeatMonotonic
  const expired =
    nowWall >= record.expiresAt ||
    nowMonotonic >= record.signedExpiryMonotonicCap ||
    nowMonotonic - record.startedAtMonotonic >= QA_MAX_RUN_MS
  const heartbeatExpired = nowMonotonic - record.lastHeartbeatMonotonic >= QA_HEARTBEAT_MAX_AGE_MS
  let windowCurrent = false
  try {
    if (!record.windowSignal.aborted) assertQaPersistenceRunWindowCurrent(record.windowProof)
    windowCurrent = !record.windowSignal.aborted
  } catch {
    windowCurrent = false
  }
  if (
    runtime ||
    !QA_IDENTITY_BUILD ||
    !clockValid ||
    expired ||
    heartbeatExpired ||
    !windowCurrent ||
    !intentIsCurrent() ||
    !app.hasSingleInstanceLock()
  ) {
    const code: QaPersistenceRunRefusal = expired ? 'run-expired' : 'run-retired'
    retireQaPersistenceRun(run, code)
    reject(code)
  }
  record.lastWall = nowWall
  try {
    assertQaProfileCurrent(record.profile)
  } catch {
    retireQaPersistenceRun(run, 'profile-owner-invalid')
    reject('profile-owner-invalid')
  }
}

export async function assertQaPersistenceRunPhysicalCurrent(run: QaPersistenceRunPermit): Promise<void> {
  assertQaPersistenceRunCurrent(run)
  const record = recordFor(run)
  try {
    await assertQaProfilePhysicalCurrent(record.profile)
    assertQaPersistenceRunCurrent(run)
  } catch {
    retireQaPersistenceRun(run, 'profile-owner-invalid')
    reject('profile-owner-invalid')
  }
}

export function retireQaPersistenceRun(
  run: QaPersistenceRunPermit,
  reason: QaPersistenceRunRefusal = 'run-retired'
): void {
  const record = run && typeof run === 'object' ? records.get(run as object) : undefined
  if (!record || record.retired || record.disposed) return
  record.retired = true
  record.attempt.failure ??= new QaPersistenceRunError(reason)
  record.attempt.buffer = Buffer.alloc(0)
  if (record.timer) clearTimeout(record.timer)
  record.timer = null
  retireQaProfileRoot(record.profile)
}

export function settleQaPersistenceRun(run: QaPersistenceRunPermit): Promise<void> {
  const record = run && typeof run === 'object' ? records.get(run as object) : undefined
  if (!record) reject('run-retired')
  if (record.settlePromise) return record.settlePromise
  record.retired = true
  record.attempt.phase = 'settling'
  record.attempt.failure ??= new QaPersistenceRunError('run-retired')
  record.attempt.buffer = Buffer.alloc(0)
  if (record.timer) clearTimeout(record.timer)
  record.timer = null
  retireQaProfileRoot(record.profile)
  record.settlePromise = (async () => {
    const transportClose = record.transport.close()
    void transportClose.catch(() => undefined)
    if (record.attempt.profileWork) await record.attempt.profileWork.catch(() => undefined)
    if (record.attempt.pumpPromise) await record.attempt.pumpPromise
    const settlements = await Promise.allSettled([transportClose, settleQaProfileRootPreparation(record.launch)])
    const failure = settlements.find((result) => result.status === 'rejected')
    if (failure?.status === 'rejected') throw failure.reason
    record.disposed = true
    record.attempt.windowSignal.removeEventListener('abort', record.attempt.abortWindow)
    record.attempt.phase = 'settled'
    if (current === run) current = null
    if (pending === record.attempt) pending = null
  })()
  return record.settlePromise
}

/** The root handle has no authority without this run's independently checked permit. */
export function qaProfileRootForRun(run: QaPersistenceRunPermit): QaPersistenceProfileRoot {
  const record = recordFor(run)
  return record.profile
}

export function qaPersistenceRunGenerationForOwner(run: QaPersistenceRunPermit): number {
  return recordFor(run).runGeneration
}

export function qaPersistenceRunProfilePath(run: QaPersistenceRunPermit): string {
  const record = recordFor(run)
  const claims = readVerifiedQaPersistenceLaunch(record.launch)
  if (!claims) reject('launch-signature-invalid')
  return claims.profile.path
}
