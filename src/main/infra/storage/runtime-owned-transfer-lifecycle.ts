import { performance } from 'node:perf_hooks'
import type { RuntimeExclusiveFileCheckpoint } from './runtime-exclusive-file-sink'
import type { RuntimeExclusiveFileSink } from './runtime-exclusive-file-sink'
import type { RuntimePayloadFilePin } from './runtime-payload-plan'
import type { RuntimePayloadWritePlan } from './runtime-payload-plan'
import type { RuntimeOwnedTreeWriter } from './runtime-owned-tree-record'

declare const transferTargetBrand: unique symbol
declare const transferAttemptBrand: unique symbol
declare const transferSuspensionBrand: unique symbol
declare const transferCleanupBrand: unique symbol
declare const transferVerifiedBrand: unique symbol

export type RuntimeOwnedTransferTarget = { readonly [transferTargetBrand]: true }
export type RuntimeOwnedTransferAttempt = { readonly [transferAttemptBrand]: true }
export type RuntimeOwnedTransferSuspension = { readonly [transferSuspensionBrand]: true }
export type RuntimeOwnedTransferCleanup = { readonly [transferCleanupBrand]: true }
export type RuntimeOwnedTransferVerified = { readonly [transferVerifiedBrand]: true }

export interface RuntimeOwnedTransferAction {
  readonly identity: object
  readonly transaction: symbol
  assertCurrentSync(): void
}

export interface RuntimeOwnedTransferBounds {
  readonly maximumChunkBytes: number
  readonly maximumRequests: number
  readonly maximumRestarts: number
  readonly maximumHandovers: number
  readonly pausedRetentionMs: number
}

export interface RuntimeOwnedTransferProgress {
  readonly bytes: number
  readonly expectedBytes: number
  readonly expectedSha256: string
  readonly validator: string | null
  readonly state: 'active' | 'quiescing' | 'paused' | 'verified' | 'closed' | 'frozen'
}

export type RuntimeOwnedTransferCleanupOutcome =
  | { readonly status: 'removed' }
  | { readonly status: 'retained-known'; readonly reason: 'complete' | 'sealed' | 'scope-retired' }
  | { readonly status: 'retained-unknown'; readonly reason: string }

export interface RuntimeOwnedTransferPendingCleanup {
  readonly status: 'pending-cleanup'
  readonly settled: Promise<RuntimeOwnedTransferCleanupOutcome>
}

export interface RuntimeOwnedTransferStart {
  readonly target: RuntimeOwnedTransferTarget
  readonly attempt: RuntimeOwnedTransferAttempt
  readonly cleanup: RuntimeOwnedTransferCleanup
}

export interface RuntimeOwnedTransferFile {
  readonly sink: RuntimeExclusiveFileSink
  readonly byteLength: number
  readonly confirmed: boolean
}

/** The only path-aware part of a target. It is created and retained by runtime-owned-tree. */
export interface RuntimeOwnedTransferTreeHost {
  readonly plan: RuntimePayloadWritePlan
  reserve(): void
  assertStableCurrentSync(): void
  create(
    claim: { readonly path: string; readonly byteLength: number; readonly sha256: string },
    action: RuntimeOwnedTransferAction
  ): Promise<RuntimeOwnedTransferFile>
  close(file: RuntimeOwnedTransferFile): Promise<boolean>
  remove(file: RuntimeOwnedTransferFile, action: () => void): Promise<boolean>
  verifyAndRename(file: RuntimeOwnedTransferFile, sha256: string, action: RuntimeOwnedTransferAction): Promise<boolean>
  retainUntilSettled(promise: Promise<unknown>): void
  registerTarget(stopAndSettle: () => Promise<void>): void
  transferFinished(state: 'verified' | 'closed' | 'frozen'): void
}

export interface RuntimeOwnedTransferInput {
  readonly writer: RuntimeOwnedTreeWriter
  readonly pin: RuntimePayloadFilePin
  readonly action: RuntimeOwnedTransferAction
  readonly bounds: RuntimeOwnedTransferBounds
  readonly assertCleanupCurrentSync: () => void
}

