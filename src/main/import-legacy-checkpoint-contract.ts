import type { ImportJob } from './import-job-types'

export type ImportJobHeader = Omit<ImportJob, 'lines'>
export type ImportLegacyFormat = 'plain' | 'native-v1' | 'v2'
export type ImportLegacyNativeV1Profile = Exclude<ImportLegacyBounds['nativeV1'], { unavailable: true }>

export interface ImportLegacyBounds {
  maxPhysicalBytes: number
  maxDecodedBytes: number
  maxDescriptorBytes: number
  maxHeaderBytes: number
  maxChunkBytes: number
  maxResidentBytes: number
  maxStagingBytes: number
  maxGlobalResidentBytes: number
  maxGlobalStagingBytes: number
  maxGlobalReadSlots: number
  maxGlobalWriteSlots: number
  maxGlobalCredits: number
  maxGlobalSettlingOperations: number
  maxRecords: number
  maxWords: number
  maxFieldBytes: number
  maxRecordBytes: number
  maxPayloadBytes: number
  operationDeadlineMs: number
  shutdownDeadlineMs: number
  nativeV1:
    | { unavailable: true }
    | {
        maxCiphertextBytes: number
        maxPlaintextBytes: number
        /** Peak inside the native call plus returned text; ciphertext is charged separately. */
        maxNativePeakBytes: number
        allocationProfileId: string
      }
}

export type ImportLegacyFailure =
  | 'UNCONFIGURED'
  | 'OWNERSHIP_UNPROVEN'
  | 'STALE_SCOPE'
  | 'SOURCE_CHANGED'
  | 'DEADLINE'
  | 'CLEANUP_FAILED'
  | 'LIMIT'
  | 'MALFORMED'
  | 'KEY_UNAVAILABLE'
  | 'NATIVE_V1_UNAVAILABLE'
  | 'WORKER_FAILED'

export class ImportLegacyAdapterError extends Error {
  constructor(readonly reason: ImportLegacyFailure) {
    super(reason)
    this.name = 'ImportLegacyAdapterError'
  }
}

export type ImportLegacyReadResult =
  | { status: 'ready'; header: ImportJobHeader; transcript: OpaqueTranscriptHandle; totals: ImportLegacyTotals }
  | { status: 'refused'; reason: ImportLegacyFailure }

export interface ImportLegacyTotals {
  records: number
  words: number
  payloadBytes: number
  decodedBytes: number
  physicalBytes: number
  sourceDigest: string
}

declare const operationScopeBrand: unique symbol
export type ImportOperationScope = { readonly [operationScopeBrand]: true }

/** The scope implementation keeps owner/root/policy/attempt state in a private registry. */
export interface ImportLegacyScopeAuthority {
  assertCurrent(scope: ImportOperationScope): void
  refreshSameScope(scope: ImportOperationScope): Promise<void>
}

export interface ImportLegacyFileVersion {
  dev: number
  ino: number
  nlink: number
  size: number
  mtimeMs: number
  ctimeMs: number
}

/** The actual storage owner binds this capability to a validated held FD and original physical root.
 * It must use no-follow/nonblocking opens, require one link, retain full file-version identity, and
 * resolve ownership/scope before any read. Neither bytes nor decryption may be used to infer ownership.
 */
export interface ImportLegacyHeldSource {
  readonly version: ImportLegacyFileVersion
  /**
   * The storage owner performs the final synchronous scope/root/version guard immediately before
   * issuing each physical read, then verifies the held descriptor/version after actual I/O settles.
   */
  readAt(
    position: number,
    target: Uint8Array,
    expected: ImportLegacyFileVersion,
    scope: ImportOperationScope,
    guard: ImportLegacySynchronousGuard
  ): Promise<number>
  /** Starts cancellation/settlement without waiting for authority refresh or operation cleanup. */
  requestCancel(): void
  /** Existing gateway/storage-owner check for original FD, path, root, and full version. */
  assertCurrentVersion(expected: ImportLegacyFileVersion, scope: ImportOperationScope): Promise<void>
  /** Captures a private origin-bound final admission for key unwrap and mutation-boundary checks. */
  admitOriginalSource(
    expected: ImportLegacyFileVersion,
    scope: ImportOperationScope
  ): Promise<ImportLegacySourceAdmission>
  close(): Promise<void>
  settled(): Promise<void>
}

export interface ImportLegacySynchronousGuard {
  assertCurrent(): void
}

declare const sourceAdmissionBrand: unique symbol
export interface ImportLegacySourceAdmission {
  readonly [sourceAdmissionBrand]: true
  /** Synchronous original owner/root/source/attempt check; mutation adapters call at commit boundary. */
  assertCurrent(): void
}

