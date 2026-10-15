import { createPublicKey, randomBytes, verify, type KeyObject } from 'node:crypto'
import { dirname, win32 } from 'node:path'
import { QA_IDENTITY_BUILD } from '../qa-identity'
import { exactKeys, isRecord, positiveInt } from './resource-policy-contract'

/**
 * The D/E build producer compiles this exact, canonical JSON stamp as a literal. The stamp is
 * deliberately not read from the environment, resources, argv or an app-data file. An ordinary
 * build has no such define and therefore cannot authenticate a hosted run.
 *
 * schema: metis-persistence-qa-build-stamp/v1
 * Exact keys: schema, publicKeySpki, context, candidateSha256, implementationSha256,
 * profileMeasurementSha256, caseRosterSha256, runtime, qaIdentity. `publicKeySpki` is the
 * canonical unpadded base64url DER SubjectPublicKeyInfo for Ed25519. Context/runtime/identity
 * have the exact fields declared below; D/E must compile canonical sorted-key JSON as one literal.
 */
declare const __METIS_QA_PERSISTENCE_BUILD_STAMP__: string

export const QA_LAUNCH_ENVELOPE_SCHEMA = 'metis-persistence-qa-launch-envelope/v1'
export const QA_HEARTBEAT_SCHEMA = 'metis-persistence-qa-heartbeat/v1'
const QA_LAUNCH_DOMAIN = 'metis-persistence-qa-launch/v1\n'
const QA_HEARTBEAT_DOMAIN = 'metis-persistence-qa-heartbeat/v1\n'
export const QA_CONTROL_MAX_BYTES = 65_536
export const QA_CONTROL_MAX_DEPTH = 16
export const QA_MAX_RUN_MS = 6 * 60 * 60 * 1000
export const QA_HEARTBEAT_MAX_AGE_MS = 30_000
export const QA_HANDSHAKE_TIMEOUT_MS = 15_000

export type QaPersistenceCaseId =
  | 'native-journal-create-append'
  | 'native-journal-reopen'
  | 'native-explicit-optout-refusal'
  | 'native-unavailable-refusal'
  | 'before-show-refusal'
  | 'status-no-side-effects'

export type QaPersistenceRuntime = Readonly<{
  platform: 'win32' | 'darwin'
  arch: 'x64' | 'arm64'
  node: string
  electron: string
  v8: string
  modules: string
}>

export type QaPersistenceBuildContext = Readonly<{
  repository: string
  workflowRef: string
  commit: string
  runId: string
  runAttempt: number
  job: string
  target: 'win32-x64' | 'darwin-x64' | 'darwin-arm64'
}>

export type QaPersistenceIdentity = Readonly<{
  runtimeName: 'asktoto-qa'
  bundleId: string
  executableSha256: string
  signingMode: 'windows-authenticode' | 'mac-adhoc' | 'mac-developer-id'
}>

export type QaPhysicalDirectoryIdentity = Readonly<{
  path: string
  device: string
  inode: string
  birthtimeMs: number
  owner: string
  mode: number
}>

export type QaOsPrincipalAssociation =
  | Readonly<{ platform: 'darwin'; uid: number; effectiveUid: number }>
  | Readonly<{ platform: 'win32'; sidAssociationSha256: string }>

export type QaNativeKeyIntent = Readonly<{ present: boolean; value: string | null }>

export type QaPersistenceLaunchPayload = Readonly<{
  purpose: 'isolated-persistence-qualification'
  bootChallenge: string
  sourceCommit: string
  buildContext: QaPersistenceBuildContext
  runId: string
  runGeneration: number
  candidateSha256: string
  implementationSha256: string
  profileMeasurementSha256: string
  caseRosterSha256: string
  runtime: QaPersistenceRuntime
  qaIdentity: QaPersistenceIdentity
  allowedCases: readonly QaPersistenceCaseId[]
  notBefore: number
  expiresAt: number
  profile: QaPhysicalDirectoryIdentity
  parent: QaPhysicalDirectoryIdentity
  osPrincipalAssociation: QaOsPrincipalAssociation
  nativeKeyIntent: QaNativeKeyIntent
}>

export type QaPersistenceLaunchEnvelope = Readonly<{
  schema: typeof QA_LAUNCH_ENVELOPE_SCHEMA
  payload: string
  signature: string
}>

