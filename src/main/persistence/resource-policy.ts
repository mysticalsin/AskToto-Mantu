import { verify, type KeyObject } from 'node:crypto'
import { join } from 'node:path'
import { app } from 'electron'
import { rawToPublicKey } from '../license-lease-verify'
import { adminManagedConfigPath, readManagedPolicyAuthorityFile } from '../win-security'
import type { SpeechProvenanceLimits } from '@shared/meeting-speech-contract'
import type { MeetingSpeechPolicy } from '../infra/process/meeting-speech-protocol'
import type {
  EnterpriseRestriction,
  ImplementationInventory,
  ImplementationInventoryEntry,
  QaPersistenceCaseRoster,
  QaPersistenceCandidateManifest,
  PersistenceProfile,
  ProfileCatalog,
  QualificationState,
  RuntimePlatform
} from './resource-policy-contract'
export type {
  EnterpriseRestriction,
  ImplementationInventory,
  ImplementationInventoryEntry,
  QaPersistenceCaseRoster,
  QaPersistenceCandidateManifest,
  PersistenceProfile,
  ProfileCatalog,
  QualificationState,
  RuntimePlatform
} from './resource-policy-contract'

import {
  MAX_PROFILE_CATALOG_BYTES,
  PROFILE_ID_RE,
  SHA_RE,
  SOURCE_RE,
  canonical,
  exactKeys,
  isRecord,
  parseProfileCatalog,
  positiveInt,
  profileDigest,
  qualificationReportDigest,
  qualificationReportProfileDigestV1,
  sha256,
  strictJson,
  validString
} from './resource-policy-contract'
export {
  implementationInventoryDigest,
  parseImplementationInventory,
  parseProfileCatalog,
  parseQaPersistenceCandidateManifest,
  parseQaPersistenceCaseRoster,
  persistenceProfileDigest,
  qualificationReportDigest,
  qualificationReportProfileDigestV1,
  verifyQaPersistenceCandidateBundle
} from './resource-policy-contract'

export const PERSISTENCE_POLICY_DOMAIN = 'metis-persistence-policy/v1'
export const MAX_SIGNED_POLICY_BYTES = 1_048_576
declare const __METIS_PERSISTENCE_CATALOG_SHA256__: string

function packagedCatalogDigest(): string {
  try {
    return /^[a-f0-9]{64}$/.test(__METIS_PERSISTENCE_CATALOG_SHA256__) ? __METIS_PERSISTENCE_CATALOG_SHA256__ : ''
  } catch {
    return ''
  }
}

export interface RuntimeIdentity {
  platform: RuntimePlatform
  arch: 'x64' | 'arm64'
  node: string
  electron: string
  v8: string
  modules: string
}

export interface QualificationReport {
  schema: 'metis-persistence-qualification/v1'
  profileId: string
  profileDigest: string
  implementationSha256: string
  measuredSourceCommit: string
  runs: Array<{
    runtime: RuntimeIdentity
    workflow: { runId: string; attempt: number; repository: string; workflow: string }
    artifact: { sha256: string; name: string }
    measurements: {
      peakResidentBytes: number
      peakDiskBytes: number
      maxEventLoopDelayMs: number
      maxNativeCallMs: number
      maxOperationMs: number
      maxShutdownMs: number
      recordsWritten: number
      wordsWritten: number
      payloadBytesWritten: number
    }
    gates: {
      sourceAndWorker: 'passed'
      nativeKey: 'passed'
      profileBoundaries: 'passed'
      installedApp: 'passed'
      fourHourCapture: 'passed'
      legacyRecovery: 'passed'
      graphify: 'passed'
      upgradeRollback: 'passed'
    }
  }>
}

export interface SignedDocument {
  schema: string
  keyId: string
  payload: string
  signature: string
}

export interface TrustedEd25519Keys {
  /** Captured from app-owned or admin-trusted configuration, never from the signed document. */
  readonly byKeyId: Readonly<Record<string, string>>
}

export interface PolicyHighWater {
  epoch: number
  version: number
  payloadSha256: string
}

