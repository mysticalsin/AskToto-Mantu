import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { isHtmlContentType, looksLikeAccessRedirect, looksLikeHtmlBytes } from '../../../../shared/bundle-response'
import { assertCurrentSpeechPackInstallAdmission, type CurrentSpeechPackInstallAdmission } from './install-admission'
import { SpeechPackError, type SpeechPackErrorKind } from './errors'
import { componentManifestIdentity } from './resolver'
import { isImmutableUrl, speechPackFileUrl, SPEECH_PACK_COMPONENTS, type SpeechPackComponent } from './manifest'
import {
  appendRuntimeOwnedTransfer,
  discardRuntimeOwnedTransfer,
  finishRuntimeOwnedTransfer,
  restartRuntimeOwnedTransfer,
  resumeRuntimeOwnedTransfer,
  runtimeOwnedTransferProgress,
  setRuntimeOwnedTransferValidator,
  stopRuntimeOwnedTransfer,
  suspendRuntimeOwnedTransfer,
  type RuntimeOwnedTransferAction,
  type RuntimeOwnedTransferBounds,
  type RuntimeOwnedTransferCleanupOutcome,
  type RuntimeOwnedTransferPendingCleanup,
  type RuntimeOwnedTransferSuspension,
  type RuntimeOwnedTransferTarget,
  type RuntimeOwnedTransferAttempt,
  type RuntimeOwnedTransferCleanup,
  type RuntimeOwnedTransferVerified
} from '../../../infra/storage/runtime-owned-transfer'
import type { RuntimeOwnedTreeWriter } from '../../../infra/storage/runtime-owned-tree-record'
import { beginRuntimeOwnedTreeDownload } from '../../../infra/storage/runtime-owned-tree'
import {
  issueRuntimePayloadFilePin,
  runtimePayloadPlanFileClaims,
  runtimePayloadPlanIdentity,
  runtimePayloadPlanParentGraph,
  runtimePayloadPlanRoot,
  type RuntimePayloadWritePlan
} from '../../../infra/storage/runtime-payload-plan'

declare const speechOwnedDownloadBrand: unique symbol
export type SpeechOwnedDownload = { readonly [speechOwnedDownloadBrand]: true }

export interface OwnedDownloadNetworkDeps {
  readonly fetch: typeof fetch
  readonly random: () => number
  readonly timing: {
    readonly requestTimeoutMs: number
    readonly idleTimeoutMs: number
    readonly maxAttempts: number
    readonly backoffBaseMs: number
    readonly backoffCapMs: number
    readonly retryAfterCapMs: number
  }
}

export type SpeechOwnedDownloadOutcome =
  | { readonly status: 'verified'; readonly verified: RuntimeOwnedTransferVerified }
  | { readonly status: 'paused'; readonly suspended: RuntimeOwnedTransferSuspension }
  | { readonly status: 'cancelled'; readonly cleanup: RuntimeOwnedTransferCleanupOutcome }

interface Entry {
  readonly component: SpeechPackComponent
  readonly file: SpeechPackComponent['files'][number]
  readonly url: string
  readonly identity: object
  readonly transaction: symbol
  readonly writer: RuntimeOwnedTreeWriter
  readonly bounds: RuntimeOwnedTransferBounds
  readonly cleanup: RuntimeOwnedTransferCleanup
  readonly target: RuntimeOwnedTransferTarget
  attempt: RuntimeOwnedTransferAttempt
  admission: CurrentSpeechPackInstallAdmission
  verified: RuntimeOwnedTransferVerified | null
  suspended: RuntimeOwnedTransferSuspension | null
  running: boolean
  run: Promise<SpeechOwnedDownloadOutcome> | null
  abortRun: (() => void) | null
  externalAbort: AbortController | null
  requests: number
  transientAttempts: number
  digestFailures: number
  networkUnsettled: boolean
}

const issued = new WeakMap<object, Entry>()

