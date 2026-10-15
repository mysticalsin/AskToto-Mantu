import { createHash } from 'node:crypto'
import { sep } from 'node:path'
import type { BigIntStats } from 'node:fs'
import { opendir } from 'node:fs/promises'
import { identityRecord, type RuntimeOwnedTreeEntry, type RuntimeOwnedTreeFileSink } from './runtime-owned-tree-record'
import type { RuntimeExclusiveFileCreation } from './runtime-owned-files'
import type { RuntimePhysicalSnapshotInput } from './runtime-owned-files'
import type { RuntimeExclusiveFileSink } from './runtime-exclusive-file-sink'
import { sameRuntimeFileVersion } from './runtime-file-version'
import {
  admitTerminal,
  assertStable,
  clearExpiry,
  deadlineExpired,
  startExpiry,
  trackTerminal,
  type RuntimeOwnedTransferAction,
  type RuntimeOwnedTransferAttempt,
  type RuntimeOwnedTransferBounds,
  type RuntimeOwnedTransferCleanup,
  type RuntimeOwnedTransferCleanupOutcome,
  type RuntimeOwnedTransferFile,
  type RuntimeOwnedTransferPendingCleanup,
  type RuntimeOwnedTransferProgress,
  type RuntimeOwnedTransferStart,
  type RuntimeOwnedTransferSuspension,
  type RuntimeOwnedTransferTarget,
  type RuntimeOwnedTransferTreeHost,
  type RuntimeOwnedTransferVerified,
  type AttemptEntry,
  type SuspensionEntry,
  type TargetEntry
} from './runtime-owned-transfer-lifecycle'
import { consumeRuntimePayloadFilePin, type RuntimePayloadFilePin } from './runtime-payload-plan'

export type {
  RuntimeOwnedTransferAction,
  RuntimeOwnedTransferAttempt,
  RuntimeOwnedTransferBounds,
  RuntimeOwnedTransferCleanup,
  RuntimeOwnedTransferCleanupOutcome,
  RuntimeOwnedTransferFile,
  RuntimeOwnedTransferPendingCleanup,
  RuntimeOwnedTransferProgress,
  RuntimeOwnedTransferStart,
  RuntimeOwnedTransferSuspension,
  RuntimeOwnedTransferTarget,
  RuntimeOwnedTransferTreeHost,
  RuntimeOwnedTransferVerified
} from './runtime-owned-transfer-lifecycle'

const targets = new WeakMap<object, TargetEntry>()
const attempts = new WeakMap<object, AttemptEntry>()
const suspensions = new WeakMap<object, SuspensionEntry>()
const cleanups = new WeakMap<object, TargetEntry>()
const verifications = new WeakMap<object, TargetEntry>()

export function sameRuntimeOwnedTreeFileVersion(expected: BigIntStats, actual: BigIntStats): boolean {
  return (
    expected.isFile() &&
    actual.isFile() &&
    !actual.isSymbolicLink() &&
    expected.dev === actual.dev &&
    expected.ino === actual.ino &&
    expected.mode === actual.mode &&
    expected.nlink === actual.nlink &&
    expected.uid === actual.uid &&
    expected.gid === actual.gid &&
    expected.rdev === actual.rdev &&
    expected.size === actual.size &&
    expected.blocks === actual.blocks &&
    expected.mtimeNs === actual.mtimeNs &&
    expected.birthtimeNs === actual.birthtimeNs
  )
}

export function sameRuntimeOwnedTreeDirectoryVersion(expected: BigIntStats, actual: BigIntStats): boolean {
  return (
    expected.isDirectory() &&
    actual.isDirectory() &&
    !actual.isSymbolicLink() &&
    expected.dev === actual.dev &&
    expected.ino === actual.ino &&
    expected.birthtimeNs === actual.birthtimeNs
  )
}

export async function readRuntimeOwnedTreeDirectoryNames(path: string, maximum: number): Promise<string[]> {
  const handle = await opendir(path, { bufferSize: 1 })
  const names: string[] = []
  try {
    for (;;) {
      const entry = await handle.read()
      if (!entry) return names
      if (names.length >= maximum) throw new Error('RUNTIME_TREE_LIMIT')
      names.push(entry.name)
    }
  } finally {
    await handle.close()
  }
}

