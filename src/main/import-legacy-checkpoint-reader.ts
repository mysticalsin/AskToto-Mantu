import { createHash, randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import {
  type ImportLegacyBounds,
  ImportLegacyAdapterError,
  type ImportLegacyCheckpointReaderOptions,
  type ImportLegacyFailure,
  type ImportLegacyHeldSource,
  type ImportLegacyReadResult,
  type ImportLegacySynchronousGuard,
  type ImportLegacySourceAdmission,
  type ImportLegacyFileVersion,
  type ImportLegacyTotals,
  type ImportLegacyWorkerPort,
  type ImportOperationScope,
  captureImportLegacyBounds,
  validateImportLegacyBounds
} from './import-legacy-checkpoint-contract'
import { isLegacyOutput, type LegacyOutput, type LegacyV2Descriptor } from './import-legacy-checkpoint-protocol'

const MARKER_V1 = Buffer.from('ATKENC1\n')
const MARKER_V2 = Buffer.from('ATKENC2\n')
const V10 = Buffer.from('v10')
const V10_MIN_INDEXABLE = 15

function validJobId(jobId: string): boolean {
  return /^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|[0-9a-f]{32})$/.test(
    jobId
  )
}

type Reply = LegacyOutput

class WorkerReplies {
  private readonly queue: Reply[] = []
  private pending: ((value: Reply) => void) | undefined
  private failed = false

  constructor(private readonly worker: ImportLegacyWorkerPort) {
    worker.onMessage((raw) => {
      if (!isLegacyOutput(raw)) {
        this.fail()
        return
      }
      if (this.pending) {
        const resolve = this.pending
        this.pending = undefined
        resolve(raw)
        return
      }
      if (this.queue.length !== 0) {
        this.fail()
        return
      }
      this.queue.push(raw)
    })
    worker.onError(() => this.fail())
    worker.onExit((code) => {
      if (code !== 0) this.fail()
    })
  }

  next(deadlineMs: number): Promise<Reply> {
    if (this.failed) return Promise.reject(new Error('worker'))
    const queued = this.queue.shift()
    if (queued) return Promise.resolve(queued)
    if (this.pending) return Promise.reject(new Error('protocol'))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending === finish) this.pending = undefined
        reject(new Error('deadline'))
      }, deadlineMs)
      const finish = (message: Reply): void => {
        clearTimeout(timer)
        resolve(message)
      }
      this.pending = finish
      if (this.failed) {
        clearTimeout(timer)
        this.pending = undefined
        reject(new Error('worker'))
      }
    })
  }

  private fail(): void {
    this.failed = true
    if (this.pending) {
      const pending = this.pending
      this.pending = undefined
      // A synthetic closed failure is never accepted by the session sequence checks.
      pending({ protocol: 1, type: 'refused', sessionId: '', reason: 'WORKER_FAILED' })
    }
  }
}