function actionFor(admission: CurrentSpeechPackInstallAdmission): RuntimeOwnedTransferAction {
  return Object.freeze({
    identity: admission as object,
    transaction: admission.transaction,
    assertCurrentSync: admission.assertCurrent
  })
}

function assertSamePlan(
  component: SpeechPackComponent,
  plan: RuntimePayloadWritePlan,
  admission: CurrentSpeechPackInstallAdmission
): void {
  const root = `.staging/${component.id}/${component.version}`
  const parentGraph = runtimePayloadPlanParentGraph(plan)
  if (
    runtimePayloadPlanRoot(plan) !== root ||
    parentGraph.componentId !== component.id ||
    parentGraph.componentVersion !== component.version
  )
    throw new Error('SPEECH_OWNED_DOWNLOAD_PLAN_ROOT_MISMATCH')
  const claims = runtimePayloadPlanFileClaims(plan)
  const expected = [...component.files]
    .map((file) => ({ relativePath: file.path, byteLength: file.bytes, sha256: file.sha256 }))
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath))
  const actual = [...claims].sort((a, b) => a.relativePath.localeCompare(b.relativePath))
  if (
    actual.length !== expected.length ||
    actual.some((claim, index) => {
      const match = expected[index]
      return (
        !match ||
        claim.relativePath !== match.relativePath ||
        claim.byteLength !== match.byteLength ||
        claim.sha256 !== match.sha256
      )
    })
  )
    throw new Error('SPEECH_OWNED_DOWNLOAD_PLAN_CLAIMS_MISMATCH')
  const identityInput = JSON.stringify({
    schemaVersion: 1,
    componentId: component.id,
    componentVersion: component.version,
    manifestIdentity: admission.manifestIdentity,
    resourcePolicyIdentity: admission.resourcePolicyIdentity,
    rootRelativePath: root,
    files: component.files.map((file) => ({ path: file.path, byteLength: file.bytes, sha256: file.sha256 }))
  })
  const expectedIdentity = createHash('sha256')
    .update('metis-runtime-payload-plan/v1\0')
    .update(identityInput)
    .digest('hex')
  if (runtimePayloadPlanIdentity(plan) !== expectedIdentity)
    throw new Error('SPEECH_OWNED_DOWNLOAD_PLAN_IDENTITY_MISMATCH')
}

export async function prepareSpeechOwnedDownload(input: {
  readonly admission: CurrentSpeechPackInstallAdmission
  readonly writer: RuntimeOwnedTreeWriter
  readonly plan: RuntimePayloadWritePlan
  readonly relativePath: string
  readonly bounds: RuntimeOwnedTransferBounds
  readonly assertCleanupCurrentSync: () => void
}): Promise<SpeechOwnedDownload> {
  const captured = input.admission
  const capturedIdentity = captured as object
  captured.assertCurrent()
  await assertCurrentSpeechPackInstallAdmission(captured)
  captured.assertCurrent()
  const component = SPEECH_PACK_COMPONENTS.find((candidate) => candidate.id === captured.componentId)
  if (!component || componentManifestIdentity(component) !== captured.manifestIdentity)
    throw new Error('SPEECH_OWNED_DOWNLOAD_MANIFEST_MISMATCH')
  if (component.source.kind !== 'files' || component.source.baseUrl === null)
    throw new Error('SPEECH_OWNED_DOWNLOAD_SOURCE_UNAVAILABLE')
  const file = component.files.find((candidate) => candidate.path === input.relativePath)
  if (!file) throw new Error('SPEECH_OWNED_DOWNLOAD_FILE_NOT_PINNED')
  const url = speechPackFileUrl(component, file)
  if (!url || new URL(url).protocol !== 'https:' || !isImmutableUrl(url))
    throw new Error('SPEECH_OWNED_DOWNLOAD_URL_NOT_IMMUTABLE_HTTPS')
  assertSamePlan(component, input.plan, captured)
  if (input.bounds.maximumChunkBytes < 512) throw new Error('SPEECH_OWNED_DOWNLOAD_CHUNK_LIMIT')
  captured.assertCurrent()
  const pin = issueRuntimePayloadFilePin(input.plan, file.path)
  const start = await beginRuntimeOwnedTreeDownload({
    writer: input.writer,
    pin,
    action: actionFor(captured),
    bounds: input.bounds,
    assertCleanupCurrentSync: input.assertCleanupCurrentSync
  })
  try {
    captured.assertCurrent()
  } catch (error) {
    await discardRuntimeOwnedTransfer(start.target, start.cleanup).settled
    throw error
  }
  const token = Object.freeze(Object.create(null)) as SpeechOwnedDownload
  issued.set(token as object, {
    component,
    file,
    url,
    identity: capturedIdentity,
    transaction: captured.transaction,
    writer: input.writer,
    bounds: Object.freeze({ ...input.bounds }),
    cleanup: start.cleanup,
    target: start.target,
    attempt: start.attempt,
    admission: captured,
    verified: null,
    suspended: null,
    running: false,
    run: null,
    abortRun: null,
    externalAbort: null,
    requests: 0,
    transientAttempts: 0,
    digestFailures: 0,
    networkUnsettled: false
  })
  return token
}

