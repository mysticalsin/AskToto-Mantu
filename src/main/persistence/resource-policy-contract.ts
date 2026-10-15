import { createHash } from 'node:crypto'

export type RuntimePlatform = 'win32' | 'darwin' | 'linux'
export type QualificationState = 'PROPOSED' | 'QUALIFIED'

export interface PersistenceProfile {
  id: string
  label: string
  evidence: 'PROPOSED' | 'MEASURED'
  supported: {
    targets: Array<{
      platform: RuntimePlatform
      arch: 'x64' | 'arm64'
      node: string | null
      v8: string | null
      modules: string | null
      electron: string
    }>
  }
  implementationSha256: string | null
  speech: {
    maxRecords: number
    maxWords: number
    maxFieldBytes: number
    maxRecordBytes: number
    maxPayloadBytes: number
  }
  legacy: { decodedBytes: number; physicalBytes: number; descriptorBytes: number }
  journal: {
    recordMetadataBytes: number
    canonicalWrapperBytes: number
    indexEntryBytes: number
    manifestBytes: number
  }
  worker: { inputBytes: number; outputBytes: number; operationDeadlineMs: number; shutdownDeadlineMs: number }
  consumers: {
    transferChunkBytes: number
    pageRecords: number
    pageBytes: number
    residentBytes: number
    pendingWindowBytes: number
    exportOverlapBytes: number
    graphifyStageBytes: number
  }
  /** Derived concurrency ceiling for descriptors held by admitted main-owned operations. */
  maxHeldRoots: number
  derived: { physicalRecordBytes: number; canonicalTotalBytes: number; journalBytes: number; stagingBytes: number }
  qualification: { state: QualificationState; reportSha256: string | null }
}

export interface ProfileCatalog {
  schema: 'metis-persistence-profiles/v1'
  catalogVersion: 1
  profiles: PersistenceProfile[]
}

export interface ImplementationInventoryEntry {
  path: string
  contentSha256: string
  provenance: 'source' | 'dependency' | 'native' | 'build-contract'
}

export interface ImplementationInventory {
  schema: 'metis-persistence-implementation-inventory/v1'
  sourceCommit: string
  entries: ImplementationInventoryEntry[]
}

export interface QaPersistenceCandidateManifest {
  schema: 'metis-persistence-qa-candidate/v1'
  purpose: 'isolated-persistence-qualification'
  sourceCommit: string
  implementationInventorySha256: string
  proposedCatalogSha256: string
  profileId: string
  profileMeasurementSha256: string
  caseRosterSha256: string
  qaIdentity: { appId: 'com.mantu.asktoto.qa'; appName: 'asktoto-qa' }
  runtimes: Array<{
    platform: RuntimePlatform
    arch: 'x64' | 'arm64'
    node: string
    v8: string
    modules: string
    electron: string
  }>
}

export interface QaPersistenceCaseRoster {
  schema: 'metis-persistence-qa-case-roster/v1'
  cases: string[]
}

export interface EnterpriseRestriction {
  issuer: string
  subject: string
  purpose: 'persistence-resource-policy'
  version: number
  epoch: number
  notBefore: number
  expiresAt: number
  allowedProfileIds: string[]
  retention: boolean
  providers: string[]
  publication: boolean
}

export const MAX_PROFILE_CATALOG_BYTES = 65_536
export const MAX_QA_CANDIDATE_MANIFEST_BYTES = 65_536
export const MAX_QA_CASE_ROSTER_BYTES = 16_384
export const MAX_IMPLEMENTATION_INVENTORY_BYTES = 262_144
export const MAX_IMPLEMENTATION_INVENTORY_ENTRIES = 256
export const MAX_IMPLEMENTATION_INVENTORY_ENTRY_PATH_BYTES = 240
export const PROFILE_ID_RE = /^[a-z][a-z0-9-]{0,47}$/
export const SHA_RE = /^[a-f0-9]{64}$/
export const SOURCE_RE = /^[a-f0-9]{40}$/
const SUPPORTED_TARGETS = new Set(['win32/x64', 'darwin/x64', 'darwin/arm64', 'linux/x64'])

const SAFE_MAX = Number.MAX_SAFE_INTEGER
const PROFILE_MEASUREMENT_DOMAIN = 'metis-persistence-profile-measurement/v2\n'
const IMPLEMENTATION_INVENTORY_DOMAIN = 'metis-persistence-implementation-inventory/v1\n'
const QA_CASE_ROSTER_DOMAIN = 'metis-persistence-qa-case-roster/v1\n'