export type RefusalCode =
  | 'CATALOG_INVALID'
  | 'PROFILE_UNKNOWN'
  | 'RUNTIME_UNSUPPORTED'
  | 'PROFILE_UNQUALIFIED'
  | 'QUALIFICATION_MISSING'
  | 'QUALIFICATION_INVALID'
  | 'ENTERPRISE_REQUIRED'
  | 'ENTERPRISE_INVALID'
  | 'ENTERPRISE_EXPIRED'
  | 'ENTERPRISE_ROLLBACK'
  | 'ENTERPRISE_CONFLICT'
  | 'PROFILE_RESTRICTED'

export type ResourcePolicyResult =
  | {
      status: 'candidate'
      profile: ResolvedPersistenceProfile
      sourceCommit: string
      runtime: RuntimeIdentity
      policyHighWater?: PolicyHighWater
    }
  | {
      status: 'ready'
      profile: ResolvedPersistenceProfile
      sourceCommit: string
      runtime: RuntimeIdentity
      policyHighWater?: PolicyHighWater
    }
  | { status: 'refused'; code: RefusalCode }

export interface ResolvedPersistenceProfile extends Omit<PersistenceProfile, 'qualification'> {
  readonly profileDigest: string
  readonly catalogSha256: string
  readonly qualification: { readonly state: QualificationState; readonly reportSha256: string | null }
  readonly allowedProviders: readonly string[] | null
  readonly publicationAllowed: boolean
  readonly retentionAllowed: boolean
  readonly enterpriseWindow: Readonly<{ notBefore: number; expiresAt: number }> | null
}

export interface ResourcePolicyInput {
  catalogBytes?: Uint8Array
  bundledReceipt?: BundledPersistenceReceipt
  sourceCommit: string
  runtime: RuntimeIdentity
  mode: 'production' | 'qualification'
  requestedProfileId?: string
  enterpriseRequired?: boolean
  adminReceipt?: AdminPolicyReceipt
  signedPolicy?: Uint8Array
  policyKeys?: TrustedEd25519Keys
  enterpriseIssuer?: string
  enterpriseSubject?: string
  highWater?: PolicyHighWater | null
  now?: number
  qualificationReport?: Uint8Array
}

export type BundledCandidateInputs = Omit<
  ResourcePolicyInput,
  'mode' | 'catalogBytes' | 'bundledReceipt' | 'qualificationReport'
>

export type AdminPolicyReceipt = object & { readonly __adminPolicyReceipt?: never }
export type BundledPersistenceReceipt = object & { readonly __bundledPersistenceReceipt?: never }

const adminReceiptContents = new WeakMap<
  object,
  { state: 'present' | 'absent' | 'invalid'; policy?: EnterpriseRestriction; payloadSha256?: string }
>()
const bundledReceiptContents = new WeakMap<object, { catalogBytes: Uint8Array; reportBytes?: Uint8Array }>()
const KEY_ID_RE = /^[A-Za-z0-9._-]{1,80}$/

function validRestriction(value: unknown): value is EnterpriseRestriction {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      'issuer',
      'subject',
      'purpose',
      'version',
      'epoch',
      'notBefore',
      'expiresAt',
      'allowedProfileIds',
      'retention',
      'providers',
      'publication'
    ])
  )
    return false
  if (
    !validString(value.issuer, 128) ||
    !validString(value.subject, 128) ||
    value.purpose !== 'persistence-resource-policy'
  )
    return false
  if (
    ![value.version, value.epoch, value.notBefore, value.expiresAt].every(positiveInt) ||
    (value.version as number) > 0x7fffffff ||
    (value.epoch as number) > 0x7fffffff
  )
    return false
  if (typeof value.retention !== 'boolean' || typeof value.publication !== 'boolean') return false
  if (
    !Array.isArray(value.allowedProfileIds) ||
    value.allowedProfileIds.length === 0 ||
    value.allowedProfileIds.length > 8 ||
    !value.allowedProfileIds.every((id) => typeof id === 'string' && PROFILE_ID_RE.test(id))
  )
    return false
  if (
    !Array.isArray(value.providers) ||
    value.providers.length > 32 ||
    !value.providers.every((provider) => validString(provider, 64))
  )
    return false
  return (value.expiresAt as number) > (value.notBefore as number)
}