export type QaPersistenceBuildStamp = Readonly<{
  schema: 'metis-persistence-qa-build-stamp/v1'
  publicKeySpki: string
  context: QaPersistenceBuildContext
  candidateSha256: string
  implementationSha256: string
  profileMeasurementSha256: string
  caseRosterSha256: string
  runtime: QaPersistenceRuntime
  qaIdentity: QaPersistenceIdentity
}>

declare const verifiedLaunchBrand: unique symbol
export type VerifiedQaPersistenceLaunch = Readonly<{ [verifiedLaunchBrand]: true }>

const launchRecords = new WeakMap<object, QaPersistenceLaunchPayload>()
const CASE_IDS = new Set<QaPersistenceCaseId>([
  'native-journal-create-append',
  'native-journal-reopen',
  'native-explicit-optout-refusal',
  'native-unavailable-refusal',
  'before-show-refusal',
  'status-no-side-effects'
])
const HASH = /^[a-f0-9]{64}$/
const COMMIT = /^[a-f0-9]{40}$/
const B64URL = /^[A-Za-z0-9_-]+$/
const SAFE = Number.MAX_SAFE_INTEGER

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function freezeJson<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freezeJson(child)
    Object.freeze(value)
  }
  return value
}

function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return isRecord(value) && exactKeys(value, keys)
}

function boundedText(value: unknown, max = 512): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && value.trim() === value
}

function safeInt(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= SAFE
}

function finiteNonnegativeSample(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= SAFE
}

function positive(value: unknown): value is number {
  return positiveInt(value) && (value as number) <= SAFE
}

function base64url(bytes: Buffer): string {
  return bytes.toString('base64url')
}

function decodeBase64url(value: unknown, exactBytes?: number): Buffer | null {
  if (typeof value !== 'string' || !value || !B64URL.test(value)) return null
  try {
    const bytes = Buffer.from(value, 'base64url')
    if (base64url(bytes) !== value || (exactBytes !== undefined && bytes.byteLength !== exactBytes)) return null
    return bytes
  } catch {
    return null
  }
}

/** JSON.parse accepts duplicate keys. This bounded scanner rejects duplicates before parsing. */
function hasDuplicateKeys(text: string): boolean {
  let offset = 0
  const white = (): void => {
    while (text[offset] === ' ' || text[offset] === '\n' || text[offset] === '\r' || text[offset] === '\t') offset += 1
  }
  const string = (): string | null => {
    if (text[offset] !== '"') return null
    const start = offset++
    while (offset < text.length) {
      const char = text[offset++]
      if (char === '"') {
        try {
          return JSON.parse(text.slice(start, offset)) as string
        } catch {
          return null
        }
      }
      if (char === '\\') offset += 1
      else if (char.charCodeAt(0) < 0x20) return null
    }
    return null
  }
  const value = (depth: number): boolean => {
    white()
    if (depth > QA_CONTROL_MAX_DEPTH) return false
    if (text[offset] === '{') {
      offset += 1
      white()
      const seen = new Set<string>()
      if (text[offset] === '}') {
        offset += 1
        return true
      }
      for (;;) {
        white()
        const key = string()
        if (key === null || seen.has(key)) return false
        seen.add(key)
        white()
        if (text[offset++] !== ':') return false
        if (!value(depth + 1)) return false
        white()
        const delimiter = text[offset++]
        if (delimiter === '}') return true
        if (delimiter !== ',') return false
      }
    }
    if (text[offset] === '[') {
      offset += 1
      white()
      if (text[offset] === ']') {
        offset += 1
        return true
      }
      for (;;) {
        if (!value(depth + 1)) return false
        white()
        const delimiter = text[offset++]
        if (delimiter === ']') return true
        if (delimiter !== ',') return false
      }
    }
    if (text[offset] === '"') return string() !== null
    const remaining = text.slice(offset)
    const primitive = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(remaining)
    if (!primitive) return false
    offset += primitive[0].length
    return true
  }
  if (!value(0)) return true
  white()
  return offset !== text.length
}