export interface RuntimeOwnedTreeTransferSnapshotState {
  snapshot: RuntimePhysicalSnapshotInput
  readonly directories: Map<string, { readonly path: string; version: BigIntStats; children: string[] }>
  readonly files: Map<string, { readonly path: string; version: BigIntStats | null }>
}

export function replaceSnapshotPath(
  snapshot: RuntimePhysicalSnapshotInput,
  path: string,
  version: BigIntStats
): RuntimePhysicalSnapshotInput {
  return {
    ...snapshot,
    nodes: snapshot.nodes.map((node) => (node.path === path ? { path, version } : node)),
    directories: snapshot.directories.map((directory) =>
      directory.path === path ? { ...directory, version } : directory
    )
  }
}

export function updateDirectory(
  state: RuntimeOwnedTreeTransferSnapshotState,
  path: string,
  version: BigIntStats,
  children: readonly string[]
): void {
  const previous = state.directories.get(path)
  if (previous) {
    previous.version = version
    previous.children = [...children]
  }
  state.snapshot = replaceSnapshotPath(state.snapshot, path, version)
  state.snapshot = {
    ...state.snapshot,
    directories: state.snapshot.directories.map((directory) =>
      directory.path === path ? { ...directory, version, children: [...children] } : directory
    )
  }
}

export function removeTrackedNode(state: RuntimeOwnedTreeTransferSnapshotState, path: string): void {
  state.snapshot = {
    ...state.snapshot,
    roots: state.snapshot.roots.filter((root) => root.path !== path),
    nodes: state.snapshot.nodes.filter((node) => node.path !== path),
    directories: state.snapshot.directories.filter((directory) => directory.path !== path)
  }
}

export function replaceTrackedNode(
  state: RuntimeOwnedTreeTransferSnapshotState,
  source: string,
  destination: string,
  version: BigIntStats
): void {
  const nodes = state.snapshot.nodes.filter((node) => node.path !== source && node.path !== destination)
  nodes.push({ path: destination, version })
  state.snapshot = { ...state.snapshot, roots: state.snapshot.roots.filter((root) => root.path !== destination), nodes }
}

export function trackedSnapshot(state: RuntimeOwnedTreeTransferSnapshotState): RuntimePhysicalSnapshotInput {
  const nodes = [...state.snapshot.nodes],
    directories = [...state.snapshot.directories]
  for (const directory of state.directories.values()) {
    const nodeIndex = nodes.findIndex((node) => node.path === directory.path)
    if (nodeIndex < 0) nodes.push({ path: directory.path, version: directory.version })
    else nodes[nodeIndex] = { path: directory.path, version: directory.version }
    const directoryIndex = directories.findIndex((value) => value.path === directory.path)
    const value = { path: directory.path, version: directory.version, children: [...directory.children] }
    if (directoryIndex < 0) directories.push(value)
    else directories[directoryIndex] = value
  }
  for (const file of state.files.values()) {
    if (!file.version) continue
    const index = nodes.findIndex((node) => node.path === file.path),
      value = { path: file.path, version: file.version }
    if (index < 0) nodes.push(value)
    else nodes[index] = value
  }
  return { ...state.snapshot, nodes, directories }
}