function compareTarget(left: { platform: string; arch: string }, right: { platform: string; arch: string }): number {
  const leftKey = `${left.platform}/${left.arch}`
  const rightKey = `${right.platform}/${right.arch}`
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return false
  return Object.getOwnPropertySymbols(value).length === 0
}

export function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort()
  return keys.length === expected.length && keys.every((key, index) => key === [...expected].sort()[index])
}

export function positiveInt(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0
}

function add(...values: number[]): number {
  let total = 0
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value < 0 || total > SAFE_MAX - value) throw new Error('overflow')
    total += value
  }
  return total
}

function multiply(left: number, right: number): number {
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right) || left < 0 || right < 0) throw new Error('overflow')
  if (left !== 0 && right > Math.floor(SAFE_MAX / left)) throw new Error('overflow')
  return left * right
}

export function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

export function validString(value: unknown, max = 160): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && value.trim() === value
}

export function profileDigest(profile: PersistenceProfile): string {
  return persistenceProfileDigest(profile)
}

/** Frozen v1 report identity; do not reuse for the v2 measurement identity. */
export function qualificationReportProfileDigestV1(profile: PersistenceProfile): string {
  const { qualification: _qualification, derived: _derived, ...core } = profile
  return sha256(canonical(core))
}

export function persistenceProfileDigest(profile: PersistenceProfile): string {
  let recomputed: PersistenceProfile['derived']
  try {
    recomputed = derive(profile)
  } catch {
    throw new Error('Persistence profile bounds are invalid')
  }
  if (canonical(recomputed) !== canonical(profile.derived)) throw new Error('Persistence derived bounds do not match')
  const semantic = {
    schema: 'metis-persistence-profile-measurement/v2',
    id: profile.id,
    supported: {
      targets: [...profile.supported.targets].map((target) => ({ ...target })).sort(compareTarget)
    },
    implementationSha256: profile.implementationSha256,
    speech: profile.speech,
    legacy: profile.legacy,
    journal: profile.journal,
    worker: profile.worker,
    consumers: profile.consumers,
    maxHeldRoots: profile.maxHeldRoots
  }
  return sha256(`${PROFILE_MEASUREMENT_DOMAIN}${canonical(semantic)}`)
}

export function implementationInventoryDigest(inventory: ImplementationInventory): string {
  return sha256(`${IMPLEMENTATION_INVENTORY_DOMAIN}${canonical(inventory)}`)
}

export function parseImplementationInventory(
  bytes: Uint8Array,
  expectedSourceCommit?: string
): { inventory: ImplementationInventory; digest: string } | null {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > MAX_IMPLEMENTATION_INVENTORY_BYTES)
    return null
  try {
    const parsed = strictJson(bytes, MAX_IMPLEMENTATION_INVENTORY_BYTES)
    if (!isRecord(parsed) || !exactKeys(parsed, ['schema', 'sourceCommit', 'entries'])) return null
    if (
      parsed.schema !== 'metis-persistence-implementation-inventory/v1' ||
      !SOURCE_RE.test(String(parsed.sourceCommit))
    )
      return null
    if (expectedSourceCommit !== undefined && parsed.sourceCommit !== expectedSourceCommit) return null
    if (
      !Array.isArray(parsed.entries) ||
      parsed.entries.length === 0 ||
      parsed.entries.length > MAX_IMPLEMENTATION_INVENTORY_ENTRIES
    )
      return null
    let previousPath = ''
    const entries: ImplementationInventoryEntry[] = []
    for (const item of parsed.entries) {
      if (!isRecord(item) || !exactKeys(item, ['path', 'contentSha256', 'provenance'])) return null
      if (
        typeof item.path !== 'string' ||
        item.path.length === 0 ||
        item.path.trim() !== item.path ||
        Buffer.byteLength(item.path, 'utf8') > MAX_IMPLEMENTATION_INVENTORY_ENTRY_PATH_BYTES ||
        /[\u0000-\u001f\u007f]/.test(item.path) ||
        /^[a-zA-Z]:/.test(item.path) ||
        item.path.startsWith('/') ||
        item.path.includes('\\') ||
        item.path.split('/').some((part) => !part || part === '.' || part === '..') ||
        item.path <= previousPath ||
        typeof item.contentSha256 !== 'string' ||
        !SHA_RE.test(item.contentSha256) ||
        !['source', 'dependency', 'native', 'build-contract'].includes(String(item.provenance))
      )
        return null
      previousPath = item.path
      entries.push({
        path: item.path,
        contentSha256: item.contentSha256,
        provenance: item.provenance as ImplementationInventoryEntry['provenance']
      })
    }
    const inventory: ImplementationInventory = {
      schema: 'metis-persistence-implementation-inventory/v1',
      sourceCommit: parsed.sourceCommit as string,
      entries
    }
    return { inventory, digest: implementationInventoryDigest(inventory) }
  } catch {
    return null
  }
}