function parseJsonNoDuplicates(bytes: Uint8Array, maxBytes = QA_CONTROL_MAX_BYTES): unknown | null {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > maxBytes) return null
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    if (Buffer.byteLength(text, 'utf8') !== bytes.byteLength || hasDuplicateKeys(text)) return null
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

function validContext(value: unknown): value is QaPersistenceBuildContext {
  if (!exact(value, ['repository', 'workflowRef', 'commit', 'runId', 'runAttempt', 'job', 'target'])) return false
  return (
    boundedText(value.repository, 200) &&
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value.repository) &&
    boundedText(value.workflowRef, 300) &&
    value.workflowRef.startsWith(value.repository + '/.github/workflows/') &&
    COMMIT.test(String(value.commit)) &&
    boundedText(value.runId, 32) &&
    /^\d{1,20}$/.test(value.runId) &&
    positive(value.runAttempt) &&
    boundedText(value.job, 100) &&
    (value.target === 'win32-x64' || value.target === 'darwin-x64' || value.target === 'darwin-arm64')
  )
}

function validRuntime(value: unknown): value is QaPersistenceRuntime {
  if (!exact(value, ['platform', 'arch', 'node', 'electron', 'v8', 'modules'])) return false
  return (
    (value.platform === 'win32' || value.platform === 'darwin') &&
    (value.arch === 'x64' || value.arch === 'arm64') &&
    boundedText(value.node, 40) &&
    boundedText(value.electron, 40) &&
    boundedText(value.v8, 40) &&
    boundedText(value.modules, 40) &&
    !(value.platform === 'win32' && value.arch !== 'x64')
  )
}

function validIdentity(value: unknown): value is QaPersistenceIdentity {
  if (!exact(value, ['runtimeName', 'bundleId', 'executableSha256', 'signingMode'])) return false
  return (
    value.runtimeName === 'asktoto-qa' &&
    boundedText(value.bundleId, 200) &&
    HASH.test(String(value.executableSha256)) &&
    (value.signingMode === 'windows-authenticode' ||
      value.signingMode === 'mac-adhoc' ||
      value.signingMode === 'mac-developer-id')
  )
}

function targetMatchesRuntime(context: QaPersistenceBuildContext, runtime: QaPersistenceRuntime): boolean {
  return (
    (context.target === 'win32-x64' && runtime.platform === 'win32' && runtime.arch === 'x64') ||
    (context.target === 'darwin-x64' && runtime.platform === 'darwin' && runtime.arch === 'x64') ||
    (context.target === 'darwin-arm64' && runtime.platform === 'darwin' && runtime.arch === 'arm64')
  )
}

function canonicalPhysicalPath(path: unknown, platform: 'win32' | 'darwin'): path is string {
  if (!boundedText(path, 4096) || Buffer.byteLength(path, 'utf8') > 4096) return false
  if (platform === 'darwin') {
    return (
      path.startsWith('/') &&
      !path.startsWith('//') &&
      !path.includes('\\') &&
      path.split('/').length <= 65 &&
      path.split('/').every((part, index) => index === 0 || (part !== '' && part !== '.' && part !== '..'))
    )
  }
  if (!/^[A-Z]:\\/.test(path) || path.includes('/') || path.endsWith('\\')) return false
  const components = path.slice(3).split('\\')
  return (
    components.length > 0 &&
    components.length <= 64 &&
    components.every(
      (part) =>
        part !== '' &&
        part !== '.' &&
        part !== '..' &&
        !/[<>:"|?*\u0000-\u001f]/.test(part) &&
        !/[. ]$/.test(part) &&
        !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i.test(part)
    )
  )
}

function validPhysical(value: unknown, platform: 'win32' | 'darwin'): value is QaPhysicalDirectoryIdentity {
  if (!exact(value, ['path', 'device', 'inode', 'birthtimeMs', 'owner', 'mode'])) return false
  if (!canonicalPhysicalPath(value.path, platform)) return false
  return (
    boundedText(value.device, 64) &&
    /^\d+$/.test(value.device) &&
    boundedText(value.inode, 64) &&
    /^\d+$/.test(value.inode) &&
    safeInt(value.birthtimeMs) &&
    boundedText(value.owner, 200) &&
    (platform === 'darwin' ? /^\d+$/.test(value.owner) : /^S-1-\d+(?:-\d+)+$/.test(value.owner)) &&
    safeInt(value.mode) &&
    value.mode <= 0o7777
  )
}

function validPrincipal(value: unknown): value is QaOsPrincipalAssociation {
  if (!isRecord(value) || !('platform' in value)) return false
  if (value.platform === 'darwin') {
    return (
      exact(value, ['platform', 'uid', 'effectiveUid']) &&
      safeInt(value.uid) &&
      safeInt(value.effectiveUid) &&
      value.uid === value.effectiveUid
    )
  }
  return (
    exact(value, ['platform', 'sidAssociationSha256']) &&
    value.platform === 'win32' &&
    HASH.test(String(value.sidAssociationSha256))
  )
}

function validCases(value: unknown): value is readonly QaPersistenceCaseId[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > CASE_IDS.size) return false
  const values = value as unknown[]
  return values.every(
    (item, index) =>
      typeof item === 'string' &&
      CASE_IDS.has(item as QaPersistenceCaseId) &&
      (index === 0 || (typeof values[index - 1] === 'string' && (values[index - 1] as string) < item))
  )
}

