import {
  MAX_BRAIN_CONTEXT_SOURCE_CHARS,
  MAX_BRAIN_CONTEXT_SOURCE_DATE_CHARS,
  MAX_BRAIN_CONTEXT_SOURCE_REFERENCES,
  MAX_CONTEXT_RECORDS,
  type BrainContextBuildResult,
  type BrainContextRecordFingerprint,
  type BrainContextSourceReference
} from './context'

export const BRAIN_CONTEXT_ENVELOPE_VERSION = 1 as const
export const BRAIN_CONTEXT_MAX_CHARS = 8_000
export const BRAIN_CONTEXT_MAX_SOURCES = MAX_BRAIN_CONTEXT_SOURCE_REFERENCES

export interface BrainContextOwner {
  authSessionGeneration: number
  contextRevision: number
  /** Monotonic brain index revision invalidates contexts after committed ingest/correction/refresh changes. */
  brainRevision: number
  /** SHA-256 digest of the selected local brain root; raw profile paths stay main-local. */
  profileKey: string
}

export type BrainContextEnvelopeStatus = 'ready' | 'empty' | 'stale' | 'unavailable'

export interface BrainContextEnvelope {
  version: typeof BRAIN_CONTEXT_ENVELOPE_VERSION
  status: BrainContextEnvelopeStatus
  owner: BrainContextOwner
  budget: { maxChars: typeof BRAIN_CONTEXT_MAX_CHARS; usedChars: number; maxSources: typeof BRAIN_CONTEXT_MAX_SOURCES }
  block?: string
  sourceReferences: BrainContextSourceReference[]
  /** Main-only local entity file fingerprints; never serialized to a provider or renderer. */
  recordFingerprints?: BrainContextRecordFingerprint[]
}

function validOwner(owner: BrainContextOwner): boolean {
  return !!owner && typeof owner === 'object' &&
    Number.isSafeInteger(owner.authSessionGeneration) && owner.authSessionGeneration >= 0 &&
    Number.isSafeInteger(owner.contextRevision) && owner.contextRevision >= 0 &&
    Number.isSafeInteger(owner.brainRevision) && owner.brainRevision >= 0 &&
    typeof owner.profileKey === 'string' && /^[a-f0-9]{64}$/.test(owner.profileKey)
}

function validSourceReference(ref: BrainContextSourceReference): boolean {
  return !!ref && typeof ref === 'object' && (ref.kind === 'meeting' || ref.kind === 'provenance') &&
    typeof ref.source === 'string' && ref.source.length > 0 && ref.source === ref.source.trim() &&
    ref.source.length <= MAX_BRAIN_CONTEXT_SOURCE_CHARS &&
    typeof ref.sourceRootId === 'string' && /^[a-f0-9]{64}$/.test(ref.sourceRootId) &&
    typeof ref.sourceDigest === 'string' && /^[a-f0-9]{64}$/.test(ref.sourceDigest) &&
    (ref.date === undefined || (typeof ref.date === 'string' && ref.date.length <= MAX_BRAIN_CONTEXT_SOURCE_DATE_CHARS))
}

function validRecordFingerprint(value: BrainContextRecordFingerprint): boolean {
  return !!value && typeof value === 'object' &&
    (value.kind === 'person' || value.kind === 'account' || value.kind === 'deal') &&
    typeof value.slug === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.slug) &&
    typeof value.digest === 'string' && /^[a-f0-9]{64}$/.test(value.digest)
}

/** Create a versioned, bounded envelope. It contains only local metadata; callers expose the block solely
 * to the existing main-process provider prompt path after a fresh owner comparison. */
