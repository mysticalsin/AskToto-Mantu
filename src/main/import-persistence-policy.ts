import type { SpeechProvenanceLimits } from '@shared/meeting-speech-contract'
import type { MeetingSpeechServiceBounds } from './infra/process/meeting-speech-host'

export type ImportPersistenceConfigField =
  | 'revision'
  | 'ownerAuthority'
  | 'legacyOwnershipProof'
  | 'rootCapability'
  | 'protectedKeyProvider'
  | 'speech.maxRecords'
  | 'speech.maxWords'
  | 'speech.maxFieldBytes'
  | 'speech.maxRecordBytes'
  | 'speech.maxPayloadBytes'
  | 'legacy.maxPhysicalBytes'
  | 'legacy.maxDecodedBytes'
  | 'legacy.maxDescriptorBytes'
  | 'legacy.maxChunkBytes'
  | 'legacy.maxResidentBytes'
  | 'legacy.maxStagingBytes'
  | 'legacy.operationDeadlineMs'
  | 'legacy.shutdownDeadlineMs'
  | 'legacy.nativeV1'
  | 'journal.maxJournalBytes'
  | 'journal.maxPhysicalRecordBytes'
  | 'journal.maxChunkBytes'
  | 'journal.maxPageRecords'
  | 'journal.maxPageBytes'
  | 'worker.maxInputBytes'
  | 'worker.maxOutputBytes'
  | 'worker.operationDeadlineMs'
  | 'worker.shutdownDeadlineMs'
  | 'consumers.maxPublicExportBytes'
  | 'consumers.maxRecapInputBytes'
  | 'consumers.maxRecapOutputBytes'

const capabilityBrand: unique symbol = Symbol('import-persistence-capability')
export type ImportPersistenceCapabilityKind =
  | 'ownerAuthority'
  | 'legacyOwnershipProof'
  | 'rootCapability'
  | 'protectedKeyProvider'
export type ImportPersistenceCapability<K extends ImportPersistenceCapabilityKind> = {
  readonly [capabilityBrand]: K
}

export interface ImportPersistenceCapabilities {
  ownerAuthority?: ImportPersistenceCapability<'ownerAuthority'>
  legacyOwnershipProof?: ImportPersistenceCapability<'legacyOwnershipProof'>
  rootCapability?: ImportPersistenceCapability<'rootCapability'>
  protectedKeyProvider?: ImportPersistenceCapability<'protectedKeyProvider'>
}

const capabilityKinds = new WeakMap<object, ImportPersistenceCapabilityKind>()
const CAPABILITY_KINDS: readonly ImportPersistenceCapabilityKind[] = [
  'ownerAuthority',
  'rootCapability',
  'protectedKeyProvider'
]

/** Main-process adapters mint a capability only after verifying that prerequisite's real authority. */
export function createImportPersistenceCapabilityIssuer(
  verify: (kind: ImportPersistenceCapabilityKind) => boolean | Promise<boolean>
) {
  return async (): Promise<ImportPersistenceCapabilities | undefined> => {
    const values: Partial<Record<ImportPersistenceCapabilityKind, object>> = {}
    for (const kind of CAPABILITY_KINDS) {
      if (!(await verify(kind))) return undefined
      const handle = Object.freeze({ [capabilityBrand]: kind })
      capabilityKinds.set(handle, kind)
      values[kind] = handle
    }
    return values as ImportPersistenceCapabilities
  }
}

export interface ImportPersistencePolicyInput extends ImportPersistenceCapabilities {
  revision?: string
  speech?: SpeechProvenanceLimits
  legacy?: {
    maxPhysicalBytes?: number
    maxDecodedBytes?: number
    maxDescriptorBytes?: number
    maxChunkBytes?: number
    maxResidentBytes?: number
    maxStagingBytes?: number
    operationDeadlineMs?: number
    shutdownDeadlineMs?: number
    nativeV1?:
      | { unavailable: true }
      | { maxCiphertextBytes: number; maxPlaintextBytes: number; allocationProfileId: string }
  }
  journal?: {
    maxJournalBytes?: number
    maxPhysicalRecordBytes?: number
    maxChunkBytes?: number
    maxPageRecords?: number
    maxPageBytes?: number
  }
  worker?: MeetingSpeechServiceBounds
  consumers?: {
    maxPublicExportBytes?: number
    maxRecapInputBytes?: number
    maxRecapOutputBytes?: number
  }
}