function validPayload(value: unknown): value is QaPersistenceLaunchPayload {
  if (
    !exact(value, [
      'purpose',
      'bootChallenge',
      'sourceCommit',
      'buildContext',
      'runId',
      'runGeneration',
      'candidateSha256',
      'implementationSha256',
      'profileMeasurementSha256',
      'caseRosterSha256',
      'runtime',
      'qaIdentity',
      'allowedCases',
      'notBefore',
      'expiresAt',
      'profile',
      'parent',
      'osPrincipalAssociation',
      'nativeKeyIntent'
    ])
  )
    return false
  const nativeKeyIntent = value.nativeKeyIntent
  const runtime = value.runtime as QaPersistenceRuntime
  const profile = value.profile as QaPhysicalDirectoryIdentity
  const parent = value.parent as QaPhysicalDirectoryIdentity
  return (
    value.purpose === 'isolated-persistence-qualification' &&
    decodeBase64url(value.bootChallenge, 32) !== null &&
    COMMIT.test(String(value.sourceCommit)) &&
    validContext(value.buildContext) &&
    value.sourceCommit === value.buildContext.commit &&
    value.runId === value.buildContext.runId &&
    positive(value.runGeneration) &&
    HASH.test(String(value.candidateSha256)) &&
    HASH.test(String(value.implementationSha256)) &&
    HASH.test(String(value.profileMeasurementSha256)) &&
    HASH.test(String(value.caseRosterSha256)) &&
    validRuntime(value.runtime) &&
    validIdentity(value.qaIdentity) &&
    targetMatchesRuntime(value.buildContext as QaPersistenceBuildContext, value.runtime as QaPersistenceRuntime) &&
    value.qaIdentity.bundleId === 'com.mantu.asktoto.qa' &&
    ((value.runtime.platform === 'win32' && value.qaIdentity.signingMode === 'windows-authenticode') ||
      (value.runtime.platform === 'darwin' && value.qaIdentity.signingMode !== 'windows-authenticode')) &&
    validCases(value.allowedCases) &&
    positive(value.notBefore) &&
    positive(value.expiresAt) &&
    value.expiresAt > value.notBefore &&
    value.expiresAt - value.notBefore <= QA_MAX_RUN_MS &&
    validPhysical(profile, (runtime as QaPersistenceRuntime).platform) &&
    validPhysical(parent, (runtime as QaPersistenceRuntime).platform) &&
    (runtime.platform === 'win32' ? win32.dirname(profile.path) : dirname(profile.path)) === parent.path &&
    profile.device === parent.device &&
    profile.owner === parent.owner &&
    profile.birthtimeMs >= parent.birthtimeMs &&
    validPrincipal(value.osPrincipalAssociation) &&
    exact(nativeKeyIntent, ['present', 'value']) &&
    typeof nativeKeyIntent.present === 'boolean' &&
    ((nativeKeyIntent.present && typeof nativeKeyIntent.value === 'string' && nativeKeyIntent.value.length <= 256) ||
      (!nativeKeyIntent.present && nativeKeyIntent.value === null))
  )
}

