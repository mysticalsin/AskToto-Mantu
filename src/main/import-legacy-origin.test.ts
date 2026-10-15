import { describe, expect, it } from 'vitest'
import {
  createImportLegacyOriginAuthority,
  ImportLegacyOriginError,
  type ImportLegacyOriginRequest,
  type VerifiedLegacyOrigin
} from './import-legacy-origin'

function makeEvidence(): VerifiedLegacyOrigin {
  return {
    ownerBinding: {},
    rootBinding: {},
    checkpointBinding: {},
    sourceBinding: {},
    semanticRevision: 'fixture-owner-root-v1'
  }
}

const request: ImportLegacyOriginRequest = {
  jobId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  explicitResume: true,
  operationAttempt: {}
}

describe('legacy import origin authority', () => {
  it('refuses missing historical owner proof instead of adopting the current sign-in', async () => {
    const authority = createImportLegacyOriginAuthority({
      verifyLegacyOrigin: async () => undefined,
      isCurrent: () => true
    })
    await expect(authority.capture(request)).rejects.toMatchObject({ reason: 'UNPROVEN_ORIGIN' })
  })

  it('requires explicit resume and rejects paths or arbitrary job IDs before origin lookup', async () => {
    let lookups = 0
    const authority = createImportLegacyOriginAuthority({
      verifyLegacyOrigin: async () => {
        lookups += 1
        return makeEvidence()
      },
      isCurrent: () => true
    })
    await expect(authority.capture({ ...request, explicitResume: false })).rejects.toMatchObject({
      reason: 'UNPROVEN_ORIGIN'
    })
    await expect(authority.capture({ ...request, jobId: '../checkpoint' })).rejects.toMatchObject({
      reason: 'UNCONFIGURED'
    })
    expect(lookups).toBe(0)
  })

  it('binds an opaque handle to the exact attempt and retires it permanently after a scope change', async () => {
    let current = true
    const evidence = makeEvidence()
    const authority = createImportLegacyOriginAuthority({
      verifyLegacyOrigin: async () => evidence,
      isCurrent: () => current
    })
    const handle = await authority.capture(request)
    expect(authority.bindings(handle)).toMatchObject({ semanticRevision: 'fixture-owner-root-v1' })
    current = false
    expect(() => authority.assertCurrent(handle)).toThrowError(expect.objectContaining({ reason: 'STALE_OPERATION' }))
    current = true
    expect(() => authority.assertCurrent(handle)).toThrowError(expect.objectContaining({ reason: 'STALE_OPERATION' }))
  })

  it('does not observe later mutation of verifier evidence after capture', async () => {
    const evidence = makeEvidence()
    const authority = createImportLegacyOriginAuthority({
      verifyLegacyOrigin: async () => evidence,
      isCurrent: (_request, captured) => captured.semanticRevision === 'fixture-owner-root-v1'
    })
    const handle = await authority.capture(request)
    Object.assign(evidence, { semanticRevision: 'changed-after-capture' })
    expect(authority.bindings(handle).semanticRevision).toBe('fixture-owner-root-v1')
    authority.retire(handle)
    expect(() => authority.bindings(handle)).toThrowError(expect.objectContaining({ reason: 'STALE_OPERATION' }))
  })
})