export interface ImportPersistencePolicy {
  readonly revision: string
  readonly speech: Readonly<SpeechProvenanceLimits>
  readonly legacy: Readonly<{
    maxPhysicalBytes: number
    maxDecodedBytes: number
    maxDescriptorBytes: number
    maxChunkBytes: number
    maxResidentBytes: number
    maxStagingBytes: number
    operationDeadlineMs: number
    shutdownDeadlineMs: number
    nativeV1:
      | { readonly unavailable: true }
      | {
          readonly maxCiphertextBytes: number
          readonly maxPlaintextBytes: number
          readonly allocationProfileId: string
        }
  }>
  readonly journal: Readonly<{
    maxJournalBytes: number
    maxPhysicalRecordBytes: number
    maxChunkBytes: number
    maxPageRecords: number
    maxPageBytes: number
  }>
  readonly worker: Readonly<MeetingSpeechServiceBounds>
  readonly consumers: Readonly<{
    maxPublicExportBytes: number
    maxRecapInputBytes: number
    maxRecapOutputBytes: number
  }>
}

export type ImportPersistencePolicyResult =
  | { readonly status: 'configured'; readonly policy: ImportPersistencePolicy }
  | { readonly status: 'unconfigured'; readonly missing: readonly ImportPersistenceConfigField[] }
  | { readonly status: 'invalid'; readonly reason: 'INVALID_POLICY' }