export function parseQaPersistenceCandidateManifest(
  bytes: Uint8Array,
  expectedSourceCommit?: string
): QaPersistenceCandidateManifest | null {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > MAX_QA_CANDIDATE_MANIFEST_BYTES)
    return null
  try {
    const value = strictJson(bytes, MAX_QA_CANDIDATE_MANIFEST_BYTES)
    if (
      !isRecord(value) ||
      !exactKeys(value, [
        'schema',
        'purpose',
        'sourceCommit',
        'implementationInventorySha256',
        'proposedCatalogSha256',
        'profileId',
        'profileMeasurementSha256',
        'caseRosterSha256',
        'qaIdentity',
        'runtimes'
      ]) ||
      value.schema !== 'metis-persistence-qa-candidate/v1' ||
      value.purpose !== 'isolated-persistence-qualification' ||
      !SOURCE_RE.test(String(value.sourceCommit)) ||
      (expectedSourceCommit !== undefined && value.sourceCommit !== expectedSourceCommit) ||
      !SHA_RE.test(String(value.implementationInventorySha256)) ||
      !SHA_RE.test(String(value.proposedCatalogSha256)) ||
      !PROFILE_ID_RE.test(String(value.profileId)) ||
      !SHA_RE.test(String(value.profileMeasurementSha256)) ||
      !SHA_RE.test(String(value.caseRosterSha256))
    )
      return null
    if (
      !isRecord(value.qaIdentity) ||
      !exactKeys(value.qaIdentity, ['appId', 'appName']) ||
      value.qaIdentity.appId !== 'com.mantu.asktoto.qa' ||
      value.qaIdentity.appName !== 'asktoto-qa' ||
      !Array.isArray(value.runtimes) ||
      value.runtimes.length === 0 ||
      value.runtimes.length > 4
    )
      return null
    const targets = new Set<string>()
    const runtimes: QaPersistenceCandidateManifest['runtimes'] = []
    for (const item of value.runtimes) {
      if (
        !isRecord(item) ||
        !exactKeys(item, ['platform', 'arch', 'node', 'v8', 'modules', 'electron']) ||
        !['win32', 'darwin', 'linux'].includes(String(item.platform)) ||
        !['x64', 'arm64'].includes(String(item.arch)) ||
        !validString(item.node, 32) ||
        !validString(item.v8, 32) ||
        !validString(item.modules, 32) ||
        !validString(item.electron, 32)
      )
        return null
      const platform = item.platform as RuntimePlatform
      const arch = item.arch as 'x64' | 'arm64'
      const target = `${platform}/${arch}`
      if (!SUPPORTED_TARGETS.has(target) || targets.has(target)) return null
      targets.add(target)
      runtimes.push({
        platform,
        arch,
        node: item.node,
        v8: item.v8,
        modules: item.modules,
        electron: item.electron
      })
    }
    return {
      schema: 'metis-persistence-qa-candidate/v1',
      purpose: 'isolated-persistence-qualification',
      sourceCommit: value.sourceCommit as string,
      implementationInventorySha256: value.implementationInventorySha256 as string,
      proposedCatalogSha256: value.proposedCatalogSha256 as string,
      profileId: value.profileId as string,
      profileMeasurementSha256: value.profileMeasurementSha256 as string,
      caseRosterSha256: value.caseRosterSha256 as string,
      qaIdentity: { appId: 'com.mantu.asktoto.qa', appName: 'asktoto-qa' },
      runtimes
    }
  } catch {
    return null
  }
}