function decodeSignature(value: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]{80,100}$/.test(value)) return null
  const result = Buffer.from(value, 'base64url')
  return result.byteLength === 64 && result.toString('base64url') === value ? result : null
}

function getPublicKey(keys: TrustedEd25519Keys | undefined, keyId: unknown): KeyObject | null {
  if (!keys || !isRecord(keys.byKeyId) || typeof keyId !== 'string' || !KEY_ID_RE.test(keyId)) return null
  const raw = keys.byKeyId[keyId]
  if (typeof raw !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(raw)) return null
  try {
    return rawToPublicKey(raw)
  } catch {
    return null
  }
}

function signedPayload(
  bytes: Uint8Array,
  expectedSchema: string,
  keys: TrustedEd25519Keys | undefined,
  domain: string
): unknown | null {
  const parsed = strictJson(bytes, MAX_SIGNED_POLICY_BYTES)
  if (
    !isRecord(parsed) ||
    !exactKeys(parsed, ['schema', 'keyId', 'payload', 'signature']) ||
    parsed.schema !== expectedSchema
  )
    return null
  if (
    typeof parsed.payload !== 'string' ||
    parsed.payload.length > MAX_SIGNED_POLICY_BYTES * 2 ||
    !/^[A-Za-z0-9_-]+$/.test(parsed.payload)
  )
    return null
  const signature = typeof parsed.signature === 'string' ? decodeSignature(parsed.signature) : null
  const key = getPublicKey(keys, parsed.keyId)
  if (!signature || !key) return null
  let payloadBytes: Buffer
  try {
    payloadBytes = Buffer.from(parsed.payload, 'base64url')
    if (payloadBytes.toString('base64url') !== parsed.payload) return null
  } catch {
    return null
  }
  const message = Buffer.from(`${domain}\n${parsed.payload}`, 'utf8')
  try {
    if (!verify(null, message, key, signature)) return null
  } catch {
    return null
  }
  return strictJson(payloadBytes, MAX_SIGNED_POLICY_BYTES)
}

export function verifySignedEnterpriseRestriction(
  bytes: Uint8Array,
  keys: TrustedEd25519Keys | undefined
): { policy: EnterpriseRestriction; payloadSha256: string } | null {
  const value = signedPayload(bytes, 'metis-persistence-policy-envelope/v1', keys, PERSISTENCE_POLICY_DOMAIN)
  if (!validRestriction(value)) return null
  return { policy: value, payloadSha256: sha256(canonical(value)) }
}

export function classifyAdminPolicyDocument(value: unknown): {
  state: 'present' | 'absent' | 'invalid'
  policy?: EnterpriseRestriction
  payloadSha256?: string
} {
  const nested =
    isRecord(value) && Object.hasOwn(value, 'persistenceResourcePolicy') ? value.persistenceResourcePolicy : undefined
  const attemptedStandalone = isRecord(value) && value.purpose === 'persistence-resource-policy'
  if (nested === undefined && !attemptedStandalone) return { state: 'absent' }
  const candidate = nested === undefined ? value : nested
  if (!validRestriction(candidate)) return { state: 'invalid' }
  return { state: 'present', policy: Object.freeze(candidate), payloadSha256: sha256(canonical(candidate)) }
}