function entryFor(download: SpeechOwnedDownload): Entry {
  const entry = issued.get(download as object)
  if (!entry) throw new Error('SPEECH_OWNED_DOWNLOAD_TOKEN_INVALID')
  return entry
}

function validatorOf(headers: Headers): string | null {
  const etag = headers.get('etag')
  if (etag && etag.length <= 1024 && /^"[\x21\x23-\x7e]*"$/.test(etag)) return etag
  const modified = headers.get('last-modified')
  return modified &&
    modified.length <= 64 &&
    Number.isFinite(Date.parse(modified)) &&
    new Date(Date.parse(modified)).toUTCString() === modified
    ? modified
    : null
}
function decimal(value: string | null): number | null {
  if (value === null || !/^(0|[1-9][0-9]*)$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : null
}
function retryAfter(headers: Headers, cap: number): number {
  const value = headers.get('retry-after')
  if (!value) return 0
  const seconds = decimal(value)
  const delay = seconds !== null ? seconds * 1000 : Date.parse(value) - Date.now()
  return Number.isFinite(delay) ? Math.min(cap, Math.max(0, delay)) : 0
}
function isHtml(headers: Headers): boolean {
  return isHtmlContentType(headers.get('content-type'))
}
function htmlPrefix(bytes: Uint8Array): boolean {
  return looksLikeHtmlBytes(bytes)
}
function accessRedirect(location: string): boolean {
  return looksLikeAccessRedirect(location) || /(?:login|signin|sign-in|oauth|authorize)/i.test(location)
}

function ownedFailure(error: unknown): SpeechPackError {
  if (error instanceof SpeechPackError) return error
  const message = error instanceof Error ? error.message : 'SPEECH_OWNED_DOWNLOAD_UNKNOWN'
  const kind: SpeechPackErrorKind = /CAPTIVE|LOGIN|HTML/.test(message)
    ? 'captive'
    : /DIGEST|EXCESS|OWNER_CHANGED|PREFIX_CHANGED/.test(message)
      ? 'tamper'
      : /ADMISSION|POLICY|HANDOVER|LIMIT|IMMUTABLE|DOWNGRADE|TIMING/.test(message)
        ? 'policy'
        : /HTTP_|RANGE|VALIDATOR|DECLARED_LENGTH/.test(message)
          ? 'http'
          : /RUNTIME_|DISK/.test(message)
            ? 'disk'
            : 'offline'
  return new SpeechPackError(kind, message)
}

async function cancelUnclaimed(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch (error) {
    throw Object.assign(new Error('SPEECH_OWNED_DOWNLOAD_BODY_UNSETTLED', { cause: error }), {
      networkUnsettled: true
    })
  }
}

async function request(
  url: string,
  headers: NonNullable<Parameters<typeof fetch>[1]>['headers'],
  signal: AbortSignal,
  deps: OwnedDownloadNetworkDeps,
  assertCurrent: () => void,
  countRequest: () => void
): Promise<Response> {
  let current = url
  for (let hop = 0; hop <= 5; hop++) {
    assertCurrent()
    countRequest()
    const response = await deps.fetch(current, { headers, signal, redirect: 'manual' })
    try {
      assertCurrent()
    } catch (error) {
      await cancelUnclaimed(response)
      throw error
    }
    if (response.status < 300 || response.status >= 400) return response
    const location = response.headers.get('location')
    await cancelUnclaimed(response)
    assertCurrent()
    if (!location) throw new Error('SPEECH_OWNED_DOWNLOAD_REDIRECT_WITHOUT_LOCATION')
    if (accessRedirect(location)) throw new Error('SPEECH_OWNED_DOWNLOAD_CAPTIVE_REDIRECT')
    const next = new URL(location, current)
    if (new URL(current).protocol === 'https:' && next.protocol !== 'https:')
      throw new Error('SPEECH_OWNED_DOWNLOAD_HTTPS_DOWNGRADE')
    if (!isImmutableUrl(next.href)) throw new Error('SPEECH_OWNED_DOWNLOAD_MUTABLE_REDIRECT')
    current = next.href
  }
  throw new Error('SPEECH_OWNED_DOWNLOAD_REDIRECT_LIMIT')
}

function abortKind(signal: AbortSignal, pauseSignal: AbortSignal, external?: AbortSignal): 'cancel' | 'pause' | null {
  if (signal.aborted || external?.aborted) return 'cancel'
  if (pauseSignal.aborted) return 'pause'
  return null
}

function sleep(
  ms: number,
  signal: AbortSignal,
  pauseSignal: AbortSignal,
  external: AbortSignal
): Promise<'done' | 'cancel' | 'pause'> {
  return new Promise((resolve) => {
    if (signal.aborted || external.aborted) return resolve('cancel')
    if (pauseSignal.aborted) return resolve('pause')
    const timer = setTimeout(() => {
      clean()
      resolve('done')
    }, ms)
    const cancel = () => {
      clean()
      resolve('cancel')
    }
    const pause = () => {
      clean()
      resolve('pause')
    }
    const clean = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', cancel)
      external.removeEventListener('abort', cancel)
      pauseSignal.removeEventListener('abort', pause)
    }
    signal.addEventListener('abort', cancel, { once: true })
    external.addEventListener('abort', cancel, { once: true })
    pauseSignal.addEventListener('abort', pause, { once: true })
  })
}