export function parseQaPersistenceCaseRoster(
  bytes: Uint8Array
): { roster: QaPersistenceCaseRoster; digest: string } | null {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > MAX_QA_CASE_ROSTER_BYTES)
    return null
  try {
    const value = strictJson(bytes, MAX_QA_CASE_ROSTER_BYTES)
    if (
      !isRecord(value) ||
      !exactKeys(value, ['schema', 'cases']) ||
      value.schema !== 'metis-persistence-qa-case-roster/v1' ||
      !Array.isArray(value.cases) ||
      value.cases.length === 0 ||
      value.cases.length > 128
    )
      return null
    let previous = ''
    const cases: string[] = []
    for (const item of value.cases) {
      if (typeof item !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(item) || item <= previous) return null
      previous = item
      cases.push(item)
    }
    const roster: QaPersistenceCaseRoster = { schema: 'metis-persistence-qa-case-roster/v1', cases }
    return { roster, digest: sha256(`${QA_CASE_ROSTER_DOMAIN}${canonical(roster)}`) }
  } catch {
    return null
  }
}

export function verifyQaPersistenceCandidateBundle(input: {
  catalogBytes: Uint8Array
  inventoryBytes: Uint8Array
  caseRosterBytes: Uint8Array
  manifestBytes: Uint8Array
}): {
  manifest: QaPersistenceCandidateManifest
  catalogDigest: string
  implementationDigest: string
  profileMeasurementDigest: string
} | null {
  const catalog = parseProfileCatalog(input.catalogBytes)
  const manifest = parseQaPersistenceCandidateManifest(input.manifestBytes)
  const inventory = parseImplementationInventory(input.inventoryBytes, manifest?.sourceCommit)
  const roster = parseQaPersistenceCaseRoster(input.caseRosterBytes)
  if (!catalog || !manifest || !inventory || !roster) return null
  const profile = catalog.catalog.profiles.find((candidate) => candidate.id === manifest.profileId)
  if (
    !profile ||
    profile.evidence !== 'PROPOSED' ||
    profile.qualification.state !== 'PROPOSED' ||
    profile.qualification.reportSha256 !== null ||
    profile.implementationSha256 !== inventory.digest ||
    catalog.digest !== manifest.proposedCatalogSha256 ||
    inventory.digest !== manifest.implementationInventorySha256 ||
    roster.digest !== manifest.caseRosterSha256
  )
    return null
  const profileMeasurementDigest = persistenceProfileDigest(profile)
  if (profileMeasurementDigest !== manifest.profileMeasurementSha256) return null
  const profileRuntimes = [...profile.supported.targets].map((target) => ({ ...target })).sort(compareTarget)
  const manifestRuntimes = [...manifest.runtimes].map((target) => ({ ...target })).sort(compareTarget)
  if (canonical(profileRuntimes) !== canonical(manifestRuntimes)) return null
  return {
    manifest,
    catalogDigest: catalog.digest,
    implementationDigest: inventory.digest,
    profileMeasurementDigest
  }
}

export function qualificationReportDigest(reportBytes: Uint8Array): string {
  return sha256(reportBytes)
}

function derive(profile: PersistenceProfile): PersistenceProfile['derived'] {
  const physicalRecordBytes = add(profile.speech.maxRecordBytes, 40, 4, profile.journal.recordMetadataBytes)
  const canonicalTotalBytes = add(
    profile.speech.maxPayloadBytes,
    multiply(profile.speech.maxRecords, profile.journal.canonicalWrapperBytes)
  )
  const journalBytes = add(
    canonicalTotalBytes,
    multiply(
      profile.speech.maxRecords,
      add(40, 4, profile.journal.recordMetadataBytes, profile.journal.indexEntryBytes)
    ),
    profile.journal.manifestBytes
  )
  const stagingBytes = add(
    profile.legacy.physicalBytes,
    multiply(journalBytes, 2),
    profile.speech.maxPayloadBytes,
    profile.consumers.pendingWindowBytes,
    profile.consumers.exportOverlapBytes,
    profile.consumers.graphifyStageBytes
  )
  return { physicalRecordBytes, canonicalTotalBytes, journalBytes, stagingBytes }
}