interface WriterTransferSlot {
  transferActive: boolean
  accepting: boolean
  disposed: boolean
  settleTransfer: (() => void) | null
  transferStop: (() => Promise<void>) | null
  operations: Set<Promise<unknown>>
}

export function reserveWriterTransfer(state: WriterTransferSlot): void {
  if (state.transferActive || !state.accepting || state.disposed) throw new Error('RUNTIME_TREE_TRANSFER_SLOT_BUSY')
  state.transferActive = true
  const settled = new Promise<void>((resolve) => {
    state.settleTransfer = resolve
  })
  state.operations.add(settled)
  void settled.then(() => state.operations.delete(settled))
}

export function finishWriterTransfer(state: WriterTransferSlot, outcome: 'verified' | 'closed' | 'frozen'): void {
  if (outcome === 'frozen' || !state.transferActive) return
  state.transferActive = false
  state.settleTransfer?.()
  state.settleTransfer = null
  state.transferStop = null
}

export interface AttemptEntry {
  readonly target: TargetEntry
  readonly generation: number
  active: boolean
}

export interface SuspensionEntry {
  readonly target: TargetEntry
  readonly generation: number
  used: boolean
  readonly expiresAt: number
  readonly checkpoint: RuntimeExclusiveFileCheckpoint
}

export interface TargetEntry {
  readonly host: RuntimeOwnedTransferTreeHost
  readonly bounds: RuntimeOwnedTransferBounds
  readonly claim: { readonly path: string; readonly byteLength: number; readonly sha256: string }
  readonly transaction: symbol
  readonly cleanupCheck: () => void
  readonly cleanup: RuntimeOwnedTransferCleanup
  file: RuntimeOwnedTransferFile | null
  action: RuntimeOwnedTransferAction
  attempt: RuntimeOwnedTransferAttempt
  generation: number
  bytes: number
  validator: string | null
  state: RuntimeOwnedTransferProgress['state']
  inflight: Promise<void> | null
  closePromise: Promise<RuntimeOwnedTransferCleanupOutcome> | null
  verified: RuntimeOwnedTransferVerified | null
  handovers: number
  restarts: number
  operation: Promise<unknown> | null
  closing: boolean
  scopeRetired: boolean
  readonly retiredActions: Set<object>
  expiryTimer: ReturnType<typeof setTimeout> | null
}

export function assertStable(state: TargetEntry): void {
  if (state.scopeRetired) throw new Error('RUNTIME_TRANSFER_ROOT_CUSTODY_RETIRED')
  try {
    state.host.assertStableCurrentSync()
  } catch {
    state.scopeRetired = true
    throw new Error('RUNTIME_TRANSFER_ROOT_CUSTODY_RETIRED')
  }
}

export function admitTerminal(
  state: TargetEntry | undefined,
  issued: AttemptEntry | undefined,
  attempt: RuntimeOwnedTransferAttempt
): TargetEntry {
  if (!state || !issued || issued.target !== state || state.attempt !== attempt || !issued.active)
    throw new Error('RUNTIME_TRANSFER_ATTEMPT_INVALID')
  if (state.operation || state.closing || (state.state !== 'active' && state.state !== 'quiescing'))
    throw new Error('RUNTIME_TRANSFER_OPERATION_IN_PROGRESS')
  state.state = 'quiescing'
  return state
}

export function trackTerminal<T>(state: TargetEntry, operation: Promise<T>): Promise<T> {
  const joined = operation.finally(() => {
    if (state.operation === joined) state.operation = null
  })
  state.operation = joined
  state.host.retainUntilSettled(joined)
  return joined
}

export function monotonicDeadline(retentionMs: number): number {
  return performance.now() + retentionMs
}

export function deadlineExpired(deadline: number): boolean {
  return performance.now() >= deadline
}

export function startExpiry(state: TargetEntry, onExpire: () => void): number {
  if (state.expiryTimer) clearTimeout(state.expiryTimer)
  const deadline = monotonicDeadline(state.bounds.pausedRetentionMs)
  state.expiryTimer = setTimeout(onExpire, state.bounds.pausedRetentionMs)
  state.expiryTimer.unref?.()
  return deadline
}

export function clearExpiry(state: TargetEntry): void {
  if (state.expiryTimer) clearTimeout(state.expiryTimer)
  state.expiryTimer = null
}
