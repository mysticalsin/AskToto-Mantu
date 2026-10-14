import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { app } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import {
  PERSISTENCE_POLICY_DOMAIN,
  evaluatePolicyHighWater,
  parseProfileCatalog,
  persistenceProfileDigest,
  qualificationReportDigest,
  readBundledPersistenceReceipt,
  resolvePersistenceResourcePolicy,
  verifySignedEnterpriseRestriction,
  type RuntimeIdentity,
  type TrustedEd25519Keys
} from './resource-policy'

const catalogBytes = new Uint8Array(readFileSync(resolve(process.cwd(), 'resources/persistence-profiles.v1.json')))
const runtime: RuntimeIdentity = {
  platform: 'linux',
  arch: 'x64',
  node: '22.22.3',
  electron: '43.6.0',
  v8: '12.4.254.21-electron.0',
  modules: '136'
}

describe('persistence resource policy contracts', () => {
  it('accepts the immutable candidate catalog only when every derived ceiling is exact', () => {
    const parsed = parseProfileCatalog(catalogBytes)
    expect(parsed?.catalog.profiles[0]?.evidence).toBe('PROPOSED')
    expect(parsed?.catalog.profiles[0]?.qualification).toEqual({ state: 'PROPOSED', reportSha256: null })
    expect(parsed?.catalog.profiles[0]?.derived).toEqual({
      physicalRecordBytes: 266_284,
      canonicalTotalBytes: 201_326_592,
      journalBytes: 539_770_880,
      stagingBytes: 1_834_582_016
    })

    const changed = JSON.parse(Buffer.from(catalogBytes).toString('utf8')) as {
      profiles: Array<{ derived: { journalBytes: number } }>
    }
    changed.profiles[0].derived.journalBytes += 1
    expect(parseProfileCatalog(Buffer.from(JSON.stringify(changed)))).toBeNull()

    const unsupportedTarget = JSON.parse(Buffer.from(catalogBytes).toString('utf8')) as {
      profiles: Array<{ supported: { targets: Array<{ platform: string; arch: string }> } }>
    }
    unsupportedTarget.profiles[0]!.supported.targets[0]!.arch = 'arm64'
    expect(parseProfileCatalog(Buffer.from(JSON.stringify(unsupportedTarget)))).toBeNull()
  })

  it('resolves proposed budgets only as a qualification candidate and closes production admission', () => {
    const candidate = resolvePersistenceResourcePolicy({
      catalogBytes,
      sourceCommit: 'a'.repeat(40),
      runtime,
      mode: 'qualification'
    })
    expect(candidate.status).toBe('candidate')
    if (candidate.status === 'candidate') {
      expect(candidate.profile.qualification.state).toBe('PROPOSED')
      expect(Object.isFrozen(candidate.profile.speech)).toBe(true)
    }

    expect(
      resolvePersistenceResourcePolicy({
        catalogBytes,
        sourceCommit: 'a'.repeat(40),
        runtime,
        mode: 'production'
      })
    ).toEqual({ status: 'refused', code: 'CATALOG_INVALID' })
  })

  it('rejects unsupported runtime identities and unknown renderer-selected profile IDs', () => {
    expect(
      resolvePersistenceResourcePolicy({
        catalogBytes,
        sourceCommit: 'a'.repeat(40),
        runtime: { ...runtime, electron: '43.5.0' },
        mode: 'qualification'
      })
    ).toEqual({ status: 'refused', code: 'RUNTIME_UNSUPPORTED' })
    expect(
      resolvePersistenceResourcePolicy({
        catalogBytes,
        sourceCommit: 'a'.repeat(40),
        runtime,
        requestedProfileId: 'unbounded',
        mode: 'qualification'
      })
    ).toEqual({ status: 'refused', code: 'PROFILE_UNKNOWN' })
  })

  it('fails closed when required managed policy is absent and rejects a forged opaque admin receipt', () => {
    expect(
      resolvePersistenceResourcePolicy({
        catalogBytes,
        sourceCommit: 'a'.repeat(40),
        runtime,
        mode: 'qualification',
        enterpriseRequired: true
      })
    ).toEqual({ status: 'refused', code: 'ENTERPRISE_REQUIRED' })
    expect(
      resolvePersistenceResourcePolicy({
        catalogBytes,
        sourceCommit: 'a'.repeat(40),
        runtime,
        mode: 'qualification',
        adminReceipt: Object.freeze({ state: 'present', policy: {} })
      })
    ).toEqual({ status: 'refused', code: 'ENTERPRISE_INVALID' })
  })

  it('verifies domain-separated Ed25519 enterprise envelopes against an external trust anchor', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const jwk = publicKey.export({ format: 'jwk' })
    const payload = {
      issuer: 'fleet-admin',
      subject: 'managed-profile',
      purpose: 'persistence-resource-policy',
      version: 4,
      epoch: 9,
      notBefore: 1_800_000_000_000,
      expiresAt: 1_900_000_000_000,
      allowedProfileIds: ['standard'],
      retention: true,
      providers: [],
      publication: false
    }
    const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url')
    const signature = sign(null, Buffer.from(`${PERSISTENCE_POLICY_DOMAIN}\n${payloadB64}`), privateKey).toString(
      'base64url'
    )
    const envelope = Buffer.from(
      JSON.stringify({
        schema: 'metis-persistence-policy-envelope/v1',
        keyId: 'fleet-key-1',
        payload: payloadB64,
        signature
      })
    )
    const keys: TrustedEd25519Keys = { byKeyId: { 'fleet-key-1': jwk.x! } }
    expect(verifySignedEnterpriseRestriction(envelope, keys)?.policy).toEqual(payload)
    expect(
      resolvePersistenceResourcePolicy({
        catalogBytes,
        sourceCommit: 'a'.repeat(40),
        runtime,
        mode: 'qualification',
        signedPolicy: envelope,
        policyKeys: keys,
        enterpriseIssuer: 'fleet-admin',
        enterpriseSubject: 'managed-profile',
        now: 1_850_000_000_000
      }).status
    ).toBe('candidate')
    expect(
      resolvePersistenceResourcePolicy({
        catalogBytes,
        sourceCommit: 'a'.repeat(40),
        runtime,
        mode: 'qualification',
        signedPolicy: envelope,
        policyKeys: keys,
        enterpriseIssuer: 'fleet-admin',
        enterpriseSubject: 'different-profile',
        now: 1_850_000_000_000
      })
    ).toEqual({ status: 'refused', code: 'ENTERPRISE_INVALID' })
    const wrongDomainSignature = sign(null, Buffer.from(`other-domain\n${payloadB64}`), privateKey).toString(
      'base64url'
    )
    const wrongDomain = Buffer.from(
      JSON.stringify({
        schema: 'metis-persistence-policy-envelope/v1',
        keyId: 'fleet-key-1',
        payload: payloadB64,
        signature: wrongDomainSignature
      })
    )
    expect(verifySignedEnterpriseRestriction(wrongDomain, keys)).toBeNull()
    expect(verifySignedEnterpriseRestriction(envelope, { byKeyId: { 'fleet-key-1': 'A'.repeat(43) } })).toBeNull()
  })

  it('keeps enterprise epoch and version high-water monotonic through ABA restoration', () => {
    const first = { epoch: 3, version: 8, payloadSha256: '1'.repeat(64) }
    const successor = { epoch: 4, version: 9, payloadSha256: '2'.repeat(64) }
    expect(evaluatePolicyHighWater(null, first)).toBe('accept')
    expect(evaluatePolicyHighWater(first, successor)).toBe('accept')
    expect(evaluatePolicyHighWater(successor, first)).toBe('rollback')
    expect(evaluatePolicyHighWater(first, { ...first, payloadSha256: '3'.repeat(64) })).toBe('conflict')
    expect(evaluatePolicyHighWater({ ...first, payloadSha256: 'bad' }, successor)).toBe('rollback')
  })

  it('admits a real bundled qualification receipt only for its measured profile, source inventory, and runtime', async () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'metis-qualified-policy-'))
    const resources = resolve(directory, 'resources')
    mkdirSync(resources)
    const getAppPath = vi.spyOn(app, 'getAppPath').mockReturnValue(directory)
    try {
      const parsed = parseProfileCatalog(catalogBytes)
      expect(parsed).not.toBeNull()
      const catalog = JSON.parse(Buffer.from(catalogBytes).toString('utf8')) as {
        profiles: Array<{
          evidence: string
          supported: {
            targets: Array<{
              platform: string
              arch: string
              node: string | null
              v8: string | null
              modules: string | null
            }>
          }
          implementationSha256: string | null
          qualification: { state: string; reportSha256: string | null }
        }>
      }
      const profile = catalog.profiles[0]!
      const implementationSha256 = 'c'.repeat(64)
      profile.evidence = 'MEASURED'
      profile.implementationSha256 = implementationSha256
      profile.qualification.state = 'QUALIFIED'
      for (const target of profile.supported.targets) {
        target.node = target.platform === runtime.platform && target.arch === runtime.arch ? runtime.node : '22.22.3'
        target.v8 =
          target.platform === runtime.platform && target.arch === runtime.arch ? runtime.v8 : '12.4.254.21-electron.0'
        target.modules = target.platform === runtime.platform && target.arch === runtime.arch ? runtime.modules : '136'
      }
      const measuredProfile = profile as NonNullable<
        ReturnType<typeof parseProfileCatalog>
      >['catalog']['profiles'][number]
      const report = {
        schema: 'metis-persistence-qualification/v1',
        profileId: 'standard',
        profileDigest: persistenceProfileDigest(measuredProfile),
        implementationSha256,
        measuredSourceCommit: 'd'.repeat(40),
        runs: profile.supported.targets.map((target) => ({
          runtime: {
            platform: target.platform,
            arch: target.arch,
            node: target.node,
            electron: '43.6.0',
            v8: target.v8,
            modules: target.modules
          },
          workflow: { runId: '123456', attempt: 1, repository: 'mantu/metis', workflow: 'persistence-qualification' },
          artifact: { sha256: 'e'.repeat(64), name: 'qualification-evidence' },
          measurements: {
            peakResidentBytes: 120_000_000,
            peakDiskBytes: 1_800_000_000,
            maxEventLoopDelayMs: 20,
            maxNativeCallMs: 100,
            maxOperationMs: 5_000,
            maxShutdownMs: 500,
            recordsWritten: 65_536,
            wordsWritten: 1_048_576,
            payloadBytesWritten: 134_217_728
          },
          gates: {
            sourceAndWorker: 'passed',
            nativeKey: 'passed',
            profileBoundaries: 'passed',
            installedApp: 'passed',
            fourHourCapture: 'passed',
            legacyRecovery: 'passed',
            graphify: 'passed',
            upgradeRollback: 'passed'
          }
        }))
      }
      const reportBytes = Buffer.from(JSON.stringify(report))
      profile.qualification.reportSha256 = qualificationReportDigest(reportBytes)
      const measuredCatalogBytes = Buffer.from(JSON.stringify(catalog))
      writeFileSync(resolve(resources, 'persistence-profiles.v1.json'), measuredCatalogBytes)
      writeFileSync(resolve(resources, 'persistence-qualification-standard.v1.json'), reportBytes)

      const bundledReceipt = await readBundledPersistenceReceipt()
      expect(bundledReceipt).not.toBeNull()
      const ready = resolvePersistenceResourcePolicy({
        bundledReceipt: bundledReceipt!,
        sourceCommit: 'f'.repeat(40),
        runtime,
        mode: 'production'
      })
      expect(ready.status).toBe('ready')

      expect(
        resolvePersistenceResourcePolicy({
          bundledReceipt: bundledReceipt!,
          sourceCommit: 'f'.repeat(40),
          runtime: { ...runtime, node: '99.0.0' },
          mode: 'production'
        })
      ).toEqual({ status: 'refused', code: 'RUNTIME_UNSUPPORTED' })

      const changedProfile = JSON.parse(measuredCatalogBytes.toString('utf8')) as typeof catalog
      changedProfile.profiles[0]!.implementationSha256 = 'a'.repeat(64)
      writeFileSync(resolve(resources, 'persistence-profiles.v1.json'), JSON.stringify(changedProfile))
      const changedReceipt = await readBundledPersistenceReceipt()
      expect(
        resolvePersistenceResourcePolicy({
          bundledReceipt: changedReceipt!,
          sourceCommit: 'f'.repeat(40),
          runtime,
          mode: 'production'
        })
      ).toEqual({ status: 'refused', code: 'QUALIFICATION_INVALID' })
    } finally {
      getAppPath.mockRestore()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