export function wrapRuntimeOwnedTreeFileSink(input: {
  readonly rootPath: string
  readonly file: {
    readonly path: string
    readonly expectedByteLength: number
    readonly expectedSha256: string
    version: BigIntStats | null
    sink: RuntimeExclusiveFileSink | null
    sha256: string | null
  }
  readonly creation: RuntimeExclusiveFileCreation
  readonly accepting: () => boolean
  readonly assertCurrentSync: () => void
  readonly track: <T>(operation: Promise<T>) => Promise<T>
  readonly onClose: (sink: RuntimeOwnedTreeFileSink) => void
}): RuntimeOwnedTreeFileSink {
  const hash = createHash('sha256')
  let closePromise: Promise<
    Extract<RuntimeOwnedTreeEntry, { readonly kind: 'file' }> & { readonly byteLength: number }
  > | null = null
  let wrapped: RuntimeOwnedTreeFileSink
  wrapped = Object.freeze({
    write(chunk: Uint8Array): Promise<void> {
      if (!input.accepting()) return Promise.reject(new Error('RUNTIME_TREE_WRITER_CLOSED'))
      if (chunk.byteLength > 1024 * 1024) return Promise.reject(new Error('RUNTIME_EXCLUSIVE_FILE_LIMIT'))
      const ownedChunk = Buffer.from(chunk)
      return input.track(
        input.creation.sink.writeOwned(ownedChunk, input.assertCurrentSync).then(() => {
          hash.update(ownedChunk)
        })
      )
    },
    sync(): Promise<void> {
      if (!input.accepting()) return Promise.reject(new Error('RUNTIME_TREE_WRITER_CLOSED'))
      return input.track(input.creation.sink.syncOwned(input.assertCurrentSync))
    },
    close(): Promise<Extract<RuntimeOwnedTreeEntry, { readonly kind: 'file' }> & { readonly byteLength: number }> {
      if (closePromise) return closePromise
      closePromise = input.track(
        (async () => {
          const receipt = await input.creation.sink.close()
          input.onClose(wrapped)
          if (receipt.status !== 'created') throw new Error('RUNTIME_TREE_FILE_UNCONFIRMED')
          input.file.version = receipt.version
          input.file.sink = null
          const sha256 = hash.digest('hex')
          input.file.sha256 = sha256
          const byteLength = Number(receipt.version.size)
          if (!Number.isSafeInteger(byteLength)) throw new Error('RUNTIME_TREE_FILE_SIZE_INVALID')
          if (byteLength !== input.file.expectedByteLength) throw new Error('RUNTIME_TREE_FILE_SIZE_MISMATCH')
          if (sha256 !== input.file.expectedSha256) throw new Error('RUNTIME_TREE_FILE_DIGEST_MISMATCH')
          return Object.freeze({
            path: receipt.path
              .slice(input.rootPath.length + 1)
              .split(sep)
              .join('/'),
            kind: 'file',
            identity: identityRecord(receipt.version),
            sha256,
            byteLength
          })
        })()
      )
      return closePromise
    }
  })
  return wrapped
}

function validateBounds(bounds: RuntimeOwnedTransferBounds): void {
  if (
    !Number.isSafeInteger(bounds.maximumChunkBytes) ||
    bounds.maximumChunkBytes < 1 ||
    bounds.maximumChunkBytes > 1024 * 1024 ||
    !Number.isSafeInteger(bounds.maximumRequests) ||
    bounds.maximumRequests < 1 ||
    bounds.maximumRequests > 32 ||
    !Number.isSafeInteger(bounds.maximumRestarts) ||
    bounds.maximumRestarts < 1 ||
    bounds.maximumRestarts > 8 ||
    !Number.isSafeInteger(bounds.maximumHandovers) ||
    bounds.maximumHandovers < 0 ||
    bounds.maximumHandovers > 4 ||
    !Number.isSafeInteger(bounds.pausedRetentionMs) ||
    bounds.pausedRetentionMs < 1 ||
    bounds.pausedRetentionMs > 300_000
  )
    throw new Error('RUNTIME_TRANSFER_BOUNDS_INVALID')
}

function token<T extends object>(): T {
  return Object.freeze(Object.create(null)) as T
}
function checkAttempt(target: RuntimeOwnedTransferTarget, attempt: RuntimeOwnedTransferAttempt): TargetEntry {
  const state = targets.get(target as object)
  const entry = attempts.get(attempt as object)
  if (!state || !entry || entry.target !== state || state.attempt !== attempt || !entry.active)
    throw new Error('RUNTIME_TRANSFER_ATTEMPT_INVALID')
  if (state.state !== 'active') throw new Error('RUNTIME_TRANSFER_NOT_ACTIVE')
  assertStable(state)
  try {
    state.action.assertCurrentSync()
  } catch (error) {
    state.state = 'quiescing'
    throw error
  }
  return state
}

function terminalEntry(target: RuntimeOwnedTransferTarget, attempt: RuntimeOwnedTransferAttempt): TargetEntry {
  return admitTerminal(targets.get(target as object), attempts.get(attempt as object), attempt)
}