/** Synchronous guard invoked by the candidate owner at the durable pointer mutation boundary. */
export interface ImportLegacyCommitGuard {
  assertCurrent(): void
}

export interface ImportLegacySourceOwner {
  /** Opens the owner-approved original checkpoint through its existing gateway/storage owner. */
  open(jobId: string, scope: ImportOperationScope): Promise<ImportLegacyHeldSource>
}

export interface ImportLegacyKeyAdapter {
  /** Uses only the existing protected-key adapter: preserve F:/S:/bare unwraps; no escrow lookup,
   * key creation, rewrap, repair, or write is permitted on this read path. */
  unwrapV2(
    localDescriptor: string,
    admission: ImportLegacySourceAdmission,
    scope: ImportOperationScope
  ): Promise<Uint8Array>
  /** Reassert admission inside this adapter after key-adapter preparation and at the native unwrap call. */
  /** Must be bound to a qualified platform/backend profile and pre-admit both ceilings. */
  /** The adapter keeps its native slot/quarantine charge until the underlying call truly settles. */
  decryptNativeV1?(
    ciphertext: Uint8Array,
    profile: ImportLegacyNativeV1Profile,
    admission: ImportLegacySourceAdmission,
    scope: ImportOperationScope
  ): Promise<string>
}

export interface ImportLegacyRecordSink {
  /** One safe-JSON UTF-8 canonical record only; encrypt these exact bytes into an unpublished generation. */
  append(recordJson: Uint8Array, scope: ImportOperationScope): Promise<void>
  /** Synchronously latches exact-generation abort without waiting for pending append/publish work. */
  requestAbortOwnedCandidate(): void
  /** Called only after all parser, GCM, source-version and owner checks have passed. */
  publish(
    header: ImportJobHeader,
    totals: ImportLegacyTotals,
    admission: ImportLegacySourceAdmission,
    guard: ImportLegacyCommitGuard,
    scope: ImportOperationScope
  ): Promise<OpaqueTranscriptHandle>
  /** Exact-generation cleanup; after a durable pointer this must leave a restart tombstone. */
  abortOwnedCandidate(): Promise<void>
}

declare const transcriptHandleBrand: unique symbol
export type OpaqueTranscriptHandle = { readonly [transcriptHandleBrand]: true }

export interface ImportLegacyCandidateOwner {
  /** Reserves against this operation staging ceiling and the governor's global staging budget. */
  begin(
    jobId: string,
    expectedSourceBytes: number,
    stagingCeilingBytes: number,
    scope: ImportOperationScope
  ): Promise<ImportLegacyRecordSink>
}

/** Uses captured main-policy resident/staging/read/write/credit/deadline caps; never renderer defaults. */
export interface ImportLegacyResourceGovernor {
  /**
   * Atomically reserves one operation and retains it through native/worker quarantine and settlement.
   * A pending acquire remains charged after caller retirement; any late lease is returned so the
   * coordinator can quarantine it before doing further work.
   */
  acquire(
    scope: ImportOperationScope,
    bounds: ImportLegacyBounds,
    deadlineMs: number
  ): Promise<ImportLegacyResourceLease>
}

export interface ImportLegacyResourceLease {
  /** Includes quarantine/accounting for any native call or worker that outlives its operation deadline. */
  settled(): Promise<void>
  /** Transfers the full retained operation reservation to quarantine; it never releases capacity early. */
  quarantine(reason: 'DEADLINE' | 'CLEANUP_FAILED', shutdownDeadlineMs: number): void
}

export interface ImportLegacyCheckpointReaderOptions {
  authority: ImportLegacyScopeAuthority
  resources: ImportLegacyResourceGovernor
  source: ImportLegacySourceOwner
  keys: ImportLegacyKeyAdapter
  candidate: ImportLegacyCandidateOwner
  createWorker(): Promise<ImportLegacyWorkerPort>
  bounds(scope: ImportOperationScope): ImportLegacyBounds | undefined
}

export interface ImportLegacyWorkerPort {
  onMessage(listener: (message: unknown) => void): void
  onError(listener: () => void): void
  onExit(listener: (code: number) => void): void
  post(message: unknown, transfer?: ArrayBuffer[]): void
  terminate(): Promise<void>
}