export async function readAdminPolicyReceipt(): Promise<AdminPolicyReceipt> {
  // The existing admin-file reader verifies Windows owner/DACL trust. On POSIX that API relies on
  // callers using the fixed root-owned path but does not inspect ownership, modes, or ancestors.
  // Until the owner API exposes those checks, unsigned file policy is explicitly unsupported there;
  // cross-platform enterprise restrictions use the externally trusted signed-envelope path.
  const result =
    process.platform === 'win32'
      ? await readManagedPolicyAuthorityFile(adminManagedConfigPath(), MAX_SIGNED_POLICY_BYTES, true)
      : { status: 'invalid' as const }
  let contents: { state: 'present' | 'absent' | 'invalid'; policy?: EnterpriseRestriction; payloadSha256?: string }
  if (result.status !== 'present') {
    contents = { state: result.status }
  } else {
    // General managed settings may omit this dedicated policy. Once its purpose is claimed, malformed
    // standalone or nested policy remains invalid and cannot downgrade to absence.
    contents = classifyAdminPolicyDocument(strictJson(result.bytes, MAX_SIGNED_POLICY_BYTES))
  }
  const receipt = Object.freeze(Object.create(null)) as AdminPolicyReceipt
  adminReceiptContents.set(receipt, contents)
  return receipt
}

/** Load the policy files from fixed application resources; the caller cannot supply paths or bytes. */
export async function readBundledPersistenceReceipt(): Promise<BundledPersistenceReceipt | null> {
  const root = app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'resources')
  try {
    const catalog = await readManagedPolicyAuthorityFile(
      join(root, 'persistence-profiles.v1.json'),
      MAX_PROFILE_CATALOG_BYTES,
      false
    )
    if (catalog.status !== 'present') return null
    const catalogBytes = new Uint8Array(catalog.bytes)
    if (sha256(catalogBytes) !== packagedCatalogDigest()) return null
    let reportBytes: Uint8Array | undefined
    try {
      const report = await readManagedPolicyAuthorityFile(
        join(root, 'persistence-qualification-standard.v1.json'),
        MAX_SIGNED_POLICY_BYTES,
        false
      )
      if (report.status === 'present') reportBytes = new Uint8Array(report.bytes)
      else if (report.status === 'invalid') return null
    } catch {
      // Candidate builds intentionally have no measured qualification file.
    }
    const receipt = Object.freeze(Object.create(null)) as BundledPersistenceReceipt
    bundledReceiptContents.set(receipt, { catalogBytes, reportBytes })
    return receipt
  } catch {
    return null
  }
}

export function evaluatePolicyHighWater(
  previous: PolicyHighWater | null | undefined,
  next: PolicyHighWater
): 'accept' | 'rollback' | 'conflict' {
  if (
    !Number.isSafeInteger(next.epoch) ||
    next.epoch <= 0 ||
    !Number.isSafeInteger(next.version) ||
    next.version <= 0 ||
    !SHA_RE.test(next.payloadSha256)
  )
    return 'rollback'
  if (!previous) return 'accept'
  if (
    !Number.isSafeInteger(previous.epoch) ||
    previous.epoch <= 0 ||
    !Number.isSafeInteger(previous.version) ||
    previous.version <= 0 ||
    !SHA_RE.test(previous.payloadSha256)
  )
    return 'rollback'
  if (next.epoch < previous.epoch || next.version < previous.version) return 'rollback'
  if (
    next.epoch === previous.epoch &&
    next.version === previous.version &&
    next.payloadSha256 !== previous.payloadSha256
  )
    return 'conflict'
  if (next.epoch === previous.epoch && next.version > previous.version) return 'accept'
  if (next.epoch > previous.epoch && next.version >= previous.version) return 'accept'
  return 'accept'
}

function validRuntime(runtime: RuntimeIdentity, supported: PersistenceProfile['supported']): boolean {
  if (!['win32', 'darwin', 'linux'].includes(runtime.platform) || !['x64', 'arm64'].includes(runtime.arch)) return false
  const target = supported.targets.find(
    (candidate) => candidate.platform === runtime.platform && candidate.arch === runtime.arch
  )
  return Boolean(
    target &&
      validString(runtime.node, 32) &&
      validString(runtime.v8, 32) &&
      validString(runtime.modules, 32) &&
      runtime.electron === target.electron &&
      (target.node === null || runtime.node === target.node) &&
      (target.v8 === null || runtime.v8 === target.v8) &&
      (target.modules === null || runtime.modules === target.modules)
  )
}