function validProfile(value: unknown): value is PersistenceProfile {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      'id',
      'label',
      'evidence',
      'supported',
      'implementationSha256',
      'speech',
      'legacy',
      'journal',
      'worker',
      'consumers',
      'maxHeldRoots',
      'derived',
      'qualification'
    ])
  )
    return false
  if (!validString(value.id, 48) || !PROFILE_ID_RE.test(value.id) || !validString(value.label, 64)) return false
  if (value.evidence !== 'PROPOSED' && value.evidence !== 'MEASURED') return false
  const supported = value.supported
  if (!isRecord(supported) || !exactKeys(supported, ['targets'])) return false
  if (!Array.isArray(supported.targets) || supported.targets.length === 0 || supported.targets.length > 12) return false
  const targetKeys = new Set<string>()
  for (const target of supported.targets) {
    if (!isRecord(target) || !exactKeys(target, ['platform', 'arch', 'node', 'v8', 'modules', 'electron'])) return false
    if (
      !['win32', 'darwin', 'linux'].includes(String(target.platform)) ||
      !['x64', 'arm64'].includes(String(target.arch))
    )
      return false
    const targetKey = `${target.platform}/${target.arch}`
    if (!SUPPORTED_TARGETS.has(targetKey)) return false
    if (targetKeys.has(targetKey)) return false
    targetKeys.add(targetKey)
    if (
      (target.node !== null && !validString(target.node, 32)) ||
      (target.v8 !== null && !validString(target.v8, 32)) ||
      (target.modules !== null && !validString(target.modules, 32))
    )
      return false
    if (target.electron !== '43.6.0') return false
  }
  if (
    value.implementationSha256 !== null &&
    (typeof value.implementationSha256 !== 'string' || !SHA_RE.test(value.implementationSha256))
  )
    return false
  const groups: Array<[unknown, readonly string[]]> = [
    [value.speech, ['maxRecords', 'maxWords', 'maxFieldBytes', 'maxRecordBytes', 'maxPayloadBytes']],
    [value.legacy, ['decodedBytes', 'physicalBytes', 'descriptorBytes']],
    [value.journal, ['recordMetadataBytes', 'canonicalWrapperBytes', 'indexEntryBytes', 'manifestBytes']],
    [value.worker, ['inputBytes', 'outputBytes', 'operationDeadlineMs', 'shutdownDeadlineMs']],
    [
      value.consumers,
      [
        'transferChunkBytes',
        'pageRecords',
        'pageBytes',
        'residentBytes',
        'pendingWindowBytes',
        'exportOverlapBytes',
        'graphifyStageBytes'
      ]
    ],
    [value.derived, ['physicalRecordBytes', 'canonicalTotalBytes', 'journalBytes', 'stagingBytes']],
    [value.qualification, ['state', 'reportSha256']]
  ]
  if (
    !Number.isSafeInteger(value.maxHeldRoots) ||
    (value.maxHeldRoots as number) < 1 ||
    (value.maxHeldRoots as number) > 8
  )
    return false
  for (const [group, keys] of groups) if (!isRecord(group) || !exactKeys(group, keys)) return false
  for (const key of ['maxRecords', 'maxWords', 'maxFieldBytes', 'maxRecordBytes', 'maxPayloadBytes'])
    if (!positiveInt((value.speech as Record<string, unknown>)[key])) return false
  for (const key of ['decodedBytes', 'physicalBytes', 'descriptorBytes'])
    if (!positiveInt((value.legacy as Record<string, unknown>)[key])) return false
  for (const key of ['recordMetadataBytes', 'canonicalWrapperBytes', 'indexEntryBytes', 'manifestBytes'])
    if (!positiveInt((value.journal as Record<string, unknown>)[key])) return false
  for (const key of ['inputBytes', 'outputBytes', 'operationDeadlineMs', 'shutdownDeadlineMs'])
    if (!positiveInt((value.worker as Record<string, unknown>)[key])) return false
  for (const key of [
    'transferChunkBytes',
    'pageRecords',
    'pageBytes',
    'residentBytes',
    'pendingWindowBytes',
    'exportOverlapBytes',
    'graphifyStageBytes'
  ])
    if (!positiveInt((value.consumers as Record<string, unknown>)[key])) return false
  for (const key of ['physicalRecordBytes', 'canonicalTotalBytes', 'journalBytes', 'stagingBytes'])
    if (!positiveInt((value.derived as Record<string, unknown>)[key])) return false
  const qualification = value.qualification as Record<string, unknown>
  if (qualification.state !== 'PROPOSED' && qualification.state !== 'QUALIFIED') return false
  if (
    qualification.reportSha256 !== null &&
    (typeof qualification.reportSha256 !== 'string' || !SHA_RE.test(qualification.reportSha256))
  )
    return false
  try {
    const computed = derive(value as unknown as PersistenceProfile)
    if (canonical(computed) !== canonical(value.derived)) return false
  } catch {
    return false
  }
  const p = value as unknown as PersistenceProfile
  return (
    p.speech.maxFieldBytes <= p.speech.maxRecordBytes &&
    p.speech.maxRecordBytes <= p.worker.inputBytes &&
    p.speech.maxRecordBytes <= p.worker.outputBytes &&
    p.consumers.transferChunkBytes <= p.consumers.pageBytes &&
    p.consumers.pageBytes <= p.worker.inputBytes &&
    p.consumers.pageRecords <= p.speech.maxRecords &&
    p.speech.maxPayloadBytes <= p.legacy.decodedBytes &&
    p.derived.physicalRecordBytes <= p.worker.inputBytes &&
    p.derived.physicalRecordBytes <= p.legacy.decodedBytes &&
    p.derived.journalBytes <= p.derived.stagingBytes &&
    p.consumers.pendingWindowBytes <= p.consumers.residentBytes &&
    p.worker.inputBytes <= p.consumers.residentBytes - p.worker.outputBytes - p.consumers.transferChunkBytes &&
    p.legacy.decodedBytes <= p.legacy.physicalBytes &&
    p.worker.shutdownDeadlineMs <= p.worker.operationDeadlineMs &&
    (p.qualification.state === 'PROPOSED'
      ? p.qualification.reportSha256 === null && p.evidence === 'PROPOSED'
      : p.qualification.reportSha256 !== null &&
        p.evidence === 'MEASURED' &&
        p.supported.targets.every((target) => target.node !== null && target.v8 !== null && target.modules !== null) &&
        p.implementationSha256 !== null)
  )
}