export function createBrainContextEnvelope(owner: BrainContextOwner, result: BrainContextBuildResult): BrainContextEnvelope {
  if (!validOwner(owner)) return unavailableBrainContextEnvelope(owner)
  if (!result.sourceReferencesComplete || result.sourceReferences.length > BRAIN_CONTEXT_MAX_SOURCES ||
      !result.sourceReferences.every(validSourceReference) || typeof result.block !== 'string' || result.block.length > BRAIN_CONTEXT_MAX_CHARS ||
      result.recordFingerprintsComplete === false ||
      (result.recordFingerprints !== undefined &&
        (result.recordFingerprints.length > MAX_CONTEXT_RECORDS || !result.recordFingerprints.every(validRecordFingerprint)))) {
    return unavailableBrainContextEnvelope(owner)
  }
  const sourceReferences = result.sourceReferences.slice()
  const block = result.block
  const ready = result.matched && block.length > 0
  return {
    version: BRAIN_CONTEXT_ENVELOPE_VERSION,
    status: ready ? 'ready' : 'empty',
    owner: { ...owner },
    budget: { maxChars: BRAIN_CONTEXT_MAX_CHARS, usedChars: ready ? block.length : 0, maxSources: BRAIN_CONTEXT_MAX_SOURCES },
    ...(ready ? { block } : {}),
    sourceReferences: ready ? sourceReferences : [],
    ...(ready && result.recordFingerprints ? { recordFingerprints: result.recordFingerprints.map((entry) => ({ ...entry })) } : {})
  }
}

export function unavailableBrainContextEnvelope(owner: BrainContextOwner): BrainContextEnvelope {
  return {
    version: BRAIN_CONTEXT_ENVELOPE_VERSION,
    status: 'unavailable',
    owner: { ...owner },
    budget: { maxChars: BRAIN_CONTEXT_MAX_CHARS, usedChars: 0, maxSources: BRAIN_CONTEXT_MAX_SOURCES },
    sourceReferences: [],
    recordFingerprints: []
  }
}

/** Returns true only for a well-formed ready/empty envelope owned by the current auth/profile context. */
export function isBrainContextEnvelopeCurrent(envelope: BrainContextEnvelope, current: BrainContextOwner): boolean {
  if (!envelope || typeof envelope !== 'object') return false
  if (envelope.version !== BRAIN_CONTEXT_ENVELOPE_VERSION || !validOwner(envelope.owner) || !validOwner(current)) return false
  if (envelope.owner.authSessionGeneration !== current.authSessionGeneration ||
      envelope.owner.contextRevision !== current.contextRevision || envelope.owner.brainRevision !== current.brainRevision ||
      envelope.owner.profileKey !== current.profileKey) return false
  if (!envelope.budget || typeof envelope.budget !== 'object' || !Array.isArray(envelope.sourceReferences) ||
      (envelope.recordFingerprints !== undefined &&
        (!Array.isArray(envelope.recordFingerprints) || envelope.recordFingerprints.length > MAX_CONTEXT_RECORDS ||
          !envelope.recordFingerprints.every(validRecordFingerprint)))) return false
  if (envelope.budget.maxChars !== BRAIN_CONTEXT_MAX_CHARS || envelope.budget.maxSources !== BRAIN_CONTEXT_MAX_SOURCES ||
      !Number.isSafeInteger(envelope.budget.usedChars) || envelope.budget.usedChars < 0 ||
      envelope.budget.usedChars > BRAIN_CONTEXT_MAX_CHARS || envelope.sourceReferences.length > BRAIN_CONTEXT_MAX_SOURCES ||
      !envelope.sourceReferences.every(validSourceReference)) return false
  if (envelope.status === 'ready') {
    return typeof envelope.block === 'string' && envelope.block.length > 0 &&
      envelope.block.length === envelope.budget.usedChars && envelope.block.length <= BRAIN_CONTEXT_MAX_CHARS
  }
  return envelope.status === 'empty' && envelope.block === undefined && envelope.budget.usedChars === 0 && envelope.sourceReferences.length === 0
}

/** Provider prompts receive only validated ready context; all other outcomes fail closed to omission. */
export function brainContextForProvider(envelope: BrainContextEnvelope, current: BrainContextOwner): string | undefined {
  return envelope.status === 'ready' && isBrainContextEnvelopeCurrent(envelope, current) ? envelope.block : undefined
}

export function staleBrainContextEnvelope(envelope: BrainContextEnvelope): BrainContextEnvelope {
  return {
    ...envelope,
    status: 'stale',
    block: undefined,
    sourceReferences: [],
    recordFingerprints: [],
    budget: { ...envelope.budget, usedChars: 0 }
  }
}
