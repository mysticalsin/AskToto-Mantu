import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { app } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import * as winSecurity from '../win-security'
import {
  PERSISTENCE_POLICY_DOMAIN,
  classifyAdminPolicyDocument,
  evaluatePolicyHighWater,
  implementationInventoryDigest,
  parseImplementationInventory,
  parseProfileCatalog,
  parseQaPersistenceCandidateManifest,
  parseQaPersistenceCaseRoster,
  persistenceProfileDigest,
  qualificationReportProfileDigestV1,
  qualificationReportDigest,
  readBundledPersistenceReceipt,
  readAdminPolicyReceipt,
  resolvePersistenceResourcePolicy,
  verifyQaPersistenceCandidateBundle,
  verifySignedEnterpriseRestriction,
  type ImplementationInventory,
  type RuntimeIdentity,
  type TrustedEd25519Keys
} from './resource-policy'

vi.mock('electron')

// The repository Electron mock intentionally exposes only the APIs used by most
// tests. This physical resource fixture also needs app.getAppPath(), which the
// mock does not currently provide.
const mockedApp = Object.assign(app, {
  isPackaged: false,
  getAppPath: vi.fn(() => process.cwd())
})

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
  it('keeps measurement identity stable across labels and evidence status only', () => {
    const profile = parseProfileCatalog(catalogBytes)?.catalog.profiles[0]
    expect(profile).toBeDefined()
    if (!profile) return
    const initial = persistenceProfileDigest(profile)
    const evidenceOnly = {
      ...profile,
      label: 'Reviewer-facing label',
      evidence: 'MEASURED' as const,
      qualification: { state: 'QUALIFIED' as const, reportSha256: 'a'.repeat(64) }
    }
    expect(persistenceProfileDigest(evidenceOnly)).toBe(initial)
    expect(
      persistenceProfileDigest({
        ...evidenceOnly,
        speech: { ...profile.speech, maxWords: profile.speech.maxWords + 1 }
      })
    ).not.toBe(initial)
    expect(() =>
      persistenceProfileDigest({
        ...profile,
        derived: { ...profile.derived, journalBytes: profile.derived.journalBytes + 1 }
      })
    ).toThrow(/derived bounds do not match/i)
  })

  it('validates a closed sorted implementation inventory and rejects duplicate keys', () => {
    const inventory: ImplementationInventory = {
      schema: 'metis-persistence-implementation-inventory/v1',
      sourceCommit: 'a'.repeat(40),
      entries: [
        { path: 'src/main/a.ts', contentSha256: 'b'.repeat(64), provenance: 'source' },
        { path: 'src/main/b.ts', contentSha256: 'c'.repeat(64), provenance: 'source' }
      ]
    }
    const bytes = Buffer.from(JSON.stringify(inventory))
    expect(parseImplementationInventory(bytes, inventory.sourceCommit)?.inventory.entries).toHaveLength(2)
    expect(parseImplementationInventory(bytes, 'd'.repeat(40))).toBeNull()
    const unsorted = { ...inventory, entries: [...inventory.entries].reverse() }
    expect(parseImplementationInventory(Buffer.from(JSON.stringify(unsorted)))).toBeNull()
    expect(parseImplementationInventory(Buffer.from('{"schema":"x","schema":"y"}'))).toBeNull()
  })

  it('accepts canonical repository-relative paths and rejects absolute or noncanonical paths on every host OS', () => {
    const inventory = {
      schema: 'metis-persistence-implementation-inventory/v1',
      sourceCommit: 'a'.repeat(40),
      entries: [
        { path: 'src/main/persistence/resource-policy.ts', contentSha256: 'b'.repeat(64), provenance: 'source' }
      ]
    }
    expect(parseImplementationInventory(Buffer.from(JSON.stringify(inventory)))?.inventory.entries[0]?.path).toBe(
      'src/main/persistence/resource-policy.ts'
    )

    const invalidPaths = [
      'C:/Users/example/file.ts',
      'C:relative/file.ts',
      'Z:/repo/src/file.ts',
      '/etc/passwd',
      '\\\\server\\share\\file.ts',
      '\\\\?\\C:\\repo\\file.ts',
      'src\\main\\file.ts',
      'src/../outside.ts',
      'src/./file.ts',
      'src/main/\u0000file.ts'
    ]
    for (const path of invalidPaths) {
      const candidate = { ...inventory, entries: [{ ...inventory.entries[0], path }] }
      expect(parseImplementationInventory(Buffer.from(JSON.stringify(candidate)))).toBeNull()
    }
  })

  it('accepts only bounded QA candidate manifest schemas and fixed package identity', () => {
    const manifest = {
      schema: 'metis-persistence-qa-candidate/v1',
      purpose: 'isolated-persistence-qualification',
      sourceCommit: 'a'.repeat(40),
      implementationInventorySha256: 'b'.repeat(64),
      proposedCatalogSha256: 'c'.repeat(64),
      profileId: 'standard',
      profileMeasurementSha256: 'd'.repeat(64),
      caseRosterSha256: 'e'.repeat(64),
      qaIdentity: { appId: 'com.mantu.asktoto.qa', appName: 'asktoto-qa' },
      runtimes: [runtime]
    }
    expect(
      parseQaPersistenceCandidateManifest(Buffer.from(JSON.stringify(manifest)), manifest.sourceCommit)
    ).not.toBeNull()
    expect(parseQaPersistenceCandidateManifest(Buffer.from(JSON.stringify(manifest)), 'f'.repeat(40))).toBeNull()
    expect(
      parseQaPersistenceCandidateManifest(
        Buffer.from(JSON.stringify({ ...manifest, qaIdentity: { ...manifest.qaIdentity, appId: 'com.mantu.asktoto' } }))
      )
    ).toBeNull()
    expect(parseQaPersistenceCandidateManifest(Buffer.from('{"schema":"x","schema":"y"}'))).toBeNull()
  })

  it('requires a bounded, unique, sorted fixed QA case roster', () => {
    const valid = { schema: 'metis-persistence-qa-case-roster/v1', cases: ['append-reopen', 'create-settle'] }
    expect(parseQaPersistenceCaseRoster(Buffer.from(JSON.stringify(valid)))?.roster.cases).toEqual(valid.cases)
    expect(
      parseQaPersistenceCaseRoster(Buffer.from(JSON.stringify({ ...valid, cases: [...valid.cases].reverse() })))
    ).toBeNull()
    expect(
      parseQaPersistenceCaseRoster(Buffer.from(JSON.stringify({ ...valid, cases: ['append-reopen', 'append-reopen'] })))
    ).toBeNull()
  })

  it('binds a proposed candidate to its catalog, implementation inventory, runtime tuples, and case roster', () => {
    const inventory: ImplementationInventory = {
      schema: 'metis-persistence-implementation-inventory/v1',
      sourceCommit: 'a'.repeat(40),
      entries: [{ path: 'src/main/persistence/bootstrap.ts', contentSha256: 'b'.repeat(64), provenance: 'source' }]
    }
    const inventoryDigest = implementationInventoryDigest(inventory)
    const catalog = JSON.parse(Buffer.from(catalogBytes).toString('utf8')) as {
      profiles: Array<{
        implementationSha256: string | null
        supported: {
          targets: Array<{
            platform: string
            arch: string
            node: string | null
            v8: string | null
            modules: string | null
          }>
        }
      }>
    }
    catalog.profiles[0]!.implementationSha256 = inventoryDigest
    for (const target of catalog.profiles[0]!.supported.targets) {
      target.node = '22.22.3'
      target.v8 = '12.4.254.21-electron.0'
      target.modules = '136'
    }
    const proposedCatalogBytes = Buffer.from(JSON.stringify(catalog))
    const catalogDigest = createHash('sha256').update(proposedCatalogBytes).digest('hex')
    const parsedProfile = parseProfileCatalog(proposedCatalogBytes)?.catalog.profiles[0]
    expect(parsedProfile).toBeDefined()
    if (!parsedProfile) return
    const roster = { schema: 'metis-persistence-qa-case-roster/v1', cases: ['append-reopen', 'create-settle'] }
    const rosterBytes = Buffer.from(JSON.stringify(roster))
    const rosterDigest = parseQaPersistenceCaseRoster(rosterBytes)?.digest
    expect(rosterDigest).toBeDefined()
    const manifest = {
      schema: 'metis-persistence-qa-candidate/v1',
      purpose: 'isolated-persistence-qualification',
      sourceCommit: inventory.sourceCommit,
      implementationInventorySha256: inventoryDigest,
      proposedCatalogSha256: catalogDigest,
      profileId: parsedProfile.id,
      profileMeasurementSha256: persistenceProfileDigest(parsedProfile),
      caseRosterSha256: rosterDigest,
      qaIdentity: { appId: 'com.mantu.asktoto.qa', appName: 'asktoto-qa' },
      runtimes: parsedProfile.supported.targets
    }
    const manifestBytes = Buffer.from(JSON.stringify(manifest))
    const verified = verifyQaPersistenceCandidateBundle({
      catalogBytes: proposedCatalogBytes,
      inventoryBytes: Buffer.from(JSON.stringify(inventory)),
      caseRosterBytes: rosterBytes,
      manifestBytes
    })
    expect(verified?.implementationDigest).toBe(inventoryDigest)
    expect(
      verifyQaPersistenceCandidateBundle({
        catalogBytes: proposedCatalogBytes,
        inventoryBytes: Buffer.from(JSON.stringify(inventory)),
        caseRosterBytes: Buffer.from(
          JSON.stringify({ ...roster, cases: ['append-reopen', 'create-settle', 'new-case'] })
        ),
        manifestBytes
      })
    ).toBeNull()
  })

  it('distinguishes unrelated managed settings from malformed persistence policy attempts', () => {
    expect(classifyAdminPolicyDocument({ requireAuth: true })).toEqual({ state: 'absent' })
    expect(classifyAdminPolicyDocument({ persistenceResourcePolicy: null })).toEqual({ state: 'invalid' })
    expect(
      classifyAdminPolicyDocument({
        purpose: 'persistence-resource-policy',
        version: 1,
        expiresAt: 'invalid'
      })
    ).toEqual({ state: 'invalid' })
    expect(classifyAdminPolicyDocument({ purpose: 'other-policy', value: true })).toEqual({ state: 'absent' })
  })

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
    const resolved = resolvePersistenceResourcePolicy({
      catalogBytes,
      sourceCommit: 'a'.repeat(40),
      runtime,
      mode: 'qualification',
      signedPolicy: envelope,
      policyKeys: keys,
      enterpriseIssuer: 'fleet-admin',
      enterpriseSubject: 'managed-profile',
      now: 1_850_000_000_000
    })
    expect(resolved.status).toBe('candidate')
    if (resolved.status === 'candidate') {
      expect(resolved.profile.enterpriseWindow).toEqual({ notBefore: payload.notBefore, expiresAt: payload.expiresAt })
    }
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
    const getAppPath = vi.spyOn(mockedApp, 'getAppPath').mockReturnValue(directory)
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
        profileDigest: qualificationReportProfileDigestV1(measuredProfile),
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
      vi.stubGlobal(
        '__METIS_PERSISTENCE_CATALOG_SHA256__',
        createHash('sha256').update(measuredCatalogBytes).digest('hex')
      )

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
      expect(changedReceipt).toBeNull()
      expect(
        resolvePersistenceResourcePolicy({
          bundledReceipt: changedReceipt ?? undefined,
          sourceCommit: 'f'.repeat(40),
          runtime,
          mode: 'production'
        })
      ).toEqual({ status: 'refused', code: 'CATALOG_INVALID' })
    } finally {
      vi.unstubAllGlobals()
      getAppPath.mockRestore()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('does not downgrade malformed administrative policy bytes to absence', async ({ task }) => {
    const label = 'P15_MALFORMED_AUTHORITY_MUST_REMAIN_INVALID'
    const sourceCommit = 'a'.repeat(40)
    const hostPlatform = process.platform
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    const programDataPresent = Object.hasOwn(process.env, 'ProgramData')
    const programDataValue = process.env.ProgramData
    const originalReader = winSecurity.readManagedPolicyAuthorityFile
    let directory = ''
    let expectedDirectory = ''
    let expectedPath = ''
    let readerRestored = false
    let platformRestored = false
    let programDataRestored = false
    let tempRemoved = false
    let fixtureReady = false
    let fixtureError = false
    const readError = new Error('P15 fixed read error')
    const closeError = new Error('P15 fixed close error')
    const rows = [
      { id: 'M01', bytes: Buffer.from('{"persistenceResourcePolicy":'), expected: 'INVALID' },
      { id: 'M02', bytes: Buffer.from([0xc3, 0x28]), expected: 'INVALID' },
      { id: 'M03', bytes: Buffer.from('null'), expected: 'INVALID' },
      { id: 'M04', bytes: Buffer.from('[]'), expected: 'INVALID' },
      { id: 'M05', bytes: Buffer.from('"policy"'), expected: 'INVALID' },
      { id: 'M06', bytes: Buffer.from('7'), expected: 'INVALID' },
      { id: 'M07', bytes: Buffer.from('false'), expected: 'INVALID' },
      { id: 'M08', bytes: Buffer.from('{"requireAuth":true,"requireAuth":false}'), expected: 'INVALID' },
      {
        id: 'M09',
        bytes: Buffer.from(
          '{"persistenceResourcePolicy":{"purpose":"persistence-resource-policy","version":1,"version":2}}'
        ),
        expected: 'INVALID'
      },
      {
        id: 'M10',
        bytes: Buffer.from('{"persistenceResourcePolicy":null,"persistenceResourcePolic\\u0079":null}'),
        expected: 'INVALID'
      },
      { id: 'C01', bytes: Buffer.from('{"requireAuth":true}'), expected: 'ABSENT' },
      { id: 'C02', bytes: Buffer.from('{"purpose":"other-policy","value":true}'), expected: 'ABSENT' },
      { id: 'C03', expected: 'ABSENT', absent: true },
      { id: 'C04', expected: 'INVALID', invalid: true },
      { id: 'C05', expected: 'REJECTED', error: readError },
      { id: 'C06', expected: 'REJECTED', error: closeError },
      { id: 'C07', bytes: Buffer.from('{"persistenceResourcePolicy":null}'), expected: 'INVALID' },
      {
        id: 'C08',
        bytes: Buffer.from('{"purpose":"persistence-resource-policy","version":1,"expiresAt":"invalid"}'),
        expected: 'INVALID'
      }
    ]
    const observations: Array<Record<string, unknown>> = []
    let mismatches = 0
    const isOpaqueReceipt = (value: unknown): boolean =>
      value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === null && Object.isFrozen(value)
    const resolverState = (value: unknown): string => {
      if (!value || typeof value !== 'object' || !('status' in value)) return 'unexpected'
      if (value.status === 'candidate') return 'candidate'
      if (value.status !== 'refused' || !('code' in value) || Object.keys(value).sort().join(',') !== 'code,status')
        return 'unexpected'
      return value.code === 'ENTERPRISE_INVALID' || value.code === 'ENTERPRISE_REQUIRED' ? value.code : 'unexpected'
    }

    let reader: ReturnType<typeof vi.spyOn> | undefined
    try {
      try {
        directory = mkdtempSync(resolve(tmpdir(), 'metis-persistence-policy-p15-'))
        expectedDirectory = resolve(directory, 'Métis')
        expectedPath = resolve(expectedDirectory, 'managed-config.json')
        reader = vi.spyOn(winSecurity, 'readManagedPolicyAuthorityFile')
        mkdirSync(expectedDirectory)
        process.env.ProgramData = directory
        Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
        fixtureReady = winSecurity.adminManagedConfigPath() === expectedPath
      } catch {
        fixtureError = true
      }

      if (fixtureReady && reader) {
        for (const row of rows) {
          const callsBefore = reader.mock.calls.length
          let entered = false
          let terminal = false
          let receiptState: 'opaque' | 'none' | 'unexpected' = 'none'
          let optional = 'not-called'
          let required = 'not-called'
          let rejection = 'none'
          let readerOutcome: 'present' | 'absent' | 'invalid' | 'rejected' | 'unexpected' = 'unexpected'
          let readerArgs: 'exact' | 'wrong' | 'missing' = 'missing'
          let resolverCalls = 0
          try {
            reader.mockImplementationOnce(async (path: string, maxBytes?: number, requireAdminTrust?: boolean) => {
              const result = row.absent
                ? await originalReader(path, maxBytes, requireAdminTrust)
                : row.error
                  ? await Promise.reject(row.error)
                  : row.invalid
                    ? { status: 'invalid' as const }
                    : { status: 'present' as const, bytes: row.bytes! }
              readerOutcome = result.status
              return result
            })
            entered = true
            const receipt = await readAdminPolicyReceipt()
            receiptState = isOpaqueReceipt(receipt) ? 'opaque' : 'unexpected'
            if (!isOpaqueReceipt(receipt)) mismatches++
            const optionalResult = resolvePersistenceResourcePolicy({
              catalogBytes,
              sourceCommit,
              runtime,
              mode: 'qualification',
              adminReceipt: receipt,
              enterpriseRequired: false
            })
            optional = resolverState(optionalResult)
            resolverCalls++
            const requiredResult = resolvePersistenceResourcePolicy({
              catalogBytes,
              sourceCommit,
              runtime,
              mode: 'qualification',
              adminReceipt: receipt,
              enterpriseRequired: true
            })
            required = resolverState(requiredResult)
            resolverCalls++
            if (row.expected === 'INVALID') {
              if (optional !== 'ENTERPRISE_INVALID' || required !== 'ENTERPRISE_INVALID') mismatches++
            } else {
              if (optional !== 'candidate' || required !== 'ENTERPRISE_REQUIRED') mismatches++
              if (
                optionalResult.status !== 'candidate' ||
                optionalResult.profile.qualification.state !== 'PROPOSED' ||
                optionalResult.profile.qualification.reportSha256 !== null ||
                optionalResult.profile.maxHeldRoots !== 4
              ) {
                optional = 'unexpected'
                mismatches++
              }
            }
            terminal = true
          } catch (error) {
            readerOutcome = error === readError || error === closeError ? 'rejected' : 'unexpected'
            if (error === readError) rejection = 'same-read-error'
            else if (error === closeError) rejection = 'same-close-error'
            else rejection = 'unexpected'
            if (row.expected !== 'REJECTED' || rejection === 'unexpected') mismatches++
            terminal = true
          }
          const call = reader.mock.calls.at(-1)
          if (
            reader.mock.calls.length - callsBefore === 1 &&
            call?.[0] === expectedPath &&
            call[1] === 1_048_576 &&
            call[2] === true
          )
            readerArgs = 'exact'
          else readerArgs = reader.mock.calls.length === callsBefore ? 'missing' : 'wrong'
          if (reader.mock.calls.length - callsBefore !== 1 || readerArgs !== 'exact') mismatches++
          if (row.expected === 'REJECTED' && (resolverCalls !== 0 || receiptState !== 'none')) mismatches++
          observations.push({
            id: row.id,
            entered,
            terminal,
            readerCalls: reader.mock.calls.length - callsBefore,
            readerArgs,
            readerOutcome,
            receipt: receiptState,
            optional,
            required,
            rejection
          })
        }
      } else {
        for (const row of rows) {
          observations.push({
            id: row.id,
            entered: false,
            terminal: false,
            readerCalls: 0,
            readerArgs: 'missing',
            readerOutcome: 'unexpected',
            receipt: 'none',
            optional: 'not-called',
            required: 'not-called',
            rejection: 'unexpected'
          })
        }
      }
    } catch {
      fixtureError = true
    } finally {
      try {
        reader?.mockRestore()
        readerRestored = winSecurity.readManagedPolicyAuthorityFile === originalReader
      } catch {
        fixtureError = true
      }
      try {
        if (platformDescriptor) Object.defineProperty(process, 'platform', platformDescriptor)
        else Reflect.deleteProperty(process, 'platform')
        platformRestored =
          JSON.stringify(Object.getOwnPropertyDescriptor(process, 'platform')) === JSON.stringify(platformDescriptor)
      } catch {
        fixtureError = true
      }
      try {
        if (programDataPresent) process.env.ProgramData = programDataValue!
        else Reflect.deleteProperty(process.env, 'ProgramData')
        programDataRestored =
          Object.hasOwn(process.env, 'ProgramData') === programDataPresent &&
          process.env.ProgramData === programDataValue
      } catch {
        fixtureError = true
      }
      try {
        if (directory) rmSync(directory, { recursive: true, force: true })
        tempRemoved = !directory || !existsSync(directory)
      } catch {
        fixtureError = true
      }
    }

    if (fixtureError) fixtureReady = false
    const p15 = {
      schema: 'metis-persistence-policy-p15/v1',
      hostPlatform,
      branchPlatform: 'win32',
      boundary: 'trusted-byte-reader',
      fixtureReady,
      cleanup: { readerRestored, platformRestored, programDataRestored, tempRemoved },
      rows: observations
    }
    Object.assign(task.meta, { persistencePolicyP15: p15 })
    if (
      !fixtureReady ||
      fixtureError ||
      observations.length !== 18 ||
      Object.values(p15.cleanup).some((value) => !value)
    )
      mismatches++
    for (const [index, observation] of observations.entries()) {
      const row = rows[index]!
      if (observation.entered !== true || observation.terminal !== true) mismatches++
      if (row.expected === 'ABSENT') {
        if (observation.optional !== 'candidate' || observation.required !== 'ENTERPRISE_REQUIRED') mismatches++
      } else if (row.expected === 'INVALID') {
        if (observation.optional !== 'ENTERPRISE_INVALID' || observation.required !== 'ENTERPRISE_INVALID') mismatches++
      } else if (
        observation.optional !== 'not-called' ||
        observation.required !== 'not-called' ||
        observation.rejection !== (row.id === 'C05' ? 'same-read-error' : 'same-close-error')
      )
        mismatches++
    }
    expect(mismatches, label).toBe(0)
  })
})