export function createImportLegacyCheckpointReader(options: ImportLegacyCheckpointReaderOptions) {
  return (jobId: string, scope: ImportOperationScope): Promise<ImportLegacyReadResult> => {
    if (!validJobId(jobId)) return Promise.resolve({ status: 'refused', reason: 'MALFORMED' })
    let bounds: ImportLegacyBounds | undefined
    try {
      bounds = options.bounds(scope)
    } catch {
      return Promise.resolve({ status: 'refused', reason: 'UNCONFIGURED' })
    }
    if (!validateImportLegacyBounds(bounds)) return Promise.resolve({ status: 'refused', reason: 'UNCONFIGURED' })
    const policy = captureImportLegacyBounds(bounds)
    const deadline = performance.now() + policy.operationDeadlineMs
    let activeLease: Awaited<ReturnType<ImportLegacyCheckpointReaderOptions['resources']['acquire']>> | undefined
    let activeSource: ImportLegacyHeldSource | undefined
    let activeCandidate: Awaited<ReturnType<ImportLegacyCheckpointReaderOptions['candidate']['begin']>> | undefined
    let activeWorkerStop: (() => Promise<void>) | undefined
    let activeCandidateAbort: Promise<void> | undefined
    let retired = false
    let cleanupFailed = false
    const abortCandidate = (candidate: NonNullable<typeof activeCandidate>): Promise<void> => {
      try {
        candidate.requestAbortOwnedCandidate()
      } catch {
        cleanupFailed = true
      }
      activeCandidateAbort ??= Promise.resolve()
        .then(() => candidate.abortOwnedCandidate())
        .catch(() => {
          cleanupFailed = true
        })
      return activeCandidateAbort
    }
    const retire = (): void => {
      retired = true
      try {
        activeLease?.quarantine('DEADLINE', policy.shutdownDeadlineMs)
      } catch {
        cleanupFailed = true
      }
      try {
        activeSource?.requestCancel()
      } catch {
        cleanupFailed = true
      }
      if (activeCandidate) void abortCandidate(activeCandidate)
      try {
        if (activeWorkerStop) void activeWorkerStop().catch(() => (cleanupFailed = true))
      } catch {
        cleanupFailed = true
      }
    }
    const operation = (async (): Promise<ImportLegacyReadResult> => {
      let source: ImportLegacyHeldSource | undefined
      let candidate: Awaited<ReturnType<ImportLegacyCheckpointReaderOptions['candidate']['begin']>> | undefined
      let resourceLease: Awaited<ReturnType<ImportLegacyCheckpointReaderOptions['resources']['acquire']>> | undefined
      let published = false
      let reason: ImportLegacyFailure = 'WORKER_FAILED'
      let candidateRecordSequence = 0
      const remaining = (): number => {
        const ms = Math.floor(deadline - performance.now())
        if (ms <= 0) throw new ReaderFailure('DEADLINE')
        return ms
      }
      const synchronousGuard = Object.freeze({
        assertCurrent(): void {
          options.authority.assertCurrent(scope)
          remaining()
        }
      })
      const current = async (): Promise<void> => {
        options.authority.assertCurrent(scope)
        await options.authority.refreshSameScope(scope)
        options.authority.assertCurrent(scope)
        remaining()
      }
      const cleanupWait = async (operation: () => Promise<unknown>): Promise<void> => {
        try {
          await operation()
        } catch {
          cleanupFailed = true
        }
      }
      const settleWorker = async (operation: () => Promise<unknown>): Promise<void> => {
        try {
          await operation()
        } catch (error) {
          cleanupFailed = true
          throw error
        }
      }
      try {
        await current()
        resourceLease = await options.resources.acquire(scope, policy, policy.operationDeadlineMs)
        activeLease = resourceLease
        if (retired) {
          resourceLease.quarantine('DEADLINE', policy.shutdownDeadlineMs)
          throw new ReaderFailure('DEADLINE')
        }
        await current()
        source = await options.source.open(jobId, scope)
        activeSource = source
        if (retired) {
          source.requestCancel()
          throw new ReaderFailure('DEADLINE')
        }
        await current()
        const initial = Object.freeze({ ...source.version })
        await assertSourceCurrent(source, initial, scope, current)
        if (
          !Number.isSafeInteger(initial.size) ||
          initial.size <= 0 ||
          initial.size > policy.maxPhysicalBytes ||
          initial.size > policy.maxStagingBytes ||
          !Number.isSafeInteger(initial.nlink) ||
          initial.nlink !== 1 ||
          !Number.isSafeInteger(initial.dev) ||
          !Number.isSafeInteger(initial.ino) ||
          initial.dev < 0 ||
          initial.ino < 0 ||
          !Number.isFinite(initial.mtimeMs) ||
          !Number.isFinite(initial.ctimeMs)
        )
          return { status: 'refused', reason: initial.size > policy.maxPhysicalBytes ? 'LIMIT' : 'SOURCE_CHANGED' }
        const prefix = new Uint8Array(Math.min(MARKER_V2.byteLength, initial.size))
        await readExact(source, initial, scope, 0, prefix, policy.maxChunkBytes, synchronousGuard, current)
        if (startsWith(prefix, MARKER_V2)) {
          const scan = await runPass('v2-scan', MARKER_V2.byteLength, initial.size - MARKER_V2.byteLength)
          if (scan.type !== 'scan-complete')
            return { status: 'refused', reason: scan.type === 'refused' ? scan.reason : 'MALFORMED' }
          if (
            scan.descriptor.ciphertextBytes <= 0 ||
            scan.descriptor.ciphertextBytes > initial.size ||
            Buffer.byteLength(scan.descriptor.iv, 'utf8') +
              Buffer.byteLength(scan.descriptor.tag, 'utf8') +
              Buffer.byteLength(scan.descriptor.kLocal, 'utf8') +
              Buffer.byteLength(scan.descriptor.kEscrow ?? '', 'utf8') >
              policy.maxDescriptorBytes
          )
            return { status: 'refused', reason: 'LIMIT' }
          await verifySource(source, initial, scope, current)
          const admission = await source.admitOriginalSource(initial, scope)
          await current()
          admission.assertCurrent()
          const key = await options.keys.unwrapV2(scan.descriptor.kLocal, admission, scope)
          let decrypted: Extract<Reply, { type: 'complete' | 'scan-complete' | 'refused' }> | undefined
          try {
            await current()
            admission.assertCurrent()
            await verifySource(source, initial, scope, current)
            if (!exactKey(key)) return { status: 'refused', reason: 'KEY_UNAVAILABLE' }
            candidate = await options.candidate.begin(jobId, initial.size, policy.maxStagingBytes, scope)
            activeCandidate = candidate
            if (retired) {
              void abortCandidate(candidate)
              throw new ReaderFailure('DEADLINE')
            }
            await current()
            decrypted = await runPass(
              'v2-decrypt',
              MARKER_V2.byteLength,
              initial.size - MARKER_V2.byteLength,
              scan.descriptor,
              key
            )
          } finally {
            if (key instanceof Uint8Array) key.fill(0)
          }
          if (!decrypted) return { status: 'refused', reason: 'WORKER_FAILED' }
          if (decrypted.type !== 'complete' || decrypted.sourceDigest !== scan.sourceDigest)
            return { status: 'refused', reason: decrypted.type === 'refused' ? decrypted.reason : 'SOURCE_CHANGED' }
          const ready = await finishCandidate(decrypted, scan.sourceDigest)
          return ready
        }
        let format: 'plain' | 'native-v1-plaintext' = 'plain'
        let nativeText: string | undefined
        let nativeSourceDigest: string | undefined
        if (startsWith(prefix, MARKER_V1)) {
          const nativeProfile = policy.nativeV1
          if ('unavailable' in nativeProfile) return { status: 'refused', reason: 'NATIVE_V1_UNAVAILABLE' }
          const ciphertextBytes = initial.size - MARKER_V1.byteLength
          const nativeResidentBytes = safeSum(
            ciphertextBytes,
            nativeProfile.maxNativePeakBytes,
            4 * policy.maxChunkBytes,
            8 * policy.maxRecordBytes,
            4 * policy.maxHeaderBytes,
            2 * policy.maxDescriptorBytes
          )
          if (
            ciphertextBytes > nativeProfile.maxCiphertextBytes ||
            !Number.isSafeInteger(ciphertextBytes) ||
            ciphertextBytes <= 0 ||
            nativeResidentBytes === undefined ||
            nativeResidentBytes > policy.maxResidentBytes
          )
            return { status: 'refused', reason: 'LIMIT' }
          const ciphertext = new Uint8Array(ciphertextBytes)
          await readExact(
            source,
            initial,
            scope,
            MARKER_V1.byteLength,
            ciphertext,
            policy.maxChunkBytes,
            synchronousGuard,
            current
          )
          nativeSourceDigest = createHash('sha256').update(ciphertext).digest('hex')
          if (startsWith(ciphertext, V10) && ciphertext.byteLength < V10_MIN_INDEXABLE)
            return { status: 'refused', reason: 'MALFORMED' }
          if (!options.keys.decryptNativeV1) return { status: 'refused', reason: 'NATIVE_V1_UNAVAILABLE' }
          try {
            const admission = await source.admitOriginalSource(initial, scope)
            await current()
            admission.assertCurrent()
            nativeText = await options.keys.decryptNativeV1(ciphertext, nativeProfile, admission, scope)
            await current()
            admission.assertCurrent()
            await verifySource(source, initial, scope, current)
          } finally {
            ciphertext.fill(0)
          }
          if (Buffer.byteLength(nativeText, 'utf8') > nativeProfile.maxPlaintextBytes)
            return { status: 'refused', reason: 'LIMIT' }
          format = 'native-v1-plaintext'
        }
        prefix.fill(0)
        candidate = await options.candidate.begin(jobId, initial.size, policy.maxStagingBytes, scope)
        activeCandidate = candidate
        if (retired) {
          void abortCandidate(candidate)
          throw new ReaderFailure('DEADLINE')
        }
        await current()
        const final = await runPass(
          format,
          format === 'plain' ? 0 : MARKER_V1.byteLength,
          format === 'plain' ? initial.size : 0,
          undefined,
          undefined,
          nativeText
        )
        if (final.type !== 'complete')
          return { status: 'refused', reason: final.type === 'refused' ? final.reason : 'MALFORMED' }
        return await finishCandidate(final, nativeSourceDigest ?? final.sourceDigest)

        async function runPass(
          passFormat: 'plain' | 'native-v1-plaintext' | 'v2-scan' | 'v2-decrypt',
          sourceOffset: number,
          byteLength: number,
          descriptor?: LegacyV2Descriptor,
          key?: Uint8Array,
          text?: string
        ): Promise<Extract<Reply, { type: 'complete' | 'scan-complete' | 'refused' }>> {
          await current()
          const ownedWorker = await options.createWorker()
          let termination: Promise<void> | undefined
          const terminate = (): Promise<void> => {
            termination ??= Promise.resolve().then(() => ownedWorker.terminate())
            return termination
          }
          activeWorkerStop = terminate
          try {
            if (retired) throw new ReaderFailure('DEADLINE')
            await current()
            const sessionId = randomUUID()
            const replies = new WorkerReplies(ownedWorker)
            ownedWorker.post({ protocol: 1, op: 'open', sessionId, format: passFormat, bounds: policy })
            let reply = await replies.next(remaining())
            await current()
            if (reply.type !== 'input-credit' || reply.sessionId !== sessionId || reply.nextSequence !== 0)
              return {
                protocol: 1,
                type: 'refused',
                sessionId,
                reason: reply.type === 'refused' ? reply.reason : 'WORKER_FAILED'
              }
            if (key && descriptor) {
              const transferKey = exactCopy(key)
              ownedWorker.post({ protocol: 1, op: 'key', sessionId, descriptor, key: transferKey }, [
                transferKey.buffer as ArrayBuffer
              ])
            }
            let sequence = 0
            const sendChunk = async (bytes: Uint8Array): Promise<void> => {
              await current()
              if (bytes.byteLength > policy.maxChunkBytes || bytes.byteLength > policy.maxResidentBytes)
                throw new ReaderFailure('LIMIT')
              ownedWorker.post({ protocol: 1, op: 'chunk', sessionId, sequence, bytes }, [bytes.buffer as ArrayBuffer])
              const sentSequence = sequence++
              for (;;) {
                const output = await replies.next(remaining())
                await current()
                if (output.sessionId !== sessionId) throw new ReaderFailure('WORKER_FAILED')
                if (output.type === 'record') {
                  if (
                    output.recordSequence !== candidateRecordSequence++ ||
                    output.recordJson.byteLength > policy.maxRecordBytes
                  )
                    throw new ReaderFailure('WORKER_FAILED')
                  await appendRecord(output.recordJson)
                  ownedWorker.post({ protocol: 1, op: 'record-ack', sessionId, recordSequence: output.recordSequence })
                } else if (output.type === 'input-credit' && output.nextSequence === sentSequence + 1) return
                else if (output.type === 'refused') throw new ReaderFailure(output.reason)
                else throw new ReaderFailure('WORKER_FAILED')
              }
            }
            if (text !== undefined) {
              let offset = 0
              while (offset < text.length) {
                let end = Math.min(text.length, offset + Math.max(1, Math.floor(policy.maxChunkBytes / 3)))
                if (end < text.length && text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff)
                  end -= 1
                await sendChunk(exactCopy(Buffer.from(text.slice(offset, end), 'utf8')))
                offset = end
              }
            } else {
              for (let offset = 0; offset < byteLength; offset += policy.maxChunkBytes) {
                const length = Math.min(policy.maxChunkBytes, byteLength - offset)
                const bytes = new Uint8Array(length)
                await readExact(
                  source!,
                  initial,
                  scope,
                  sourceOffset + offset,
                  bytes,
                  policy.maxChunkBytes,
                  synchronousGuard,
                  current
                )
                await sendChunk(bytes)
              }
            }
            await current()
            ownedWorker.post({ protocol: 1, op: 'end', sessionId })
            for (;;) {
              reply = await replies.next(remaining())
              await current()
              if (reply.sessionId !== sessionId) throw new ReaderFailure('WORKER_FAILED')
              if (reply.type === 'record') {
                if (
                  reply.recordSequence !== candidateRecordSequence++ ||
                  reply.recordJson.byteLength > policy.maxRecordBytes
                )
                  throw new ReaderFailure('WORKER_FAILED')
                await appendRecord(reply.recordJson)
                ownedWorker.post({ protocol: 1, op: 'record-ack', sessionId, recordSequence: reply.recordSequence })
                continue
              }
              if (reply.type === 'input-credit') continue
              if (reply.type === 'scan-complete' || reply.type === 'complete' || reply.type === 'refused') return reply
              throw new ReaderFailure('WORKER_FAILED')
            }
          } finally {
            await settleWorker(terminate)
            if (activeWorkerStop === terminate) activeWorkerStop = undefined
          }
        }

        async function finishCandidate(
          final: Extract<Reply, { type: 'complete' }>,
          sourceDigest: string
        ): Promise<ImportLegacyReadResult> {
          if (
            final.header.jobId !== jobId ||
            final.totals.decodedBytes > policy.maxDecodedBytes ||
            final.totals.records > policy.maxRecords ||
            final.totals.words > policy.maxWords ||
            final.totals.payloadBytes > policy.maxPayloadBytes ||
            !/^[a-f0-9]{64}$/.test(sourceDigest)
          )
            return { status: 'refused', reason: 'MALFORMED' }
          await verifySource(source!, initial, scope, current)
          await current()
          const admission: ImportLegacySourceAdmission = await source!.admitOriginalSource(initial, scope)
          await current()
          admission.assertCurrent()
          const totals: ImportLegacyTotals = { ...final.totals, physicalBytes: initial.size, sourceDigest }
          const guard = Object.freeze({
            assertCurrent(): void {
              options.authority.assertCurrent(scope)
              admission.assertCurrent()
              remaining()
            }
          })
          guard.assertCurrent()
          const transcript = await candidate!.publish(final.header, totals, admission, guard, scope)
          await current()
          published = true
          return { status: 'ready', header: final.header, transcript, totals }
        }

        async function appendRecord(recordJson: Uint8Array): Promise<void> {
          await current()
          const owned = exactCopy(recordJson)
          try {
            await candidate!.append(owned, scope)
          } finally {
            owned.fill(0)
            recordJson.fill(0)
          }
          await current()
        }
      } catch (error) {
        reason =
          error instanceof ReaderFailure
            ? error.reason
            : error instanceof ImportLegacyAdapterError
              ? error.reason
              : 'WORKER_FAILED'
        return { status: 'refused', reason }
      } finally {
        if (!published && candidate) {
          await cleanupWait(() => abortCandidate(candidate!))
        }
        if (source) {
          if (!published) {
            try {
              source.requestCancel()
            } catch {
              cleanupFailed = true
            }
          }
          await cleanupWait(() => source!.settled())
          await cleanupWait(() => source!.close())
        }
        if (resourceLease) {
          if (cleanupFailed) {
            try {
              resourceLease.quarantine('CLEANUP_FAILED', policy.shutdownDeadlineMs)
            } catch {
              cleanupFailed = true
            }
          } else {
            try {
              await resourceLease.settled()
            } catch {
              cleanupFailed = true
              try {
                resourceLease.quarantine('CLEANUP_FAILED', policy.shutdownDeadlineMs)
              } catch {
                cleanupFailed = true
              }
            }
          }
        }
      }
    })()
    let timer: ReturnType<typeof setTimeout> | undefined
    const callerDeadline = new Promise<ImportLegacyReadResult>((resolve) => {
      timer = setTimeout(() => {
        try {
          retire()
        } catch {
          cleanupFailed = true
        } finally {
          resolve({ status: 'refused', reason: 'DEADLINE' })
        }
      }, policy.operationDeadlineMs)
    })
    return Promise.race([
      operation.catch(
        (error): ImportLegacyReadResult => ({
          status: 'refused',
          reason:
            error instanceof ReaderFailure || error instanceof ImportLegacyAdapterError ? error.reason : 'WORKER_FAILED'
        })
      ),
      callerDeadline
    ]).finally(() => {
      if (timer !== undefined) clearTimeout(timer)
    })
  }
}

