const originHandleBrand: unique symbol = Symbol('import-legacy-origin')

export type ImportLegacyOriginHandle = {
  readonly [originHandleBrand]: true
}

export type ImportLegacyOriginReason = 'UNCONFIGURED' | 'UNPROVEN_ORIGIN' | 'STALE_OPERATION'

export class ImportLegacyOriginError extends Error {
  constructor(readonly reason: ImportLegacyOriginReason) {
    super(
      reason === 'UNCONFIGURED'
        ? 'Legacy import recovery is not configured.'
        : reason === 'UNPROVEN_ORIGIN'
          ? 'This legacy import cannot be associated with the current owner.'
          : 'This legacy import operation is no longer current.'
    )
    this.name = 'ImportLegacyOriginError'
  }
}

/** Opaque metadata returned only by the trusted main-process origin verifier. */
export interface VerifiedLegacyOrigin {
  readonly ownerBinding: object
  readonly rootBinding: object
  readonly checkpointBinding: object
  readonly sourceBinding: object
  readonly semanticRevision: string
}

export interface ImportLegacyOriginRequest {
  readonly jobId: string
  readonly explicitResume: boolean
  /** Unique main-owned attempt identity; never an IPC payload value. */
  readonly operationAttempt: object
}

export interface ImportLegacyOriginDependencies {
  /** Must consult a protected legacy association; current sign-in alone is not proof. */
  verifyLegacyOrigin(request: ImportLegacyOriginRequest): Promise<VerifiedLegacyOrigin | undefined>
  /** Synchronous and side-effect free: checks captured owner/root/source bindings and attempt liveness. */
  isCurrent(request: ImportLegacyOriginRequest, origin: VerifiedLegacyOrigin): boolean
}

export interface ImportLegacyOriginAuthority {
  capture(request: ImportLegacyOriginRequest): Promise<ImportLegacyOriginHandle>
  assertCurrent(handle: ImportLegacyOriginHandle): void
  retire(handle: ImportLegacyOriginHandle): void
  bindings(handle: ImportLegacyOriginHandle): Readonly<{
    ownerBinding: object
    rootBinding: object
    checkpointBinding: object
    sourceBinding: object
    semanticRevision: string
  }>
}

const SAFE_JOB_ID =
  /^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|[0-9a-f]{32})$/

interface OriginState {
  readonly request: ImportLegacyOriginRequest
  readonly verified: VerifiedLegacyOrigin
  retired: boolean
}

/** Mints process-local handles bound to a protected historical owner proof and one explicit attempt. */
export function createImportLegacyOriginAuthority(deps: ImportLegacyOriginDependencies): ImportLegacyOriginAuthority {
  const stateByHandle = new WeakMap<object, OriginState>()

  async function capture(request: ImportLegacyOriginRequest): Promise<ImportLegacyOriginHandle> {
    if (!request.explicitResume) throw new ImportLegacyOriginError('UNPROVEN_ORIGIN')
    if (!SAFE_JOB_ID.test(request.jobId) || !request.operationAttempt) {
      throw new ImportLegacyOriginError('UNCONFIGURED')
    }
    const capturedRequest = Object.freeze({ ...request })
    const evidence = await deps.verifyLegacyOrigin(capturedRequest)
    if (!evidence) throw new ImportLegacyOriginError('UNPROVEN_ORIGIN')
    const verified = Object.freeze({ ...evidence })
    if (
      !verified.ownerBinding ||
      !verified.rootBinding ||
      !verified.checkpointBinding ||
      !verified.sourceBinding ||
      typeof verified.semanticRevision !== 'string' ||
      verified.semanticRevision.length === 0 ||
      !deps.isCurrent(capturedRequest, verified)
    ) {
      throw new ImportLegacyOriginError('UNPROVEN_ORIGIN')
    }
    const handle = Object.freeze({ [originHandleBrand]: true as const }) as ImportLegacyOriginHandle
    stateByHandle.set(handle, { request: capturedRequest, verified, retired: false })
    return handle
  }

  function state(handle: ImportLegacyOriginHandle): OriginState {
    const current = stateByHandle.get(handle)
    if (!current || current.retired) throw new ImportLegacyOriginError('STALE_OPERATION')
    return current
  }

  function assertCurrent(handle: ImportLegacyOriginHandle): void {
    const current = state(handle)
    if (!deps.isCurrent(current.request, current.verified)) {
      current.retired = true
      throw new ImportLegacyOriginError('STALE_OPERATION')
    }
  }

  function retire(handle: ImportLegacyOriginHandle): void {
    const current = stateByHandle.get(handle)
    if (current) current.retired = true
  }

  function bindings(handle: ImportLegacyOriginHandle): Readonly<{
    ownerBinding: object
    rootBinding: object
    checkpointBinding: object
    sourceBinding: object
    semanticRevision: string
  }> {
    assertCurrent(handle)
    const verified = state(handle).verified
    return Object.freeze({
      ownerBinding: verified.ownerBinding,
      rootBinding: verified.rootBinding,
      checkpointBinding: verified.checkpointBinding,
      sourceBinding: verified.sourceBinding,
      semanticRevision: verified.semanticRevision
    })
  }

  return { capture, assertCurrent, retire, bindings }
}
