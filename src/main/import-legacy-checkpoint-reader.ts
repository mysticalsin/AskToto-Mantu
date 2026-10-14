import type { ImportCheckpoint } from './import-job-checkpoint-contract'
import {
  ImportCheckpointUnavailableError,
  type ImportCheckpointFailure,
  type ImportLegacyCheckpointDecoder
} from './import-job-checkpoint-contract'
import {
  ImportLegacyOriginError,
  type ImportLegacyOriginAuthority,
  type ImportLegacyOriginHandle,
  type ImportLegacyOriginRequest
} from './import-legacy-origin'
import type { ImportPersistencePolicyResult } from './import-persistence-policy'

export type ImportLegacyCheckpointReadResult =
  | {
      readonly status: 'ready'
      readonly checkpoint: ImportCheckpoint
      readonly origin: ImportLegacyOriginHandle
    }
  | { readonly status: 'held'; readonly reason: ImportCheckpointFailure }

export interface ImportLegacyCheckpointReaderDependencies {
  persistencePolicy(): ImportPersistencePolicyResult
  origin: ImportLegacyOriginAuthority
  decoder?: ImportLegacyCheckpointDecoder
}

function originFailure(error: unknown): ImportCheckpointFailure {
  if (error instanceof ImportLegacyOriginError) {
    if (error.reason === 'UNPROVEN_ORIGIN') return 'OWNERSHIP_UNPROVEN'
    if (error.reason === 'STALE_OPERATION') return 'STALE_OWNER'
  }
  return 'UNCONFIGURED'
}

/** Performs authority admission before any decoder can open or consume checkpoint bytes. */
export function createImportLegacyCheckpointReader(deps: ImportLegacyCheckpointReaderDependencies) {
  async function read(request: ImportLegacyOriginRequest): Promise<ImportLegacyCheckpointReadResult> {
    const capturedRequest = Object.freeze({ ...request })
    const configured = deps.persistencePolicy()
    if (configured.status !== 'configured' || !deps.decoder) {
      return { status: 'held', reason: 'UNCONFIGURED' }
    }

    let origin: ImportLegacyOriginHandle
    try {
      origin = await deps.origin.capture(capturedRequest)
      deps.origin.assertCurrent(origin)
    } catch (error) {
      return { status: 'held', reason: originFailure(error) }
    }

    try {
      const checkpoint = await deps.decoder.read(
        Object.freeze({ jobId: capturedRequest.jobId, policy: configured.policy, origin }),
        () => deps.origin.assertCurrent(origin)
      )
      deps.origin.assertCurrent(origin)
      if (checkpoint.header.jobId !== capturedRequest.jobId) {
        throw new ImportCheckpointUnavailableError('MALFORMED')
      }
      return { status: 'ready', checkpoint, origin }
    } catch (error) {
      deps.origin.retire(origin)
      return {
        status: 'held',
        reason: error instanceof ImportCheckpointUnavailableError ? error.reason : originFailure(error)
      }
    }
  }

  return { read }
}