function parseBuildStamp(): { stamp: QaPersistenceBuildStamp; key: KeyObject } | null {
  if (!QA_IDENTITY_BUILD) return null
  try {
    if (typeof __METIS_QA_PERSISTENCE_BUILD_STAMP__ !== 'string') return null
    const bytes = Buffer.from(__METIS_QA_PERSISTENCE_BUILD_STAMP__, 'utf8')
    const parsed = parseJsonNoDuplicates(bytes, 8192)
    if (
      !exact(parsed, [
        'schema',
        'publicKeySpki',
        'context',
        'candidateSha256',
        'implementationSha256',
        'profileMeasurementSha256',
        'caseRosterSha256',
        'runtime',
        'qaIdentity'
      ]) ||
      parsed.schema !== 'metis-persistence-qa-build-stamp/v1' ||
      !validContext(parsed.context) ||
      !HASH.test(String(parsed.candidateSha256)) ||
      !HASH.test(String(parsed.implementationSha256)) ||
      !HASH.test(String(parsed.profileMeasurementSha256)) ||
      !HASH.test(String(parsed.caseRosterSha256)) ||
      !validRuntime(parsed.runtime) ||
      !validIdentity(parsed.qaIdentity) ||
      !targetMatchesRuntime(parsed.context as QaPersistenceBuildContext, parsed.runtime as QaPersistenceRuntime) ||
      parsed.qaIdentity.bundleId !== 'com.mantu.asktoto.qa' ||
      canonical(parsed) !== __METIS_QA_PERSISTENCE_BUILD_STAMP__
    )
      return null
    const der = decodeBase64url(parsed.publicKeySpki)
    if (!der || der.byteLength < 32 || der.byteLength > 128) return null
    const key = createPublicKey({ key: der, format: 'der', type: 'spki' })
    if (key.asymmetricKeyType !== 'ed25519') return null
    return { stamp: parsed as unknown as QaPersistenceBuildStamp, key }
  } catch {
    return null
  }
}

export function hasCompiledQaPersistenceRunStamp(): boolean {
  return parseBuildStamp() !== null
}

export function newQaPersistenceBootChallenge(): string {
  if (!QA_IDENTITY_BUILD) throw new Error('QA_RUN_NOT_QA_BUILD')
  return base64url(randomBytes(32))
}

export function compiledQaPersistenceRunContext(): Omit<QaPersistenceBuildStamp, 'publicKeySpki'> | null {
  const stamp = parseBuildStamp()?.stamp
  if (!stamp) return null
  return freezeJson({
    schema: stamp.schema,
    context: stamp.context,
    candidateSha256: stamp.candidateSha256,
    implementationSha256: stamp.implementationSha256,
    profileMeasurementSha256: stamp.profileMeasurementSha256,
    caseRosterSha256: stamp.caseRosterSha256,
    runtime: stamp.runtime,
    qaIdentity: stamp.qaIdentity
  })
}

/** Verify only with the key and context compiled into this exact QA build. */
export function verifyQaPersistenceLaunchEnvelope(
  bytes: Uint8Array,
  expectedBootChallenge: string,
  nowWallMs = Date.now()
): VerifiedQaPersistenceLaunch | null {
  const pinned = parseBuildStamp()
  if (!pinned || !finiteNonnegativeSample(nowWallMs) || decodeBase64url(expectedBootChallenge, 32) === null) return null
  const envelopeValue = parseJsonNoDuplicates(bytes)
  if (!exact(envelopeValue, ['schema', 'payload', 'signature']) || envelopeValue.schema !== QA_LAUNCH_ENVELOPE_SCHEMA)
    return null
  const payloadBytes = decodeBase64url(envelopeValue.payload)
  const signature = decodeBase64url(envelopeValue.signature, 64)
  if (!payloadBytes || !signature) return null
  let payloadText: string
  try {
    payloadText = new TextDecoder('utf-8', { fatal: true }).decode(payloadBytes)
  } catch {
    return null
  }
  if (hasDuplicateKeys(payloadText)) return null
  const payloadValue = parseJsonNoDuplicates(payloadBytes)
  if (!validPayload(payloadValue) || canonical(payloadValue) !== payloadText) return null
  const payload = payloadValue
  if (
    !verify(null, Buffer.concat([Buffer.from(QA_LAUNCH_DOMAIN, 'utf8'), payloadBytes]), pinned.key, signature) ||
    payload.bootChallenge !== expectedBootChallenge ||
    payload.buildContext.repository !== pinned.stamp.context.repository ||
    payload.buildContext.workflowRef !== pinned.stamp.context.workflowRef ||
    payload.buildContext.commit !== pinned.stamp.context.commit ||
    payload.buildContext.runId !== pinned.stamp.context.runId ||
    payload.buildContext.runAttempt !== pinned.stamp.context.runAttempt ||
    payload.buildContext.job !== pinned.stamp.context.job ||
    payload.buildContext.target !== pinned.stamp.context.target ||
    payload.candidateSha256 !== pinned.stamp.candidateSha256 ||
    payload.implementationSha256 !== pinned.stamp.implementationSha256 ||
    payload.profileMeasurementSha256 !== pinned.stamp.profileMeasurementSha256 ||
    payload.caseRosterSha256 !== pinned.stamp.caseRosterSha256 ||
    canonical(payload.runtime) !== canonical(pinned.stamp.runtime) ||
    canonical(payload.qaIdentity) !== canonical(pinned.stamp.qaIdentity) ||
    payload.notBefore > nowWallMs ||
    payload.expiresAt <= nowWallMs
  )
    return null
  const handle = Object.freeze({})
  launchRecords.set(handle, freezeJson(payload))
  return handle as VerifiedQaPersistenceLaunch
}