function validQualification(
  report: QualificationReport,
  expected: {
    profile: PersistenceProfile
    runtime: RuntimeIdentity
    implementationSha256: string
  }
): boolean {
  if (
    !isRecord(report) ||
    !exactKeys(report, [
      'schema',
      'profileId',
      'profileDigest',
      'implementationSha256',
      'measuredSourceCommit',
      'runs'
    ]) ||
    report.schema !== 'metis-persistence-qualification/v1'
  )
    return false
  if (
    report.profileId !== expected.profile.id ||
    report.profileDigest !== qualificationReportProfileDigestV1(expected.profile) ||
    report.implementationSha256 !== expected.implementationSha256 ||
    !SOURCE_RE.test(report.measuredSourceCommit)
  )
    return false
  if (!Array.isArray(report.runs) || report.runs.length !== expected.profile.supported.targets.length) return false
  const seen = new Set<string>()
  let currentRuntimeMeasured = false
  const measurementKeys = [
    'peakResidentBytes',
    'peakDiskBytes',
    'maxEventLoopDelayMs',
    'maxNativeCallMs',
    'maxOperationMs',
    'maxShutdownMs',
    'recordsWritten',
    'wordsWritten',
    'payloadBytesWritten'
  ] as const
  const gateKeys = [
    'sourceAndWorker',
    'nativeKey',
    'profileBoundaries',
    'installedApp',
    'fourHourCapture',
    'legacyRecovery',
    'graphify',
    'upgradeRollback'
  ] as const
  for (const candidate of report.runs) {
    if (!isRecord(candidate) || !exactKeys(candidate, ['runtime', 'workflow', 'artifact', 'measurements', 'gates']))
      return false
    if (
      !isRecord(candidate.runtime) ||
      !validRuntime(candidate.runtime as unknown as RuntimeIdentity, expected.profile.supported)
    )
      return false
    const targetKey = `${candidate.runtime.platform}/${candidate.runtime.arch}`
    if (seen.has(targetKey)) return false
    seen.add(targetKey)
    if (canonical(candidate.runtime) === canonical(expected.runtime)) currentRuntimeMeasured = true
    if (!isRecord(candidate.workflow) || !exactKeys(candidate.workflow, ['runId', 'attempt', 'repository', 'workflow']))
      return false
    if (
      !validString(candidate.workflow.runId, 64) ||
      !positiveInt(candidate.workflow.attempt) ||
      !validString(candidate.workflow.repository, 120) ||
      !validString(candidate.workflow.workflow, 120)
    )
      return false
    if (
      !isRecord(candidate.artifact) ||
      !exactKeys(candidate.artifact, ['sha256', 'name']) ||
      !SHA_RE.test(String(candidate.artifact.sha256)) ||
      !validString(candidate.artifact.name, 120)
    )
      return false
    if (
      !isRecord(candidate.measurements) ||
      !exactKeys(candidate.measurements, measurementKeys) ||
      !measurementKeys.every(
        (key) => Number.isSafeInteger(candidate.measurements[key]) && (candidate.measurements[key] as number) >= 0
      )
    )
      return false
    const measurements = candidate.measurements
    if (
      measurements.peakResidentBytes > expected.profile.consumers.residentBytes ||
      measurements.peakDiskBytes > expected.profile.derived.stagingBytes
    )
      return false
    if (
      measurements.maxOperationMs > expected.profile.worker.operationDeadlineMs ||
      measurements.maxShutdownMs > expected.profile.worker.shutdownDeadlineMs
    )
      return false
    if (
      measurements.recordsWritten < expected.profile.speech.maxRecords ||
      measurements.wordsWritten < expected.profile.speech.maxWords ||
      measurements.payloadBytesWritten < expected.profile.speech.maxPayloadBytes
    )
      return false
    if (
      !isRecord(candidate.gates) ||
      !exactKeys(candidate.gates, gateKeys) ||
      Object.values(candidate.gates).some((gate) => gate !== 'passed')
    )
      return false
  }
  const expectedTargets = expected.profile.supported.targets.map((target) => `${target.platform}/${target.arch}`)
  return currentRuntimeMeasured && expectedTargets.every((target) => seen.has(target))
}