function writeFence(state: TargetEntry, attempt: RuntimeOwnedTransferAttempt): () => void {
  return () => {
    const issued = attempts.get(attempt as object)
    if (state.state === 'quiescing' && issued?.target === state && issued.active && state.attempt === attempt) {
      throw new Error('RUNTIME_TRANSFER_QUIESCING')
    }
    if (
      !issued ||
      issued.target !== state ||
      !issued.active ||
      state.attempt !== attempt ||
      state.state !== 'active' ||
      state.closing
    ) {
      throw new Error('RUNTIME_TRANSFER_ATTEMPT_INVALID')
    }
    assertStable(state)
    try {
      state.action.assertCurrentSync()
    } catch (error) {
      state.state = 'quiescing'
      throw error
    }
  }
}

export async function beginRuntimeOwnedTransferWithHost(input: {
  readonly host: RuntimeOwnedTransferTreeHost
  readonly pin: RuntimePayloadFilePin
  readonly action: RuntimeOwnedTransferAction
  readonly bounds: RuntimeOwnedTransferBounds
  readonly assertCleanupCurrentSync: () => void
}): Promise<RuntimeOwnedTransferStart> {
  const host = input.host
  validateBounds(input.bounds)
  input.action.assertCurrentSync()
  host.assertStableCurrentSync()
  host.reserve()
  let claims: ReturnType<typeof consumeRuntimePayloadFilePin>
  try {
    claims = consumeRuntimePayloadFilePin(host.plan, input.pin)
  } catch (error) {
    host.transferFinished('closed')
    throw error
  }
  const target = token<RuntimeOwnedTransferTarget>()
  const cleanup = token<RuntimeOwnedTransferCleanup>()
  const attempt = token<RuntimeOwnedTransferAttempt>()
  const state: TargetEntry = {
    host,
    bounds: Object.freeze({ ...input.bounds }),
    claim: claims,
    transaction: input.action.transaction,
    cleanupCheck: input.assertCleanupCurrentSync,
    cleanup,
    file: null,
    action: input.action,
    attempt,
    generation: 0,
    bytes: 0,
    validator: null,
    state: 'active',
    inflight: null,
    closePromise: null,
    verified: null,
    handovers: 0,
    restarts: 0,
    operation: null,
    closing: false,
    scopeRetired: false,
    retiredActions: new Set(),
    expiryTimer: null
  }
  targets.set(target as object, state)
  attempts.set(attempt as object, { target: state, generation: 0, active: true })
  cleanups.set(cleanup as object, state)
  host.registerTarget(async () => {
    stopRuntimeOwnedTransfer(target, state.attempt)
    await discardRuntimeOwnedTransfer(target, cleanup).settled
  })
  try {
    const creation = host.create(claims, input.action)
    host.retainUntilSettled(creation)
    state.file = await creation
    state.bytes = state.file.byteLength
    if (!state.file.confirmed) throw new Error('RUNTIME_TRANSFER_OWNER_UNCONFIRMED')
    input.action.assertCurrentSync()
    return Object.freeze({ target, attempt, cleanup })
  } catch (error) {
    if (state.file) {
      try {
        if (await host.close(state.file)) {
          input.assertCleanupCurrentSync()
          await host.remove(state.file, input.assertCleanupCurrentSync)
        }
      } catch {
        /* retain the authenticated file record for writer disposal and diagnosis */
      }
    }
    state.state = 'frozen'
    if (!state.file) host.transferFinished('closed')
    throw error
  }
}

export function runtimeOwnedTransferProgress(target: RuntimeOwnedTransferTarget): RuntimeOwnedTransferProgress {
  const state = targets.get(target as object)
  if (!state) throw new Error('RUNTIME_TRANSFER_TARGET_INVALID')
  return Object.freeze({
    bytes: state.bytes,
    expectedBytes: state.claim.byteLength,
    expectedSha256: state.claim.sha256,
    validator: state.validator,
    state: state.state
  })
}

