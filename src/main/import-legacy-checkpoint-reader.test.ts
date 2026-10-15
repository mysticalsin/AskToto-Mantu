import { describe, expect, it, vi } from 'vitest'
import type { ImportCheckpoint } from './import-job-checkpoint-contract'
import { createImportLegacyCheckpointReader } from './import-legacy-checkpoint-reader'
import { createImportLegacyOriginAuthority } from './import-legacy-origin'
import {
  createImportPersistenceCapabilityIssuer,
  resolveImportPersistencePolicy,
  type ImportPersistencePolicyInput
} from './import-persistence-policy'

async function configuredPolicy() {
  const capabilities = await createImportPersistenceCapabilityIssuer(() => true)()
  if (!capabilities) throw new Error('Synthetic authority fixture was not minted.')
  const input: ImportPersistencePolicyInput = {
    revision: 'synthetic-reader-fixture-v1',
    ...capabilities,
    speech: { maxRecords: 32, maxWords: 4096, maxFieldBytes: 1024, maxRecordBytes: 4096, maxPayloadBytes: 65_536 },
    legacy: {
      maxPhysicalBytes: 131_072,
      maxDecodedBytes: 65_536,
      maxDescriptorBytes: 4096,
      maxChunkBytes: 4096,
      maxResidentBytes: 131_072,
      maxStagingBytes: 262_144,
      operationDeadlineMs: 30_000,
      shutdownDeadlineMs: 5000,
      nativeV1: { unavailable: true }
    },
    journal: {
      maxJournalBytes: 262_144,
      maxPhysicalRecordBytes: 8192,
      maxChunkBytes: 4096,
      maxPageRecords: 8,
      maxPageBytes: 32_768
    },
    worker: { maxInputBytes: 65_536, maxOutputBytes: 32_768, operationDeadlineMs: 30_000, shutdownDeadlineMs: 5000 },
    consumers: { maxPublicExportBytes: 65_536, maxRecapInputBytes: 16_384, maxRecapOutputBytes: 4096 }
  }
  return resolveImportPersistencePolicy(input)
}

function authority(verify: () => boolean = () => true) {
  return createImportLegacyOriginAuthority({
    verifyLegacyOrigin: async () =>
      verify()
        ? {
            ownerBinding: {},
            rootBinding: {},
            checkpointBinding: {},
            sourceBinding: {},
            semanticRevision: 'synthetic-owner-root-v1'
          }
        : undefined,
    isCurrent: () => verify()
  })
}

const request = {
  jobId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  explicitResume: true,
  operationAttempt: {}
}

function checkpoint(jobId = request.jobId): ImportCheckpoint {
  return {
    header: {
      jobId,
      sourcePath: '/synthetic/source.wav',
      sourceName: 'source.wav',
      sourceSizeBytes: 12,
      sourceMtimeMs: 1,
      title: 'Synthetic import',
      state: 'queued',
      cursor: 0,
      totalChunks: 0,
      file: undefined,
      createdAt: 1,
      updatedAt: 1
    },
    transcript: {} as ImportCheckpoint['transcript'],
    frontier: {
      generation: 'g1',
      journalId: 'j1',
      revision: 0,
      recordCount: 0,
      wordCount: 0,
      payloadBytes: 0,
      cursor: 0
    }
  }
}

describe('legacy checkpoint admission', () => {
  it('does not invoke an origin verifier or decoder while persistence is unconfigured', async () => {
    const verify = vi.fn()
    const decode = vi.fn()
    const reader = createImportLegacyCheckpointReader({
      persistencePolicy: () => ({ status: 'unconfigured', missing: ['legacy.maxPhysicalBytes'] }),
      origin: authority(verify),
      decoder: { read: decode }
    })
    await expect(reader.read(request)).resolves.toEqual({ status: 'held', reason: 'UNCONFIGURED' })
    expect(verify).not.toHaveBeenCalled()
    expect(decode).not.toHaveBeenCalled()
  })

  it('does not invoke the decoder when historical owner association is missing', async () => {
    const decode = vi.fn()
    const configured = await configuredPolicy()
    const reader = createImportLegacyCheckpointReader({
      persistencePolicy: () => configured,
      origin: authority(() => false),
      decoder: { read: decode }
    })
    await expect(reader.read(request)).resolves.toEqual({ status: 'held', reason: 'OWNERSHIP_UNPROVEN' })
    expect(decode).not.toHaveBeenCalled()
  })

  it('checks the same origin after decoder completion and retires late output', async () => {
    let current = true
    const configured = await configuredPolicy()
    const origin = authority(() => current)
    const read = vi.fn(async (_input, assertCurrent) => {
      assertCurrent()
      current = false
      return checkpoint()
    })
    const reader = createImportLegacyCheckpointReader({
      persistencePolicy: () => configured,
      origin,
      decoder: { read }
    })
    await expect(reader.read(request)).resolves.toEqual({ status: 'held', reason: 'STALE_OWNER' })
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('passes an injected immutable budget and opaque origin only after explicit resume admission', async () => {
    const configured = await configuredPolicy()
    const read = vi.fn(async ({ jobId, policy }) => checkpoint(jobId))
    const reader = createImportLegacyCheckpointReader({
      persistencePolicy: () => configured,
      origin: authority(),
      decoder: { read }
    })
    const result = await reader.read(request)
    expect(result.status).toBe('ready')
    expect(read).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: request.jobId,
        policy: expect.objectContaining({ revision: 'synthetic-reader-fixture-v1' })
      }),
      expect.any(Function)
    )
  })
})