export function validateImportLegacyBounds(value: ImportLegacyBounds | undefined): value is ImportLegacyBounds {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !==
      [
        'maxPhysicalBytes',
        'maxDecodedBytes',
        'maxDescriptorBytes',
        'maxHeaderBytes',
        'maxChunkBytes',
        'maxResidentBytes',
        'maxStagingBytes',
        'maxGlobalResidentBytes',
        'maxGlobalStagingBytes',
        'maxGlobalReadSlots',
        'maxGlobalWriteSlots',
        'maxGlobalCredits',
        'maxGlobalSettlingOperations',
        'maxRecords',
        'maxWords',
        'maxFieldBytes',
        'maxRecordBytes',
        'maxPayloadBytes',
        'operationDeadlineMs',
        'shutdownDeadlineMs',
        'nativeV1'
      ]
        .sort()
        .join(',')
  )
    return false
  if (!value.nativeV1 || typeof value.nativeV1 !== 'object' || Array.isArray(value.nativeV1)) return false
  const positive = Object.entries(value)
    .filter(([key]) => key !== 'nativeV1')
    .every(([, n]) => Number.isSafeInteger(n) && n > 0)
  // One transferred/decoded chunk, structured record nodes plus schema/canonical/writer copies,
  // bounded header token/value copies, and retained envelope descriptor copies. This is a logical
  // live-buffer/representation reservation, not a prediction of process RSS or allocator overhead.
  const residentMinimum = safeSum(
    safeProduct(value.maxChunkBytes, 4),
    safeProduct(value.maxRecordBytes, 8),
    safeProduct(value.maxHeaderBytes, 4),
    safeProduct(value.maxDescriptorBytes, 2)
  )
  if (
    !positive ||
    residentMinimum === undefined ||
    value.maxChunkBytes < 8 ||
    value.maxChunkBytes > value.maxPhysicalBytes ||
    value.maxDescriptorBytes > value.maxDecodedBytes ||
    value.maxRecordBytes > value.maxPayloadBytes ||
    value.maxPayloadBytes > value.maxDecodedBytes ||
    value.maxHeaderBytes > value.maxDecodedBytes ||
    value.maxFieldBytes > value.maxHeaderBytes ||
    value.maxFieldBytes > value.maxRecordBytes ||
    residentMinimum > value.maxResidentBytes ||
    value.operationDeadlineMs > 2_147_483_647 ||
    value.shutdownDeadlineMs > 2_147_483_647
  )
    return false
  if (
    value.maxResidentBytes > value.maxGlobalResidentBytes ||
    value.maxStagingBytes > value.maxGlobalStagingBytes ||
    value.maxGlobalReadSlots < 1 ||
    value.maxGlobalWriteSlots < 1 ||
    value.maxGlobalCredits < 1 ||
    value.maxGlobalSettlingOperations < 1
  )
    return false
  if ('unavailable' in value.nativeV1)
    return Object.keys(value.nativeV1).sort().join(',') === 'unavailable' && value.nativeV1.unavailable === true
  const native = value.nativeV1 as Exclude<ImportLegacyBounds['nativeV1'], { unavailable: true }>
  return (
    Object.keys(native).sort().join(',') ===
      'allocationProfileId,maxCiphertextBytes,maxNativePeakBytes,maxPlaintextBytes' &&
    typeof native.allocationProfileId === 'string' &&
    native.allocationProfileId.length > 0 &&
    native.allocationProfileId.length <= value.maxDescriptorBytes &&
    Number.isSafeInteger(native.maxCiphertextBytes) &&
    native.maxCiphertextBytes > 0 &&
    Number.isSafeInteger(native.maxPlaintextBytes) &&
    native.maxPlaintextBytes > 0 &&
    Number.isSafeInteger(native.maxNativePeakBytes) &&
    native.maxNativePeakBytes > 0 &&
    native.maxCiphertextBytes <= value.maxPhysicalBytes &&
    native.maxPlaintextBytes <= value.maxDecodedBytes &&
    native.maxNativePeakBytes <= value.maxResidentBytes
  )
}

/** Captures the exact policy snapshot used by main and every worker/adapter for this operation. */
export function captureImportLegacyBounds(value: ImportLegacyBounds): ImportLegacyBounds {
  const nativeV1 =
    'unavailable' in value.nativeV1
      ? Object.freeze({ unavailable: true as const })
      : Object.freeze({ ...value.nativeV1 })
  return Object.freeze({ ...value, nativeV1 })
}

function safeProduct(value: number, factor: number): number | undefined {
  const result = value * factor
  return Number.isSafeInteger(result) ? result : undefined
}

function safeSum(...values: (number | undefined)[]): number | undefined {
  if (values.some((value) => value === undefined)) return undefined
  let total = 0
  for (const value of values) {
    total += value!
    if (!Number.isSafeInteger(total)) return undefined
  }
  return total
}