export function appendRuntimeOwnedTransfer(
  target: RuntimeOwnedTransferTarget,
  attempt: RuntimeOwnedTransferAttempt,
  chunk: Uint8Array
): Promise<void> {
  const state = checkAttempt(target, attempt)
  if (chunk.byteLength > state.bounds.maximumChunkBytes)
    return Promise.reject(new Error('RUNTIME_TRANSFER_CHUNK_LIMIT'))
  if (state.inflight) return Promise.reject(new Error('RUNTIME_TRANSFER_APPEND_IN_PROGRESS'))
  if (!state.file || state.bytes + chunk.byteLength > state.claim.byteLength)
    return Promise.reject(new Error('RUNTIME_TRANSFER_SIZE_LIMIT'))
  const startingBytes = state.bytes
  const admittedLength = chunk.byteLength
  const assertWriteCurrent = writeFence(state, attempt)
  const operation = (async () => {
    try {
      assertWriteCurrent()
      const acknowledged = await state.file!.sink.writeOwned(chunk, assertWriteCurrent)
      if (acknowledged.byteLength !== startingBytes + admittedLength)
        throw new Error('RUNTIME_TRANSFER_ACKNOWLEDGED_OFFSET_MISMATCH')
      assertWriteCurrent()
      state.bytes = acknowledged.byteLength
    } catch (error) {
      try {
        const custody = await state.file!.sink.checkpointOwned(
          () => assertStable(state),
          Math.min(64 * 1024, state.bounds.maximumChunkBytes)
        )
        state.bytes = custody.byteLength
      } catch {
        state.state = 'frozen'
      }
      throw error
    }
  })()
  state.inflight = operation
  state.host.retainUntilSettled(operation)
  void operation
    .finally(() => {
      if (state.inflight === operation) state.inflight = null
    })
    .catch(() => undefined)
  return operation
}

export function setRuntimeOwnedTransferValidator(
  target: RuntimeOwnedTransferTarget,
  attempt: RuntimeOwnedTransferAttempt,
  validator: string | null
): void {
  const state = checkAttempt(target, attempt)
  if (validator !== null && (validator.length === 0 || validator.length > 1024))
    throw new Error('RUNTIME_TRANSFER_VALIDATOR_INVALID')
  state.validator = validator
}

export function stopRuntimeOwnedTransfer(
  target: RuntimeOwnedTransferTarget,
  attempt: RuntimeOwnedTransferAttempt
): void {
  const state = targets.get(target as object),
    entry = attempts.get(attempt as object)
  if (!state || !entry || entry.target !== state || state.attempt !== attempt || !entry.active)
    throw new Error('RUNTIME_TRANSFER_ATTEMPT_INVALID')
  if (state.state === 'active') state.state = 'quiescing'
}

export function restartRuntimeOwnedTransfer(
  target: RuntimeOwnedTransferTarget,
  attempt: RuntimeOwnedTransferAttempt
): Promise<RuntimeOwnedTransferAttempt> {
  const state = terminalEntry(target, attempt)
  const operation = (async () => {
    try {
      if (state.inflight) await state.inflight.catch(() => undefined)
      if (state.restarts >= state.bounds.maximumRestarts) throw new Error('RUNTIME_TRANSFER_RESTART_LIMIT')
      const current = state.file
      if (!current) throw new Error('RUNTIME_TRANSFER_OWNER_MISSING')
      const fence = (): void => {
        if (state.closing) throw new Error('RUNTIME_TRANSFER_QUIESCING')
        assertStable(state)
        state.action.assertCurrentSync()
      }
      fence()
      const custody = await current.sink.checkpointOwned(
        () => assertStable(state),
        Math.min(64 * 1024, state.bounds.maximumChunkBytes)
      )
      if (custody.byteLength !== state.bytes) throw new Error('RUNTIME_TRANSFER_PREFIX_CHANGED')
      fence()
      if (!(await state.host.close(current))) throw new Error('RUNTIME_TRANSFER_OWNER_UNCONFIRMED')
      fence()
      const removeFence = (): void => {
        fence()
        state.cleanupCheck()
      }
      if (!(await state.host.remove(current, removeFence))) throw new Error('RUNTIME_TRANSFER_CLEANUP_UNCONFIRMED')
      fence()
      state.file = await state.host.create(state.claim, state.action)
      if (!state.file.confirmed) throw new Error('RUNTIME_TRANSFER_OWNER_UNCONFIRMED')
      fence()
      state.bytes = 0
      state.validator = null
      state.restarts++
      return issueAttempt(state)
    } catch (error) {
      state.state = 'frozen'
      throw error
    }
  })()
  return trackTerminal(state, operation)
}