/** The physical owner accepts only opaque membership created by the verifier above. */
export function readVerifiedQaPersistenceLaunch(
  launch: VerifiedQaPersistenceLaunch
): QaPersistenceLaunchPayload | null {
  if (!launch || typeof launch !== 'object') return null
  return launchRecords.get(launch as object) ?? null
}

export type QaPersistenceHeartbeat = Readonly<{
  schema: typeof QA_HEARTBEAT_SCHEMA
  runId: string
  runGeneration: number
  sequence: number
  issuedAt: number
  signature: string
}>

export function verifyQaPersistenceHeartbeat(
  bytes: Uint8Array,
  launch: VerifiedQaPersistenceLaunch,
  lastSequence: number,
  lastReceiptMonotonicMs: number,
  nowWallMs = Date.now(),
  nowMonotonicMs = performance.now()
): QaPersistenceHeartbeat | null {
  const payload = readVerifiedQaPersistenceLaunch(launch)
  const pinned = parseBuildStamp()
  if (
    !payload ||
    !pinned ||
    !Number.isSafeInteger(lastSequence) ||
    lastSequence < 0 ||
    !finiteNonnegativeSample(lastReceiptMonotonicMs) ||
    !finiteNonnegativeSample(nowMonotonicMs) ||
    !finiteNonnegativeSample(nowWallMs)
  )
    return null
  const value = parseJsonNoDuplicates(bytes, 1024)
  if (!exact(value, ['schema', 'runId', 'runGeneration', 'sequence', 'issuedAt', 'signature'])) return null
  const signature = decodeBase64url(value.signature, 64)
  if (
    value.schema !== QA_HEARTBEAT_SCHEMA ||
    value.runId !== payload.runId ||
    value.runGeneration !== payload.runGeneration ||
    !positive(value.sequence) ||
    value.sequence <= lastSequence ||
    !positive(value.issuedAt) ||
    nowWallMs >= payload.expiresAt ||
    Math.abs(nowWallMs - value.issuedAt) > QA_HEARTBEAT_MAX_AGE_MS ||
    nowMonotonicMs < lastReceiptMonotonicMs ||
    nowMonotonicMs - lastReceiptMonotonicMs >= QA_HEARTBEAT_MAX_AGE_MS ||
    !signature
  )
    return null
  const unsigned = {
    issuedAt: value.issuedAt,
    runGeneration: value.runGeneration,
    runId: value.runId,
    schema: value.schema,
    sequence: value.sequence
  }
  if (
    !verify(
      null,
      Buffer.concat([Buffer.from(QA_HEARTBEAT_DOMAIN, 'utf8'), Buffer.from(canonical(unsigned), 'utf8')]),
      pinned.key,
      signature
    )
  )
    return null
  return value as unknown as QaPersistenceHeartbeat
}

export function qaPersistenceCanonical(value: unknown): string {
  return canonical(value)
}