const REQUIRED_FIELDS: readonly ImportPersistenceConfigField[] = Object.freeze([
  'revision',
  'ownerAuthority',
  'rootCapability',
  'protectedKeyProvider',
  'speech.maxRecords',
  'speech.maxWords',
  'speech.maxFieldBytes',
  'speech.maxRecordBytes',
  'speech.maxPayloadBytes',
  'legacy.maxPhysicalBytes',
  'legacy.maxDecodedBytes',
  'legacy.maxDescriptorBytes',
  'legacy.maxChunkBytes',
  'legacy.maxResidentBytes',
  'legacy.maxStagingBytes',
  'legacy.operationDeadlineMs',
  'legacy.shutdownDeadlineMs',
  'legacy.nativeV1',
  'journal.maxJournalBytes',
  'journal.maxPhysicalRecordBytes',
  'journal.maxChunkBytes',
  'journal.maxPageRecords',
  'journal.maxPageBytes',
  'worker.maxInputBytes',
  'worker.maxOutputBytes',
  'worker.operationDeadlineMs',
  'worker.shutdownDeadlineMs',
  'consumers.maxPublicExportBytes',
  'consumers.maxRecapInputBytes',
  'consumers.maxRecapOutputBytes'
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function hasCapability(value: unknown, kind: ImportPersistenceCapabilityKind): value is object {
  return typeof value === 'object' && value !== null && capabilityKinds.get(value) === kind
}

function field(input: ImportPersistencePolicyInput, path: ImportPersistenceConfigField): unknown {
  switch (path) {
    case 'revision':
      return input.revision
    case 'ownerAuthority':
    case 'legacyOwnershipProof':
    case 'rootCapability':
    case 'protectedKeyProvider':
      return input[path]
    default: {
      const [group, key] = path.split('.') as [string, string]
      const value = (input as unknown as Record<string, unknown>)[group]
      return isRecord(value) ? value[key] : undefined
    }
  }
}

function missingFields(input: ImportPersistencePolicyInput): ImportPersistenceConfigField[] {
  return REQUIRED_FIELDS.filter((path) => {
    const value = field(input, path)
    if (path === 'revision') return value === undefined
    if (path === 'legacy.nativeV1') return value === undefined
    if (path === 'ownerAuthority' || path === 'rootCapability' || path === 'protectedKeyProvider') {
      return !hasCapability(value, path)
    }
    return value === undefined
  })
}

function validNativeV1(value: unknown): value is NonNullable<ImportPersistencePolicyInput['legacy']>['nativeV1'] {
  if (!isRecord(value)) return false
  if (Object.keys(value).length === 1 && value.unavailable === true) return true
  return (
    Object.keys(value).sort().join(',') === 'allocationProfileId,maxCiphertextBytes,maxPlaintextBytes' &&
    positiveSafeInteger(value.maxCiphertextBytes) &&
    positiveSafeInteger(value.maxPlaintextBytes) &&
    typeof value.allocationProfileId === 'string' &&
    value.allocationProfileId.length > 0 &&
    Buffer.byteLength(value.allocationProfileId, 'utf8') <= 128
  )
}

function exactKeys(value: object, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(',') === [...keys].sort().join(',')
}

function validRevision(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= 128
}

function validInput(input: ImportPersistencePolicyInput): boolean {
  const { speech, legacy, journal, worker, consumers } = input
  if (!validRevision(input.revision) || !speech || !legacy || !journal || !worker || !consumers) return false
  if (
    !exactKeys(input, [
      'revision',
      'ownerAuthority',
      'rootCapability',
      'protectedKeyProvider',
      'speech',
      'legacy',
      'journal',
      'worker',
      'consumers'
    ]) ||
    !exactKeys(speech, ['maxRecords', 'maxWords', 'maxFieldBytes', 'maxRecordBytes', 'maxPayloadBytes']) ||
    !exactKeys(legacy, [
      'maxPhysicalBytes',
      'maxDecodedBytes',
      'maxDescriptorBytes',
      'maxChunkBytes',
      'maxResidentBytes',
      'maxStagingBytes',
      'operationDeadlineMs',
      'shutdownDeadlineMs',
      'nativeV1'
    ]) ||
    !exactKeys(journal, [
      'maxJournalBytes',
      'maxPhysicalRecordBytes',
      'maxChunkBytes',
      'maxPageRecords',
      'maxPageBytes'
    ]) ||
    !exactKeys(worker, ['maxInputBytes', 'maxOutputBytes', 'operationDeadlineMs', 'shutdownDeadlineMs']) ||
    !exactKeys(consumers, ['maxPublicExportBytes', 'maxRecapInputBytes', 'maxRecapOutputBytes'])
  ) {
    return false
  }
  if (!validNativeV1(legacy.nativeV1)) return false
  const numbers = [
    speech.maxRecords,
    speech.maxWords,
    speech.maxFieldBytes,
    speech.maxRecordBytes,
    speech.maxPayloadBytes,
    legacy.maxPhysicalBytes,
    legacy.maxDecodedBytes,
    legacy.maxDescriptorBytes,
    legacy.maxChunkBytes,
    legacy.maxResidentBytes,
    legacy.maxStagingBytes,
    legacy.operationDeadlineMs,
    legacy.shutdownDeadlineMs,
    journal.maxJournalBytes,
    journal.maxPhysicalRecordBytes,
    journal.maxChunkBytes,
    journal.maxPageRecords,
    journal.maxPageBytes,
    worker.maxInputBytes,
    worker.maxOutputBytes,
    worker.operationDeadlineMs,
    worker.shutdownDeadlineMs,
    consumers.maxPublicExportBytes,
    consumers.maxRecapInputBytes,
    consumers.maxRecapOutputBytes
  ]
  if (!numbers.every(positiveSafeInteger)) return false
  const legacyValues = legacy as Required<NonNullable<ImportPersistencePolicyInput['legacy']>>
  const journalValues = journal as Required<NonNullable<ImportPersistencePolicyInput['journal']>>
  const consumerValues = consumers as Required<NonNullable<ImportPersistencePolicyInput['consumers']>>
  if (
    speech.maxFieldBytes > speech.maxRecordBytes ||
    speech.maxRecordBytes > speech.maxPayloadBytes ||
    legacyValues.maxChunkBytes > legacyValues.maxDecodedBytes ||
    legacyValues.maxChunkBytes > legacyValues.maxResidentBytes ||
    worker.maxInputBytes > legacyValues.maxResidentBytes ||
    worker.maxOutputBytes > legacyValues.maxResidentBytes ||
    journalValues.maxPhysicalRecordBytes > journalValues.maxJournalBytes ||
    journalValues.maxChunkBytes > journalValues.maxPhysicalRecordBytes ||
    journalValues.maxPageBytes > journalValues.maxJournalBytes ||
    legacyValues.maxPhysicalBytes > legacyValues.maxStagingBytes ||
    consumerValues.maxPublicExportBytes > legacyValues.maxStagingBytes
  ) {
    return false
  }
  if (
    !('unavailable' in legacyValues.nativeV1!) &&
    (legacyValues.nativeV1!.maxCiphertextBytes > legacyValues.maxPhysicalBytes ||
      legacyValues.nativeV1!.maxPlaintextBytes > legacyValues.maxDecodedBytes)
  ) {
    return false
  }
  return true
}

/** Validates only injected main-process authority and finite limits; it never supplies defaults. */
export function resolveImportPersistencePolicy(
  input: ImportPersistencePolicyInput | undefined
): ImportPersistencePolicyResult {
  if (!input) return { status: 'unconfigured', missing: REQUIRED_FIELDS }
  const missing = missingFields(input)
  if (missing.length) return { status: 'unconfigured', missing }
  if (!validInput(input)) return { status: 'invalid', reason: 'INVALID_POLICY' }
  return {
    status: 'configured',
    policy: Object.freeze({
      revision: input.revision!,
      speech: Object.freeze({ ...input.speech! }),
      legacy: Object.freeze({ ...input.legacy!, nativeV1: Object.freeze(input.legacy!.nativeV1!) }),
      journal: Object.freeze({ ...input.journal! }),
      worker: Object.freeze({ ...input.worker! }),
      consumers: Object.freeze({ ...input.consumers! })
    }) as ImportPersistencePolicy
  }
}

export function importPersistenceMissingReason(result: ImportPersistencePolicyResult): string | undefined {
  if (result.status === 'configured') return undefined
  return result.status === 'invalid' ? 'IMPORT_PERSISTENCE_INVALID_POLICY' : 'IMPORT_PERSISTENCE_UNCONFIGURED'
}