class ReaderFailure extends Error {
  constructor(readonly reason: ImportLegacyFailure) {
    super(reason)
  }
}

function startsWith(value: Uint8Array, prefix: Uint8Array): boolean {
  if (value.byteLength < prefix.byteLength) return false
  for (let i = 0; i < prefix.byteLength; i += 1) if (value[i] !== prefix[i]) return false
  return true
}

async function readExact(
  source: ImportLegacyHeldSource,
  version: ImportLegacyFileVersion,
  scope: ImportOperationScope,
  position: number,
  target: Uint8Array,
  maxReadBytes: number,
  guard: ImportLegacySynchronousGuard,
  current: () => Promise<void>
): Promise<void> {
  await current()
  try {
    let filled = 0
    while (filled < target.byteLength) {
      await current()
      await source.assertCurrentVersion(version, scope)
      await current()
      const view = target.subarray(filled, Math.min(target.byteLength, filled + maxReadBytes))
      guard.assertCurrent()
      const result = await source.readAt(position + filled, view, version, scope, guard)
      await current()
      await source.assertCurrentVersion(version, scope)
      await current()
      if (!Number.isSafeInteger(result) || result <= 0 || result > view.byteLength)
        throw new ReaderFailure('SOURCE_CHANGED')
      filled += result
    }
  } catch (error) {
    target.fill(0)
    throw error
  }
}