function issueAttempt(state: TargetEntry): RuntimeOwnedTransferAttempt {
  const old = attempts.get(state.attempt as object)
  if (old) old.active = false
  state.generation++
  const attempt = token<RuntimeOwnedTransferAttempt>()
  state.attempt = attempt
  attempts.set(attempt as object, { target: state, generation: state.generation, active: true })
  state.state = 'active'
  return attempt
}

export function suspendRuntimeOwnedTransfer(
  target: RuntimeOwnedTransferTarget,
  attempt: RuntimeOwnedTransferAttempt
): Promise<RuntimeOwnedTransferSuspension> {
  const state = terminalEntry(target, attempt)
  const operation = (async () => {
    try {
      if (state.inflight) await state.inflight.catch(() => undefined)
      if (!state.file) throw new Error('RUNTIME_TRANSFER_OWNER_MISSING')
      const checkpoint = await state.file.sink.checkpointOwned(
        () => assertStable(state),
        Math.min(64 * 1024, state.bounds.maximumChunkBytes)
      )
      if (checkpoint.byteLength !== state.bytes) throw new Error('RUNTIME_TRANSFER_PREFIX_CHANGED')
      assertStable(state)
      attempts.get(attempt as object)!.active = false
      state.retiredActions.add(state.action.identity)
      state.state = 'paused'
      const suspended = token<RuntimeOwnedTransferSuspension>()
      const expiresAt = startExpiry(state, () => {
        void discardRuntimeOwnedTransfer(target, state.cleanup).settled.catch(() => undefined)
      })
      suspensions.set(suspended as object, {
        target: state,
        generation: state.generation,
        used: false,
        expiresAt,
        checkpoint
      })
      return suspended
    } catch (error) {
      state.state = 'frozen'
      throw error
    }
  })()
  return trackTerminal(state, operation)
}

export async function resumeRuntimeOwnedTransfer(
  target: RuntimeOwnedTransferTarget,
  suspended: RuntimeOwnedTransferSuspension,
  action: RuntimeOwnedTransferAction
): Promise<RuntimeOwnedTransferAttempt> {
  const state = targets.get(target as object),
    entry = suspensions.get(suspended as object)
  if (
    !state ||
    !entry ||
    entry.target !== state ||
    entry.used ||
    deadlineExpired(entry.expiresAt) ||
    entry.generation !== state.generation ||
    state.state !== 'paused'
  )
    throw new Error('RUNTIME_TRANSFER_SUSPENSION_INVALID')
  if (
    action.transaction !== state.transaction ||
    state.retiredActions.has(action.identity) ||
    state.handovers >= state.bounds.maximumHandovers
  )
    throw new Error('RUNTIME_TRANSFER_HANDOVER_INVALID')
  if (state.operation || state.closing) throw new Error('RUNTIME_TRANSFER_OPERATION_IN_PROGRESS')
  assertStable(state)
  action.assertCurrentSync()
  if (!state.file) throw new Error('RUNTIME_TRANSFER_OWNER_MISSING')
  entry.used = true
  state.state = 'quiescing'
  const operation = (async () => {
    try {
      const checkpoint = await state.file!.sink.checkpointOwned(
        () => assertStable(state),
        Math.min(64 * 1024, state.bounds.maximumChunkBytes)
      )
      if (
        checkpoint.byteLength !== entry.checkpoint.byteLength ||
        checkpoint.sha256 !== entry.checkpoint.sha256 ||
        !sameRuntimeFileVersion(checkpoint.version, entry.checkpoint.version)
      )
        throw new Error('RUNTIME_TRANSFER_PREFIX_CHANGED')
      assertStable(state)
      action.assertCurrentSync()
      if (deadlineExpired(entry.expiresAt) || state.generation !== entry.generation || state.closing)
        throw new Error('RUNTIME_TRANSFER_SUSPENSION_INVALID')
      clearExpiry(state)
      state.action = action
      state.handovers++
      return issueAttempt(state)
    } catch (error) {
      state.state = 'frozen'
      throw error
    }
  })()
  return trackTerminal(state, operation)
}