function freezeResolved(
  profile: PersistenceProfile,
  digest: string,
  catalogSha256: string,
  restriction?: EnterpriseRestriction
): ResolvedPersistenceProfile {
  const publicProfile = profile
  return Object.freeze({
    ...publicProfile,
    supported: Object.freeze({
      ...profile.supported,
      targets: Object.freeze(profile.supported.targets.map((target) => Object.freeze({ ...target })))
    }),
    speech: Object.freeze({ ...profile.speech }),
    legacy: Object.freeze({ ...profile.legacy }),
    journal: Object.freeze({ ...profile.journal }),
    worker: Object.freeze({ ...profile.worker }),
    consumers: Object.freeze({ ...profile.consumers }),
    derived: Object.freeze({ ...profile.derived }),
    qualification: Object.freeze({ ...profile.qualification }),
    profileDigest: digest,
    catalogSha256,
    allowedProviders: restriction ? Object.freeze([...restriction.providers]) : null,
    publicationAllowed: restriction?.publication ?? true,
    retentionAllowed: restriction?.retention ?? true,
    enterpriseWindow: restriction
      ? Object.freeze({ notBefore: restriction.notBefore, expiresAt: restriction.expiresAt })
      : null
  }) as unknown as ResolvedPersistenceProfile
}
export function resolvePersistenceResourcePolicy(input: ResourcePolicyInput): ResourcePolicyResult {
  const bundled = input.bundledReceipt ? bundledReceiptContents.get(input.bundledReceipt) : undefined
  const catalogBytes = input.mode === 'production' ? bundled?.catalogBytes : input.catalogBytes
  const parsed = catalogBytes ? parseProfileCatalog(catalogBytes) : null
  if (!parsed || !SOURCE_RE.test(input.sourceCommit)) return { status: 'refused', code: 'CATALOG_INVALID' }
  const profileId = input.requestedProfileId ?? 'standard'
  const profile = parsed.catalog.profiles.find((candidate) => candidate.id === profileId)
  if (!profile) return { status: 'refused', code: 'PROFILE_UNKNOWN' }
  if (!validRuntime(input.runtime, profile.supported)) return { status: 'refused', code: 'RUNTIME_UNSUPPORTED' }

  let restriction: EnterpriseRestriction | undefined
  let restrictionDigest: string | undefined
  let acceptedHighWater: PolicyHighWater | undefined
  if (input.signedPolicy) {
    const verified = verifySignedEnterpriseRestriction(input.signedPolicy, input.policyKeys)
    if (!verified) return { status: 'refused', code: 'ENTERPRISE_INVALID' }
    restriction = verified.policy
    restrictionDigest = verified.payloadSha256
  } else if (input.adminReceipt) {
    const receipt = adminReceiptContents.get(input.adminReceipt)
    if (!receipt) return { status: 'refused', code: 'ENTERPRISE_INVALID' }
    if (receipt.state === 'invalid') return { status: 'refused', code: 'ENTERPRISE_INVALID' }
    if (receipt.state === 'absent') {
      if (input.enterpriseRequired) return { status: 'refused', code: 'ENTERPRISE_REQUIRED' }
    } else {
      if (!validRestriction(receipt.policy) || !SHA_RE.test(receipt.payloadSha256 ?? ''))
        return { status: 'refused', code: 'ENTERPRISE_INVALID' }
      restriction = receipt.policy
      restrictionDigest = receipt.payloadSha256
    }
  } else if (input.enterpriseRequired) return { status: 'refused', code: 'ENTERPRISE_REQUIRED' }

  if (restriction) {
    if (
      !validString(input.enterpriseIssuer, 128) ||
      !validString(input.enterpriseSubject, 128) ||
      restriction.issuer !== input.enterpriseIssuer ||
      restriction.subject !== input.enterpriseSubject
    ) {
      return { status: 'refused', code: 'ENTERPRISE_INVALID' }
    }
    const now = input.now ?? Date.now()
    if (!Number.isSafeInteger(now) || now < restriction.notBefore || now >= restriction.expiresAt)
      return { status: 'refused', code: 'ENTERPRISE_EXPIRED' }
    if (!restriction.allowedProfileIds.includes(profile.id)) return { status: 'refused', code: 'PROFILE_RESTRICTED' }
    const nextHighWater = { epoch: restriction.epoch, version: restriction.version, payloadSha256: restrictionDigest! }
    const transition = evaluatePolicyHighWater(input.highWater, nextHighWater)
    if (transition === 'rollback') return { status: 'refused', code: 'ENTERPRISE_ROLLBACK' }
    if (transition === 'conflict') return { status: 'refused', code: 'ENTERPRISE_CONFLICT' }
    acceptedHighWater = Object.freeze(nextHighWater)
  }

  const digest = profileDigest(profile)
  if (input.mode === 'qualification') {
    return {
      status: 'candidate',
      profile: freezeResolved(profile, digest, parsed.digest, restriction),
      sourceCommit: input.sourceCommit,
      runtime: Object.freeze({ ...input.runtime }),
      policyHighWater: acceptedHighWater
    }
  }
  if (profile.qualification.state !== 'QUALIFIED' || profile.qualification.reportSha256 === null)
    return { status: 'refused', code: 'PROFILE_UNQUALIFIED' }
  if (
    profile.supported.targets.some((target) => target.node === null || target.v8 === null || target.modules === null)
  ) {
    return { status: 'refused', code: 'QUALIFICATION_INVALID' }
  }
  const reportBytes = input.mode === 'production' ? bundled?.reportBytes : input.qualificationReport
  if (!reportBytes) return { status: 'refused', code: 'QUALIFICATION_MISSING' }
  if (qualificationReportDigest(reportBytes) !== profile.qualification.reportSha256)
    return { status: 'refused', code: 'QUALIFICATION_INVALID' }
  const report = strictJson(reportBytes, MAX_SIGNED_POLICY_BYTES)
  if (
    !report ||
    !validQualification(report as QualificationReport, {
      profile,
      runtime: input.runtime,
      implementationSha256: profile.implementationSha256 ?? ''
    })
  ) {
    return { status: 'refused', code: 'QUALIFICATION_INVALID' }
  }
  return {
    status: 'ready',
    profile: freezeResolved(profile, digest, parsed.digest, restriction),
    sourceCommit: input.sourceCommit,
    runtime: Object.freeze({ ...input.runtime }),
    policyHighWater: acceptedHighWater
  }
}