async function performOwnedDownload(
  input: {
    readonly download: SpeechOwnedDownload
    readonly signal: AbortSignal
    readonly pauseSignal: AbortSignal
    readonly onProgress: (bytes: number) => void
  },
  network: OwnedDownloadNetworkDeps
): Promise<SpeechOwnedDownloadOutcome> {
  const entry = entryFor(input.download)
  const { timing } = network
  if (
    !Number.isSafeInteger(timing.requestTimeoutMs) ||
    timing.requestTimeoutMs < 1 ||
    timing.requestTimeoutMs > 60_000 ||
    !Number.isSafeInteger(timing.idleTimeoutMs) ||
    timing.idleTimeoutMs < 1 ||
    timing.idleTimeoutMs > 120_000 ||
    !Number.isSafeInteger(timing.maxAttempts) ||
    timing.maxAttempts < 1 ||
    timing.maxAttempts > Math.min(5, entry.bounds.maximumRequests) ||
    !Number.isSafeInteger(timing.backoffBaseMs) ||
    timing.backoffBaseMs < 0 ||
    timing.backoffBaseMs > 30_000 ||
    !Number.isSafeInteger(timing.backoffCapMs) ||
    timing.backoffCapMs < 0 ||
    timing.backoffCapMs > 30_000 ||
    !Number.isSafeInteger(timing.retryAfterCapMs) ||
    timing.retryAfterCapMs < 0 ||
    timing.retryAfterCapMs > 300_000
  )
    throw new Error('SPEECH_OWNED_DOWNLOAD_TIMING_INVALID')
  if (entry.running) throw new Error('SPEECH_OWNED_DOWNLOAD_ALREADY_RUNNING')
  if (entry.verified) return { status: 'verified', verified: entry.verified }
  if (entry.suspended) throw new Error('SPEECH_OWNED_DOWNLOAD_REQUIRES_RESUME')
  entry.running = true
  const externalAbort = new AbortController()
  entry.externalAbort = externalAbort
  let networkSettled = true
  try {
    for (;;) {
      const stop = abortKind(input.signal, input.pauseSignal, externalAbort.signal)
      if (stop === 'cancel') {
        const pending = discardRuntimeOwnedTransfer(entry.target, entry.cleanup)
        const cleanup = await pending.settled
        return { status: 'cancelled', cleanup }
      }
      if (stop === 'pause') {
        const suspended = await suspendRuntimeOwnedTransfer(entry.target, entry.attempt)
        entry.suspended = suspended
        return { status: 'paused', suspended }
      }
      entry.admission.assertCurrent()
      const current = runtimeOwnedTransferProgress(entry.target)
      if (current.state !== 'active') throw new Error('SPEECH_OWNED_DOWNLOAD_ATTEMPT_INACTIVE')
      if (current.bytes > 0 && !current.validator) {
        entry.attempt = await restartRuntimeOwnedTransfer(entry.target, entry.attempt)
        continue
      }
      const headers: Record<string, string> = {}
      if (current.bytes > 0 && current.validator) {
        headers.Range = `bytes=${current.bytes}-`
        headers['If-Range'] = current.validator
      }
      const controller = new AbortController()
      const abort = () => {
        try {
          stopRuntimeOwnedTransfer(entry.target, entry.attempt)
        } catch {
          /* already terminal */
        }
        controller.abort()
      }
      entry.abortRun = abort
      input.signal.addEventListener('abort', abort, { once: true })
      input.pauseSignal.addEventListener('abort', abort, { once: true })
      externalAbort.signal.addEventListener('abort', abort, { once: true })
      const timer = setTimeout(() => controller.abort(), network.timing.requestTimeoutMs)
      let response: Response | null = null
      let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
      let bodyDone = false
      let bodyErrored = false
      try {
        response = await request(
          entry.url,
          headers,
          controller.signal,
          network,
          () => entry.admission.assertCurrent(),
          () => {
            if (entry.requests >= entry.bounds.maximumRequests) throw new Error('SPEECH_OWNED_DOWNLOAD_REQUEST_LIMIT')
            entry.requests++
          }
        )
        networkSettled = false
        const interruptedAfterResponse = abortKind(input.signal, input.pauseSignal, externalAbort.signal)
        if (interruptedAfterResponse) {
          await response.body?.cancel()
          bodyDone = true
          networkSettled = true
          throw Object.assign(new Error('SPEECH_OWNED_DOWNLOAD_INTERRUPTED'), { interrupted: interruptedAfterResponse })
        }
        const offset = current.bytes
        const freshValidator = validatorOf(response.headers)
        if (response.status === 416) {
          await response.body?.cancel()
          bodyDone = true
          networkSettled = true
          entry.attempt = await restartRuntimeOwnedTransfer(entry.target, entry.attempt)
          entry.transientAttempts++
          continue
        }
        if (response.status === 429 || response.status >= 500)
          throw Object.assign(new Error('SPEECH_OWNED_DOWNLOAD_TRANSIENT_HTTP'), {
            retryAfter: retryAfter(response.headers, network.timing.retryAfterCapMs)
          })
        if (isHtml(response.headers)) throw new Error('SPEECH_OWNED_DOWNLOAD_CAPTIVE_HTML')
        if (response.status !== 200 && response.status !== 206)
          throw new Error(`SPEECH_OWNED_DOWNLOAD_HTTP_${response.status}`)
        let rangeBytes = entry.file.bytes
        if (response.status === 206) {
          const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') ?? '')
          const start = range ? Number(range[1]) : -1,
            end = range ? Number(range[2]) : -1,
            total = range ? Number(range[3]) : -1
          rangeBytes = end - start + 1
          const contentLength = response.headers.get('content-length')
          if (
            offset <= 0 ||
            !current.validator ||
            freshValidator !== current.validator ||
            start !== offset ||
            end < start ||
            end >= entry.file.bytes ||
            total !== entry.file.bytes ||
            !Number.isSafeInteger(start) ||
            !Number.isSafeInteger(end) ||
            !Number.isSafeInteger(total) ||
            !Number.isSafeInteger(rangeBytes) ||
            (contentLength !== null && decimal(contentLength) !== rangeBytes)
          ) {
            await response.body?.cancel()
            bodyDone = true
            networkSettled = true
            entry.attempt = await restartRuntimeOwnedTransfer(entry.target, entry.attempt)
            entry.transientAttempts++
            continue
          }
        } else if (offset > 0) {
          await response.body?.cancel()
          bodyDone = true
          networkSettled = true
          entry.attempt = await restartRuntimeOwnedTransfer(entry.target, entry.attempt)
          entry.transientAttempts++
          continue
        }
        const declaredLengthWrong =
          response.status === 200 &&
          response.headers.get('content-length') !== null &&
          decimal(response.headers.get('content-length')) !== entry.file.bytes
        if (!response.body) throw new Error('SPEECH_OWNED_DOWNLOAD_BODY_MISSING')
        setRuntimeOwnedTransferValidator(entry.target, entry.attempt, freshValidator)
        reader = response.body.getReader()
        let received = 0
        let transportReceived = 0
        const sniffed = Buffer.alloc(Math.min(512, entry.file.bytes))
        let sniffUsed = 0
        let sniffing = true
        let idleDeadline = performance.now() + network.timing.idleTimeoutMs
        const appendChunk = async (chunk: Uint8Array): Promise<void> => {
          entry.admission.assertCurrent()
          await appendRuntimeOwnedTransfer(entry.target, entry.attempt, chunk)
          received += chunk.byteLength
          input.onProgress(offset + received)
        }
        for (;;) {
          entry.admission.assertCurrent()
          const idleTimer = setTimeout(() => controller.abort(), Math.max(0, idleDeadline - performance.now()))
          let readResult: Awaited<ReturnType<typeof reader.read>>
          try {
            readResult = await reader.read()
          } catch (error) {
            bodyErrored = true
            networkSettled = true
            throw error
          } finally {
            clearTimeout(idleTimer)
          }
          const interrupted = abortKind(input.signal, input.pauseSignal, externalAbort.signal)
          if (interrupted) throw Object.assign(new Error('SPEECH_OWNED_DOWNLOAD_INTERRUPTED'), { interrupted })
          entry.admission.assertCurrent()
          if (readResult.done) {
            bodyDone = true
            networkSettled = true
            reader.releaseLock()
            reader = null
            break
          }
          const chunk = readResult.value
          if (!chunk.byteLength) continue
          if (chunk.byteLength > entry.bounds.maximumChunkBytes) throw new Error('SPEECH_OWNED_DOWNLOAD_CHUNK_LIMIT')
          if (
            chunk.byteLength > entry.file.bytes - (offset + transportReceived) ||
            chunk.byteLength > rangeBytes - transportReceived
          )
            throw new Error('SPEECH_OWNED_DOWNLOAD_EXCESS_BYTES')
          transportReceived += chunk.byteLength
          idleDeadline = performance.now() + network.timing.idleTimeoutMs
          if (sniffing) {
            const take = Math.min(chunk.byteLength, sniffed.byteLength - sniffUsed)
            sniffed.set(chunk.subarray(0, take), sniffUsed)
            sniffUsed += take
            if (sniffUsed < sniffed.byteLength) continue
            if (htmlPrefix(sniffed)) throw new Error('SPEECH_OWNED_DOWNLOAD_CAPTIVE_PREFIX')
            if (declaredLengthWrong) throw new Error('SPEECH_OWNED_DOWNLOAD_DECLARED_LENGTH_MISMATCH')
            sniffing = false
            await appendChunk(sniffed)
            if (take < chunk.byteLength) await appendChunk(chunk.subarray(take))
          } else await appendChunk(chunk)
        }
        if (sniffing) {
          const prefix = sniffed.subarray(0, sniffUsed)
          if (htmlPrefix(prefix)) throw new Error('SPEECH_OWNED_DOWNLOAD_CAPTIVE_PREFIX')
          if (declaredLengthWrong) throw new Error('SPEECH_OWNED_DOWNLOAD_DECLARED_LENGTH_MISMATCH')
          if (prefix.byteLength) await appendChunk(prefix)
        }
        if (received !== rangeBytes || offset + received < entry.file.bytes)
          throw Object.assign(new Error('SPEECH_OWNED_DOWNLOAD_SHORT_BODY'), { retryAfter: 0 })
        entry.verified = await finishRuntimeOwnedTransfer(entry.target, entry.attempt)
        input.onProgress(entry.file.bytes)
        return { status: 'verified', verified: entry.verified }
      } catch (error) {
        if (reader) {
          if (!bodyDone && !bodyErrored) await reader.cancel()
          reader.releaseLock()
          reader = null
          bodyDone = true
          networkSettled = true
        } else if (response?.body && !bodyDone) {
          await response.body.cancel()
          bodyDone = true
          networkSettled = true
        }
        const interruption =
          (error as { interrupted?: string }).interrupted ??
          abortKind(input.signal, input.pauseSignal, externalAbort.signal)
        if (interruption === 'cancel') {
          const pending = discardRuntimeOwnedTransfer(entry.target, entry.cleanup)
          return { status: 'cancelled', cleanup: await pending.settled }
        }
        if (interruption === 'pause') {
          const suspended = await suspendRuntimeOwnedTransfer(entry.target, entry.attempt)
          entry.suspended = suspended
          return { status: 'paused', suspended }
        }
        if (
          error instanceof Error &&
          error.message === 'RUNTIME_TRANSFER_DIGEST_MISMATCH' &&
          ++entry.digestFailures > 1
        )
          throw error
        if (error instanceof Error && error.message === 'RUNTIME_TRANSFER_DIGEST_MISMATCH') {
          entry.attempt = await restartRuntimeOwnedTransfer(entry.target, entry.attempt)
          continue
        }
        const retryable =
          (error as { retryAfter?: number }).retryAfter !== undefined ||
          (error instanceof Error &&
            (error.name === 'AbortError' ||
              error.name === 'TypeError' ||
              error.message === 'SPEECH_OWNED_DOWNLOAD_SHORT_BODY'))
        if (!retryable) throw error
        if (++entry.transientAttempts >= network.timing.maxAttempts)
          throw new Error('SPEECH_OWNED_DOWNLOAD_NETWORK_RETRY_EXHAUSTED', { cause: error })
        const random = network.random()
        if (!Number.isFinite(random) || random < 0 || random > 1)
          throw new Error('SPEECH_OWNED_DOWNLOAD_RANDOM_INVALID')
        const retry = Math.max(
          Math.min(network.timing.backoffCapMs, network.timing.backoffBaseMs * 2 ** (entry.transientAttempts - 1)) *
            (0.5 + random / 2),
          Math.min(Number((error as { retryAfter?: number }).retryAfter ?? 0), network.timing.retryAfterCapMs)
        )
        const result = await sleep(retry, input.signal, input.pauseSignal, externalAbort.signal)
        if (result === 'cancel' || result === 'pause') continue
      } finally {
        clearTimeout(timer)
        input.signal.removeEventListener('abort', abort)
        input.pauseSignal.removeEventListener('abort', abort)
        externalAbort.signal.removeEventListener('abort', abort)
        if (entry.abortRun === abort) entry.abortRun = null
        controller.abort()
        if (response?.body && !bodyDone && !reader) {
          await response.body.cancel()
          networkSettled = true
        }
        reader?.releaseLock()
      }
    }
  } catch (error) {
    if (networkSettled && !(error as { networkUnsettled?: boolean }).networkUnsettled)
      await discardRuntimeOwnedTransfer(entry.target, entry.cleanup).settled
    else entry.networkUnsettled = true
    throw ownedFailure(error)
  } finally {
    entry.running = false
    if (entry.externalAbort === externalAbort) entry.externalAbort = null
  }
}

