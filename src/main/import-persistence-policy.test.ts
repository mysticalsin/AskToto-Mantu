import { describe, expect, it } from 'vitest'
import {
  createImportPersistenceCapabilityIssuer,
  resolveImportPersistencePolicy,
  type ImportPersistencePolicyInput
} from './import-persistence-policy'

async function policy(): Promise<ImportPersistencePolicyInput> {
  const capabilities = await createImportPersistenceCapabilityIssuer(() => true)()
  if (!capabilities) throw new Error('Synthetic authority fixture was not minted.')
  return {
    revision: 'synthetic-fixture-v1',
    ...capabilities,
    speech: {
      maxRecords: 64,
      maxWords: 4096,
      maxFieldBytes: 4096,
      maxRecordBytes: 16_384,
      maxPayloadBytes: 1_048_576
    },
    legacy: {
      maxPhysicalBytes: 2_097_152,
      maxDecodedBytes: 1_048_576,
      maxDescriptorBytes: 16_384,
      maxChunkBytes: 16_384,
      maxResidentBytes: 2_097_152,
      maxStagingBytes: 4_194_304,
      operationDeadlineMs: 30_000,
      shutdownDeadlineMs: 5_000,
      nativeV1: { unavailable: true }
    },
    journal: {
      maxJournalBytes: 4_194_304,
      maxPhysicalRecordBytes: 32_768,
      maxChunkBytes: 16_384,
      maxPageRecords: 16,
      maxPageBytes: 262_144
    },
    worker: {
      maxInputBytes: 1_048_576,
      maxOutputBytes: 262_144,
      operationDeadlineMs: 30_000,
      shutdownDeadlineMs: 5_000
    },
    consumers: {
      maxPublicExportBytes: 1_048_576,
      maxRecapInputBytes: 262_144,
      maxRecapOutputBytes: 65_536
    }
  }
}

describe('import persistence policy', () => {
  it('is explicitly unconfigured when trusted capabilities or finite budgets are absent', async () => {
    expect(resolveImportPersistencePolicy(undefined)).toMatchObject({
      status: 'unconfigured',
      missing: expect.arrayContaining([
        'ownerAuthority',
        'rootCapability',
        'protectedKeyProvider',
        'legacy.maxPhysicalBytes',
        'legacy.nativeV1'
      ])
    })
    const missingBudget = await policy()
    delete missingBudget.legacy?.maxPhysicalBytes
    expect(resolveImportPersistencePolicy(missingBudget)).toMatchObject({
      status: 'unconfigured',
      missing: ['legacy.maxPhysicalBytes']
    })
  })

  it('accepts only a complete injected policy and preserves native-v1 unavailability as a branch choice', async () => {
    const result = resolveImportPersistencePolicy(await policy())
    expect(result.status).toBe('configured')
    if (result.status !== 'configured') return
    expect(result.policy.legacy.nativeV1).toEqual({ unavailable: true })
    expect(Object.isFrozen(result.policy)).toBe(true)
    expect(Object.isFrozen(result.policy.legacy)).toBe(true)
  })

  it('does not accept caller-created lookalike objects as trusted capabilities', async () => {
    const input = await policy()
    input.rootCapability = {} as NonNullable<ImportPersistencePolicyInput['rootCapability']>
    expect(resolveImportPersistencePolicy(input)).toMatchObject({
      status: 'unconfigured',
      missing: ['rootCapability']
    })
  })

  it.each([
    [
      'unsafe integer',
      (input: ImportPersistencePolicyInput) => {
        input.legacy!.maxPhysicalBytes = Number.MAX_SAFE_INTEGER + 1
      }
    ],
    [
      'zero',
      (input: ImportPersistencePolicyInput) => {
        input.journal!.maxPageBytes = 0
      }
    ],
    [
      'cross-field overflow',
      (input: ImportPersistencePolicyInput) => {
        input.speech!.maxRecordBytes = input.speech!.maxPayloadBytes + 1
      }
    ],
    [
      'unknown key',
      (input: ImportPersistencePolicyInput) => {
        ;(input.legacy as Record<string, unknown>).fallbackBytes = 64
      }
    ],
    [
      'unqualified native allocation',
      (input: ImportPersistencePolicyInput) => {
        input.legacy!.nativeV1 = { maxCiphertextBytes: 1024, maxPlaintextBytes: 1024, allocationProfileId: '' }
      }
    ]
  ])('rejects %s without applying defaults', async (_label, mutate) => {
    const input = await policy()
    mutate(input)
    expect(resolveImportPersistencePolicy(input)).toEqual({ status: 'invalid', reason: 'INVALID_POLICY' })
  })
})