export function finishRuntimeOwnedTransfer(
  target: RuntimeOwnedTransferTarget,
  attempt: RuntimeOwnedTransferAttempt
): Promise<RuntimeOwnedTransferVerified> {
  const state = terminalEntry(target, attempt)
  const operation = (async () => {
    try {
      if (state.inflight) await state.inflight
      if (!state.file || state.bytes !== state.claim.byteLength) throw new Error('RUNTIME_TRANSFER_SIZE_MISMATCH')
      const fence = (): void => {
        if (state.closing) throw new Error('RUNTIME_TRANSFER_QUIESCING')
        assertStable(state)
        state.action.assertCurrentSync()
      }
      fence()
      const checkpoint = await state.file.sink.checkpointOwned(
        fence,
        Math.min(64 * 1024, state.bounds.maximumChunkBytes)
      )
      if (checkpoint.byteLength !== state.claim.byteLength || checkpoint.sha256 !== state.claim.sha256)
        throw new Error('RUNTIME_TRANSFER_DIGEST_MISMATCH')
      fence()
      await state.file.sink.syncOwned(fence)
      fence()
      if (!(await state.host.close(state.file))) throw new Error('RUNTIME_TRANSFER_OWNER_UNCONFIRMED')
      fence()
      if (!(await state.host.verifyAndRename(state.file, checkpoint.sha256, state.action)))
        throw new Error('RUNTIME_TRANSFER_RENAME_UNCONFIRMED')
      const verified = token<RuntimeOwnedTransferVerified>()
      verifications.set(verified as object, state)
      state.verified = verified
      state.state = 'verified'
      state.host.transferFinished('verified')
      return verified
    } catch (error) {
      if (error instanceof Error && error.message === 'RUNTIME_TRANSFER_SIZE_MISMATCH') state.state = 'active'
      else if (!(error instanceof Error && error.message === 'RUNTIME_TRANSFER_DIGEST_MISMATCH')) state.state = 'frozen'
      throw error
    }
  })()
  return trackTerminal(state, operation)
}

export function discardRuntimeOwnedTransfer(
  target: RuntimeOwnedTransferTarget,
  cleanup: RuntimeOwnedTransferCleanup
): RuntimeOwnedTransferPendingCleanup {
  const state = targets.get(target as object),
    issued = cleanups.get(cleanup as object)
  if (!state || issued !== state) throw new Error('RUNTIME_TRANSFER_CLEANUP_INVALID')
  if (state.verified) {
    const settled: Promise<RuntimeOwnedTransferCleanupOutcome> = Promise.resolve({
      status: 'retained-known',
      reason: 'complete'
    })
    return Object.freeze({ status: 'pending-cleanup', settled })
  }
  if (!state.closePromise) {
    state.closing = true
    if (state.state === 'active') state.state = 'quiescing'
    clearExpiry(state)
    state.closePromise = (async () => {
      if (state.operation) await state.operation.catch(() => undefined)
      if (state.inflight) await state.inflight.catch(() => undefined)
      if (state.verified) return { status: 'retained-known', reason: 'complete' }
      if (!state.file) {
        state.state = 'closed'
        state.host.transferFinished('closed')
        return { status: 'retained-unknown', reason: 'owner missing' }
      }
      try {
        if (!(await state.host.close(state.file))) {
          state.state = 'closed'
          state.host.transferFinished('closed')
          return { status: 'retained-unknown', reason: 'owner unconfirmed' }
        }
      } catch {
        state.state = 'frozen'
        throw new Error('RUNTIME_TRANSFER_CLOSE_UNCONFIRMED')
      }
      try {
        try {
          state.cleanupCheck()
        } catch {
          return { status: 'retained-known', reason: 'scope-retired' }
        }
        return (await state.host.remove(state.file, state.cleanupCheck))
          ? { status: 'removed' }
          : { status: 'retained-unknown', reason: 'removal unconfirmed' }
      } catch (error) {
        return { status: 'retained-unknown', reason: error instanceof Error ? error.message : 'cleanup failed' }
      } finally {
        state.state = 'closed'
        state.host.transferFinished('closed')
      }
    })()
    state.host.retainUntilSettled(state.closePromise)
  }
  return Object.freeze({ status: 'pending-cleanup', settled: state.closePromise })
}