async function verifySource(
  source: ImportLegacyHeldSource,
  initial: ImportLegacyFileVersion,
  scope: ImportOperationScope,
  current: () => Promise<void>
): Promise<void> {
  await current()
  await source.assertCurrentVersion(initial, scope)
  await current()
}

async function assertSourceCurrent(
  source: ImportLegacyHeldSource,
  initial: ImportLegacyFileVersion,
  scope: ImportOperationScope,
  current: () => Promise<void>
): Promise<void> {
  await current()
  await source.assertCurrentVersion(initial, scope)
  await current()
}

function exactKey(value: Uint8Array): boolean {
  return (
    value instanceof Uint8Array &&
    Object.getPrototypeOf(value) === Uint8Array.prototype &&
    value.byteOffset === 0 &&
    value.byteLength === 32 &&
    value.buffer instanceof ArrayBuffer &&
    value.buffer.byteLength === 32 &&
    !Object.getOwnPropertyDescriptor(value, 'byteLength')
  )
}

function exactCopy(bytes: Uint8Array): Uint8Array {
  const owned = new Uint8Array(bytes.byteLength)
  owned.set(bytes)
  return owned
}

function safeSum(...values: number[]): number | undefined {
  let total = 0
  for (const value of values) {
    total += value
    if (!Number.isSafeInteger(total)) return undefined
  }
  return total
}