export function downloadVerifiedOwned(
  input: {
    readonly download: SpeechOwnedDownload
    readonly signal: AbortSignal
    readonly pauseSignal: AbortSignal
    readonly onProgress: (bytes: number) => void
  },
  network: OwnedDownloadNetworkDeps
): Promise<SpeechOwnedDownloadOutcome> {
  const entry = entryFor(input.download)
  if (entry.run) throw new Error('SPEECH_OWNED_DOWNLOAD_ALREADY_RUNNING')
  const run = performOwnedDownload(input, network)
  const settled = run.finally(() => {
    if (entry.run === settled) entry.run = null
  })
  entry.run = settled
  return settled
}

export async function resumeSpeechOwnedDownload(input: {
  readonly download: SpeechOwnedDownload
  readonly suspended: RuntimeOwnedTransferSuspension
  readonly admission: CurrentSpeechPackInstallAdmission
}): Promise<void> {
  const entry = entryFor(input.download)
  if (entry.run) await entry.run
  if (
    !entry.suspended ||
    entry.suspended !== input.suspended ||
    entry.transaction !== input.admission.transaction ||
    input.admission.componentId !== entry.component.id ||
    input.admission.manifestIdentity !== componentManifestIdentity(entry.component) ||
    input.admission.resourcePolicyIdentity !== entry.admission.resourcePolicyIdentity
  )
    throw new Error('SPEECH_OWNED_DOWNLOAD_HANDOVER_INVALID')
  input.admission.assertCurrent()
  await assertCurrentSpeechPackInstallAdmission(input.admission)
  input.admission.assertCurrent()
  entry.attempt = await resumeRuntimeOwnedTransfer(entry.target, input.suspended, actionFor(input.admission))
  entry.admission = input.admission
  entry.suspended = null
}

export function discardSpeechOwnedDownload(download: SpeechOwnedDownload): RuntimeOwnedTransferPendingCleanup {
  const entry = entryFor(download)
  if (entry.networkUnsettled)
    return Object.freeze({
      status: 'pending-cleanup',
      settled: new Promise<RuntimeOwnedTransferCleanupOutcome>(() => undefined)
    })
  if (!entry.run) return discardRuntimeOwnedTransfer(entry.target, entry.cleanup)
  entry.externalAbort?.abort()
  entry.abortRun?.()
  const settled = entry.run.then(
    () => discardRuntimeOwnedTransfer(entry.target, entry.cleanup).settled,
    () => discardRuntimeOwnedTransfer(entry.target, entry.cleanup).settled
  )
  return Object.freeze({ status: 'pending-cleanup', settled })
}