export function parseProfileCatalog(bytes: Uint8Array): { catalog: ProfileCatalog; digest: string } | null {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > MAX_PROFILE_CATALOG_BYTES)
    return null
  try {
    const parsed = strictJson(bytes, MAX_PROFILE_CATALOG_BYTES)
    if (!isRecord(parsed) || !exactKeys(parsed, ['schema', 'catalogVersion', 'profiles'])) return null
    if (
      parsed.schema !== 'metis-persistence-profiles/v1' ||
      parsed.catalogVersion !== 1 ||
      !Array.isArray(parsed.profiles) ||
      parsed.profiles.length < 1 ||
      parsed.profiles.length > 16
    )
      return null
    if (!parsed.profiles.every(validProfile)) return null
    const profiles = parsed.profiles as PersistenceProfile[]
    const ids = profiles.map((profile) => profile.id)
    if (!ids.includes('standard') || new Set(ids).size !== ids.length) return null
    return { catalog: parsed as unknown as ProfileCatalog, digest: sha256(bytes) }
  } catch {
    return null
  }
}

export function strictJson(bytes: Uint8Array, maxBytes: number): unknown | null {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > maxBytes) return null
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    if (Buffer.from(text, 'utf8').byteLength !== bytes.byteLength) return null
    if (hasDuplicateObjectKeys(text)) return null
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

function hasDuplicateObjectKeys(text: string): boolean {
  let offset = 0
  const whitespace = () => {
    while (offset < text.length && /\s/.test(text[offset]!)) offset += 1
  }
  const stringEnd = (): string | null => {
    const start = offset
    if (text[offset] !== '"') return null
    offset += 1
    while (offset < text.length) {
      const character = text[offset++]!
      if (character === '"') {
        try {
          return JSON.parse(text.slice(start, offset)) as string
        } catch {
          return null
        }
      }
      if (character === '\\') {
        if (offset >= text.length) return null
        offset += 1
      }
    }
    return null
  }
  const parseValue = (depth: number): boolean => {
    if (depth > 64) return false
    whitespace()
    const opening = text[offset]
    if (opening === '{') {
      offset += 1
      whitespace()
      if (text[offset] === '}') {
        offset += 1
        return true
      }
      const keys = new Set<string>()
      while (offset < text.length) {
        whitespace()
        const key = stringEnd()
        if (key === null || keys.has(key)) return false
        keys.add(key)
        whitespace()
        if (text[offset++] !== ':') return false
        if (!parseValue(depth + 1)) return false
        whitespace()
        const delimiter = text[offset++]
        if (delimiter === '}') return true
        if (delimiter !== ',') return false
      }
      return false
    }
    if (opening === '[') {
      offset += 1
      whitespace()
      if (text[offset] === ']') {
        offset += 1
        return true
      }
      while (offset < text.length) {
        if (!parseValue(depth + 1)) return false
        whitespace()
        const delimiter = text[offset++]
        if (delimiter === ']') return true
        if (delimiter !== ',') return false
      }
      return false
    }
    if (opening === '"') return stringEnd() !== null
    const start = offset
    while (offset < text.length && !/[\s,\[\]{}]/.test(text[offset]!)) offset += 1
    return offset > start
  }
  if (!parseValue(0)) return true
  whitespace()
  return offset !== text.length
}