/** Resolve the fixed app-owned catalog through its opaque receipt for candidate diagnostics. */
export function resolveBundledPersistenceCandidate(
  receipt: BundledPersistenceReceipt | null,
  capturedInputs: BundledCandidateInputs
): Exclude<ResourcePolicyResult, { status: 'ready' }> {
  const bundled = receipt ? bundledReceiptContents.get(receipt) : undefined
  if (!bundled) return { status: 'refused', code: 'CATALOG_INVALID' }
  return resolvePersistenceResourcePolicy({
    ...capturedInputs,
    mode: 'qualification',
    catalogBytes: bundled.catalogBytes
  }) as Exclude<ResourcePolicyResult, { status: 'ready' }>
}

/** Exact adapter shape consumed by the existing speech worker host; one resolved profile owns both limits. */
export function toMeetingSpeechPolicy(profile: ResolvedPersistenceProfile): MeetingSpeechPolicy {
  const limits: SpeechProvenanceLimits = Object.freeze({
    maxRecords: profile.speech.maxRecords,
    maxWords: profile.speech.maxWords,
    maxFieldBytes: profile.speech.maxFieldBytes,
    maxRecordBytes: profile.speech.maxRecordBytes,
    maxPayloadBytes: profile.speech.maxPayloadBytes
  })
  return Object.freeze({
    limits,
    maxInputBytes: profile.worker.inputBytes,
    maxOutputBytes: profile.worker.outputBytes,
    operationDeadlineMs: profile.worker.operationDeadlineMs,
    shutdownDeadlineMs: profile.worker.shutdownDeadlineMs
  })
}
