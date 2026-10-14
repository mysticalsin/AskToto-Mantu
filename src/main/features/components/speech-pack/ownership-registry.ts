import { createHash } from 'node:crypto'
import { SpeechPackError } from './errors'
import type { SpeechPackComponentId } from './manifest'
import { isOwnedExtractionReceipt, type OwnedExtractionReceipt } from './archive'
import type { SpeechPackReceiptKeyHandle } from '../../../persistence/speech-pack-receipt-key-contract'

export const SPEECH_PACK_RECEIPT_PURPOSE = 'metis-speech-pack-owner-key/v1' as const
export const SPEECH_PACK_REGISTRY_LIMITS = {
  envelopeBytes: 65_536,
  plaintextBytes: 48 * 1024,
  physicalNodes: 128,
  aggregatePathBytes: 16 * 1024,
  transactions: 8,
  concurrentWriters: 1
} as const

export type PackTransactionPhase =
  | 'install-intent'
  | 'staged'
  | 'move-aside-intent'
  | 'aside-moved'
  | 'promotion-intent'
  | 'promoted'
  | 'marker-intent'
  | 'marker-published'
  | 'rollback-intent'
  | 'settled'
  | 'cleanup-intent'
  | 'cleanup-partial'
  | 'retained-unknown'

export type PackObjectOrigin = 'writer-created' | 'legacy-restoration-custody'
export type PackObjectKind = 'directory' | 'file'
export type PackMovePhase = 'prepared' | 'moved' | 'unconfirmed'

export interface PackPhysicalIdentity {
  dev: string
  ino: string
  mode: string
  nlink: string
  uid: string
  gid: string
  rdev: string
  size: string
  blocks: string
  mtimeNs: string
  ctimeNs: string
  birthtimeNs: string
  fileId: string | null
}

export interface PackOwnedNode {
  path: string
  kind: PackObjectKind
  origin: PackObjectOrigin
  identity: PackPhysicalIdentity
  sha256: string | null
  bytes: string | null
}

export interface PackPendingMove {
  from: string
  to: string
  identity: PackPhysicalIdentity
  phase: PackMovePhase
}

export interface PackTransactionRecord {
  id: string
  componentId: SpeechPackComponentId
  version: string
  manifestIdentity: string
  phase: PackTransactionPhase
  previousMarkerBase64: string | null
  previousMarkerWasAbsent: boolean
  nodes: PackOwnedNode[]
  moves: PackPendingMove[]
  supersedes: string[]
  cleanupRemaining: string[]
}

export interface PackRegistryBinding {
  profileNamespace: string
  profileGeneration: string
  principalAssociation: string
  registryRootBinding: string
  keyId: string
  keyAnchorIdentity: PackStableIdentity
  registryRootIdentity: PackStableIdentity
  packRootIdentity: PackStableIdentity
}

/** Persistent namespace bindings use inode identity only; mutable directory metadata belongs to each admission. */
export interface PackStableIdentity {
  dev: string
  ino: string
  birthtimeNs: string
}

export interface PackRegistrySnapshot {
  schema: 1
  purpose: typeof SPEECH_PACK_RECEIPT_PURPOSE
  binding: PackRegistryBinding
  sequence: string
  previousDigest: string | null
  transactions: PackTransactionRecord[]
}

export type RegistrySlot = 0 | 1

export interface SpeechPackReceiptProtector {
  readonly keyId: string
  encrypt(plaintext: Uint8Array): Promise<Uint8Array>
  decrypt(envelope: Uint8Array, maxPlaintextBytes: number): Promise<Uint8Array>
  assertCurrent(): void
  retire(): void
  settleAndDispose(): Promise<void>
}

/** Adapts the purpose-specific key handle's existing-worker envelope capability to the registry store. */
export function createSpeechPackReceiptProtector(handle: SpeechPackReceiptKeyHandle): SpeechPackReceiptProtector {
  return {
    keyId: handle.keyId,
    assertCurrent: () => handle.assertCurrent(),
    retire: () => handle.retire(),
    async encrypt(plaintext) {
      handle.assertCurrent()
      const content = new TextDecoder('utf-8', { fatal: true }).decode(plaintext)
      const envelope = await handle.withKeyUse((key) => key.encrypt(content))
      handle.assertCurrent()
      return Uint8Array.from(envelope)
    },
    async decrypt(envelope, maxPlaintextBytes) {
      if (envelope.byteLength > SPEECH_PACK_REGISTRY_LIMITS.envelopeBytes)
        throw new SpeechPackError('tamper', 'speech-pack receipt envelope exceeds its limit')
      handle.assertCurrent()
      const content = await handle.withKeyUse((key) => key.decrypt(envelope))
      handle.assertCurrent()
      const plaintext = new TextEncoder().encode(content)
      if (plaintext.byteLength > maxPlaintextBytes)
        throw new SpeechPackError('tamper', 'speech-pack receipt plaintext exceeds its limit')
      return Uint8Array.from(plaintext)
    },
    settleAndDispose: () => handle.settleAndDispose()
  }
}

/** This backend must be implemented by the shared storage owner; it exposes no arbitrary filesystem handle. */
export interface SpeechPackRegistryBackend {
  readSlot(slot: RegistrySlot, maxBytes: number): Promise<Uint8Array | null>
  /** Publishes one complete bounded snapshot and verifies the exact published bytes before resolving. */
  publishSlot(input: {
    slot: RegistrySlot
    bytes: Uint8Array
    expectedCurrentDigest: string | null
    assertCurrent: () => void
  }): Promise<{ digest: string; durable: boolean }>
  acquireWriter(assertCurrent: () => void): Promise<{ release(): Promise<void> }>
}

export type SpeechPackRegistryAvailability = 'absent' | 'present' | 'unknown'

/** Read-only passive-status probe. It never opens native key storage or creates any path. */
export async function probeSpeechPackRegistry(
  backend: Pick<SpeechPackRegistryBackend, 'readSlot'>
): Promise<SpeechPackRegistryAvailability> {
  try {
    const first = await backend.readSlot(0, SPEECH_PACK_REGISTRY_LIMITS.envelopeBytes)
    const second = await backend.readSlot(1, SPEECH_PACK_REGISTRY_LIMITS.envelopeBytes)
    if (
      (first && first.byteLength > SPEECH_PACK_REGISTRY_LIMITS.envelopeBytes) ||
      (second && second.byteLength > SPEECH_PACK_REGISTRY_LIMITS.envelopeBytes)
    )
      return 'unknown'
    return first || second ? 'present' : 'absent'
  } catch {
    return 'unknown'
  }
}

export interface PackRegistryScope {
  profileNamespace: string
  profileGeneration: string
  principalAssociation: string
  keyAnchorIdentity: PackStableIdentity
  registryRootIdentity: PackStableIdentity
  packRootIdentity: PackStableIdentity
}

export interface SpeechPackOwnershipStore {
  beginInstall(input: {
    componentId: SpeechPackComponentId
    version: string
    manifestIdentity: string
    transactionId: string
    originalMarkerBase64: string | null
    previousMarkerWasAbsent: boolean
  }): Promise<PackTransactionRecord>
  recordExtraction(transactionId: string, receipt: OwnedExtractionReceipt): Promise<PackTransactionRecord>
  recordMove(transactionId: string, move: PackPendingMove): Promise<PackTransactionRecord>
  transition(transactionId: string, phase: PackTransactionPhase): Promise<PackTransactionRecord>
  snapshot(): Readonly<PackRegistrySnapshot>
  settleAndDispose(): Promise<void>
}

const MAX_MARKER_BASE64_BYTES = 8 * 1024
const COMPONENT_IDS = new Set<SpeechPackComponentId>(['asr.whisper-base-q8', 'asr.parakeet-tdt-0.6b-v3-int8'])
const PHASES = new Set<PackTransactionPhase>([
  'install-intent',
  'staged',
  'move-aside-intent',
  'aside-moved',
  'promotion-intent',
  'promoted',
  'marker-intent',
  'marker-published',
  'rollback-intent',
  'settled',
  'cleanup-intent',
  'cleanup-partial',
  'retained-unknown'
])
const DECIMAL = /^(0|[1-9][0-9]{0,39})$/
const HEX_256 = /^[a-f0-9]{64}$/
const TOKEN = /^[A-Za-z0-9_-]{1,128}$/

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

const isBoundedString = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max

function validateIdentity(value: unknown): value is PackPhysicalIdentity {
  const decimalFields = [
    'dev',
    'ino',
    'mode',
    'nlink',
    'uid',
    'gid',
    'rdev',
    'size',
    'blocks',
    'mtimeNs',
    'ctimeNs',
    'birthtimeNs'
  ]
  if (
    !isRecord(value) ||
    !exactKeys(value, [...decimalFields, 'fileId']) ||
    decimalFields.some((field) => typeof value[field] !== 'string' || !DECIMAL.test(value[field] as string))
  )
    return false
  return (
    value.fileId === null || (typeof value.fileId === 'string' && value.fileId.length > 0 && value.fileId.length <= 128)
  )
}

function validRelativePath(path: unknown): path is string {
  if (typeof path !== 'string' || !path || path.length > 1024 || path.includes('\\') || path.includes('\0'))
    return false
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) return false
  return path.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..' && !part.includes(':'))
}

function validateNode(value: unknown): value is PackOwnedNode {
  if (
    !isRecord(value) ||
    !exactKeys(value, ['path', 'kind', 'origin', 'identity', 'sha256', 'bytes']) ||
    !validRelativePath(value.path) ||
    (value.kind !== 'directory' && value.kind !== 'file') ||
    (value.origin !== 'writer-created' && value.origin !== 'legacy-restoration-custody') ||
    !validateIdentity(value.identity)
  )
    return false
  if (value.kind === 'directory') return value.sha256 === null && value.bytes === null
  return (
    (value.sha256 === null || (typeof value.sha256 === 'string' && HEX_256.test(value.sha256))) &&
    (value.bytes === null || (typeof value.bytes === 'string' && DECIMAL.test(value.bytes)))
  )
}

function validateMove(value: unknown): value is PackPendingMove {
  return (
    isRecord(value) &&
    exactKeys(value, ['from', 'to', 'identity', 'phase']) &&
    validRelativePath(value.from) &&
    validRelativePath(value.to) &&
    value.from !== value.to &&
    validateIdentity(value.identity) &&
    (value.phase === 'prepared' || value.phase === 'moved' || value.phase === 'unconfirmed')
  )
}

function validateTransaction(value: unknown): value is PackTransactionRecord {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      'id',
      'componentId',
      'version',
      'manifestIdentity',
      'phase',
      'previousMarkerBase64',
      'previousMarkerWasAbsent',
      'nodes',
      'moves',
      'supersedes',
      'cleanupRemaining'
    ]) ||
    typeof value.id !== 'string' ||
    !TOKEN.test(value.id) ||
    !COMPONENT_IDS.has(value.componentId as SpeechPackComponentId) ||
    !isBoundedString(value.version, 128) ||
    !HEX_256.test(value.manifestIdentity as string) ||
    !PHASES.has(value.phase as PackTransactionPhase) ||
    typeof value.previousMarkerWasAbsent !== 'boolean' ||
    !Array.isArray(value.nodes) ||
    value.nodes.length > SPEECH_PACK_REGISTRY_LIMITS.physicalNodes ||
    !Array.isArray(value.moves) ||
    value.moves.length > SPEECH_PACK_REGISTRY_LIMITS.physicalNodes ||
    !Array.isArray(value.supersedes) ||
    value.supersedes.length > SPEECH_PACK_REGISTRY_LIMITS.transactions ||
    !Array.isArray(value.cleanupRemaining) ||
    value.cleanupRemaining.length > SPEECH_PACK_REGISTRY_LIMITS.physicalNodes
  )
    return false
  if (
    value.previousMarkerBase64 !== null &&
    (typeof value.previousMarkerBase64 !== 'string' ||
      value.previousMarkerBase64.length > MAX_MARKER_BASE64_BYTES ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.previousMarkerBase64))
  )
    return false
  if (value.previousMarkerWasAbsent !== (value.previousMarkerBase64 === null)) return false
  if (
    value.nodes.some((node) => !validateNode(node)) ||
    value.moves.some((move) => !validateMove(move)) ||
    value.supersedes.some((item) => typeof item !== 'string' || !TOKEN.test(item)) ||
    value.cleanupRemaining.some((item) => !validRelativePath(item))
  )
    return false
  const nodePaths = (value.nodes as PackOwnedNode[]).map((node) => node.path)
  return new Set(nodePaths).size === nodePaths.length
}

function validateStableIdentity(value: unknown): value is PackStableIdentity {
  return (
    isRecord(value) &&
    exactKeys(value, ['dev', 'ino', 'birthtimeNs']) &&
    DECIMAL.test(String(value.dev)) &&
    DECIMAL.test(String(value.ino)) &&
    DECIMAL.test(String(value.birthtimeNs))
  )
}

function validateBinding(value: unknown): value is PackRegistryBinding {
  return (
    isRecord(value) &&
    exactKeys(value, [
      'profileNamespace',
      'profileGeneration',
      'principalAssociation',
      'registryRootBinding',
      'keyId',
      'keyAnchorIdentity',
      'registryRootIdentity',
      'packRootIdentity'
    ]) &&
    isBoundedString(value.profileNamespace, 128) &&
    TOKEN.test(value.profileNamespace) &&
    isBoundedString(value.profileGeneration, 128) &&
    isBoundedString(value.principalAssociation, 128) &&
    TOKEN.test(value.principalAssociation) &&
    isBoundedString(value.registryRootBinding, 128) &&
    TOKEN.test(value.registryRootBinding) &&
    isBoundedString(value.keyId, 128) &&
    validateStableIdentity(value.keyAnchorIdentity) &&
    validateStableIdentity(value.registryRootIdentity) &&
    validateStableIdentity(value.packRootIdentity)
  )
}

export function validatePackRegistrySnapshot(value: unknown): value is PackRegistrySnapshot {
  if (
    !isRecord(value) ||
    !exactKeys(value, ['schema', 'purpose', 'binding', 'sequence', 'previousDigest', 'transactions']) ||
    value.schema !== 1 ||
    value.purpose !== SPEECH_PACK_RECEIPT_PURPOSE ||
    !validateBinding(value.binding) ||
    typeof value.sequence !== 'string' ||
    !DECIMAL.test(value.sequence) ||
    value.sequence === '0' ||
    (value.sequence === '1' && value.previousDigest !== null) ||
    (value.sequence !== '1' && value.previousDigest === null) ||
    (value.previousDigest !== null &&
      (typeof value.previousDigest !== 'string' || !HEX_256.test(value.previousDigest))) ||
    !Array.isArray(value.transactions) ||
    value.transactions.length > SPEECH_PACK_REGISTRY_LIMITS.transactions ||
    value.transactions.some((transaction) => !validateTransaction(transaction))
  )
    return false
  const records = value.transactions as PackTransactionRecord[]
  if (new Set(records.map((record) => record.id)).size !== records.length) return false
  let nodes = 0
  let pathBytes = 0
  for (const record of records) {
    nodes += record.nodes.length
    pathBytes += record.nodes.reduce((sum, node) => sum + Buffer.byteLength(node.path), 0)
    pathBytes += record.moves.reduce((sum, move) => sum + Buffer.byteLength(move.from) + Buffer.byteLength(move.to), 0)
    pathBytes += record.cleanupRemaining.reduce((sum, path) => sum + Buffer.byteLength(path), 0)
  }
  return (
    nodes <= SPEECH_PACK_REGISTRY_LIMITS.physicalNodes && pathBytes <= SPEECH_PACK_REGISTRY_LIMITS.aggregatePathBytes
  )
}

export function decodePackRegistrySnapshot(bytes: Uint8Array, expected: PackRegistryBinding): PackRegistrySnapshot {
  if (bytes.byteLength > SPEECH_PACK_REGISTRY_LIMITS.plaintextBytes)
    throw new SpeechPackError('tamper', 'speech-pack receipt snapshot exceeds its limit')
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    throw new SpeechPackError('tamper', 'speech-pack receipt snapshot is malformed')
  }
  if (!validatePackRegistrySnapshot(parsed) || JSON.stringify(parsed) !== new TextDecoder().decode(bytes))
    throw new SpeechPackError('tamper', 'speech-pack receipt snapshot has an invalid schema')
  if (!validateBinding(expected) || !isSameBinding(parsed.binding, expected))
    throw new SpeechPackError('tamper', 'speech-pack receipt snapshot belongs to another scope')
  return parsed
}

export function encodePackRegistrySnapshot(snapshot: PackRegistrySnapshot): Uint8Array {
  if (!validatePackRegistrySnapshot(snapshot)) throw new SpeechPackError('tamper', 'invalid speech-pack receipt state')
  const bytes = new TextEncoder().encode(JSON.stringify(snapshot))
  if (bytes.byteLength > SPEECH_PACK_REGISTRY_LIMITS.plaintextBytes)
    throw new SpeechPackError('tamper', 'speech-pack receipt snapshot exceeds its limit')
  return bytes
}

const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

const copySnapshot = (snapshot: PackRegistrySnapshot): PackRegistrySnapshot =>
  JSON.parse(JSON.stringify(snapshot)) as PackRegistrySnapshot

const copyTransaction = (transaction: PackTransactionRecord): PackTransactionRecord =>
  JSON.parse(JSON.stringify(transaction)) as PackTransactionRecord

const freezeTransaction = (transaction: PackTransactionRecord): PackTransactionRecord => {
  for (const node of transaction.nodes) {
    Object.freeze(node.identity)
    Object.freeze(node)
  }
  for (const move of transaction.moves) {
    Object.freeze(move.identity)
    Object.freeze(move)
  }
  Object.freeze(transaction.nodes)
  Object.freeze(transaction.moves)
  Object.freeze(transaction.supersedes)
  Object.freeze(transaction.cleanupRemaining)
  return Object.freeze(transaction)
}

const frozenTransaction = (transaction: PackTransactionRecord): PackTransactionRecord =>
  freezeTransaction(copyTransaction(transaction))

const frozenSnapshot = (snapshot: PackRegistrySnapshot): Readonly<PackRegistrySnapshot> => {
  const copy = copySnapshot(snapshot)
  copy.transactions = copy.transactions.map(freezeTransaction)
  Object.freeze(copy.transactions)
  Object.freeze(copy.binding.keyAnchorIdentity)
  Object.freeze(copy.binding.registryRootIdentity)
  Object.freeze(copy.binding.packRootIdentity)
  Object.freeze(copy.binding)
  return Object.freeze(copy)
}

function isSameBinding(a: PackRegistryBinding, b: PackRegistryBinding): boolean {
  const sameIdentity = (left: PackStableIdentity, right: PackStableIdentity): boolean =>
    left.dev === right.dev && left.ino === right.ino && left.birthtimeNs === right.birthtimeNs
  return (
    a.profileNamespace === b.profileNamespace &&
    a.profileGeneration === b.profileGeneration &&
    a.principalAssociation === b.principalAssociation &&
    a.registryRootBinding === b.registryRootBinding &&
    a.keyId === b.keyId &&
    sameIdentity(a.keyAnchorIdentity, b.keyAnchorIdentity) &&
    sameIdentity(a.registryRootIdentity, b.registryRootIdentity) &&
    sameIdentity(a.packRootIdentity, b.packRootIdentity)
  )
}

function assertTransactionTransition(current: PackTransactionPhase, next: PackTransactionPhase): void {
  const allowed: Record<PackTransactionPhase, readonly PackTransactionPhase[]> = {
    'install-intent': ['staged', 'rollback-intent', 'retained-unknown'],
    staged: ['move-aside-intent', 'promotion-intent', 'rollback-intent', 'retained-unknown'],
    'move-aside-intent': ['aside-moved', 'rollback-intent', 'retained-unknown'],
    'aside-moved': ['promotion-intent', 'rollback-intent', 'retained-unknown'],
    'promotion-intent': ['promoted', 'rollback-intent', 'retained-unknown'],
    promoted: ['marker-intent', 'rollback-intent', 'retained-unknown'],
    'marker-intent': ['marker-published', 'rollback-intent', 'retained-unknown'],
    'marker-published': ['settled', 'rollback-intent', 'retained-unknown'],
    'rollback-intent': ['settled', 'cleanup-intent', 'cleanup-partial', 'retained-unknown'],
    settled: ['cleanup-intent', 'retained-unknown'],
    'cleanup-intent': ['cleanup-partial', 'settled', 'retained-unknown'],
    'cleanup-partial': ['cleanup-intent', 'settled', 'retained-unknown'],
    'retained-unknown': []
  }
  if (current !== next && !allowed[current].includes(next))
    throw new SpeechPackError('tamper', 'speech-pack receipt transition is not allowed')
}

export async function createSpeechPackOwnershipStore(input: {
  binding: PackRegistryBinding
  protector: SpeechPackReceiptProtector
  backend: SpeechPackRegistryBackend
  mode: 'create-explicit' | 'open-existing'
}): Promise<SpeechPackOwnershipStore> {
  const binding = JSON.parse(JSON.stringify(input.binding)) as PackRegistryBinding
  const { protector, backend } = input
  if (binding.keyId !== protector.keyId || !validateBinding(binding))
    throw new SpeechPackError('tamper', 'speech-pack receipt key binding is invalid')
  const lease = await backend.acquireWriter(() => {
    protector.assertCurrent()
  })
  let disposed = false
  const assertCurrent = (): void => {
    if (disposed) throw new SpeechPackError('policy', 'speech-pack receipt session is retired')
    protector.assertCurrent()
  }
  const readSlot = async (
    slot: RegistrySlot
  ): Promise<{ slot: RegistrySlot; snapshot: PackRegistrySnapshot; digest: string } | null> => {
    const envelope = await backend.readSlot(slot, SPEECH_PACK_REGISTRY_LIMITS.envelopeBytes)
    assertCurrent()
    if (!envelope) return null
    if (envelope.byteLength > SPEECH_PACK_REGISTRY_LIMITS.envelopeBytes)
      throw new SpeechPackError('tamper', 'speech-pack receipt envelope exceeds its limit')
    const plaintext = await protector.decrypt(envelope, SPEECH_PACK_REGISTRY_LIMITS.plaintextBytes)
    assertCurrent()
    const snapshot = decodePackRegistrySnapshot(plaintext, binding)
    return { slot, snapshot, digest: digest(envelope) }
  }
  let loaded: { slot: RegistrySlot; snapshot: PackRegistrySnapshot; digest: string } | null
  const slotDigests: Record<RegistrySlot, string | null> = { 0: null, 1: null }
  try {
    const first = await readSlot(0)
    const second = await readSlot(1)
    const candidates = [first, second].filter(
      (candidate): candidate is NonNullable<typeof candidate> => candidate !== null
    )
    if (first) slotDigests[0] = first.digest
    if (second) slotDigests[1] = second.digest
    candidates.sort((left, right) => (BigInt(right.snapshot.sequence) > BigInt(left.snapshot.sequence) ? 1 : -1))
    if (candidates.length > 1 && candidates[0].snapshot.sequence === candidates[1].snapshot.sequence)
      throw new SpeechPackError('tamper', 'speech-pack receipt snapshots conflict')
    if (candidates.length > 0 && candidates[0].slot !== (BigInt(candidates[0].snapshot.sequence) % 2n === 0n ? 1 : 0))
      throw new SpeechPackError('tamper', 'speech-pack receipt slot sequence is inconsistent')
    if (candidates.length > 1) {
      const newest = candidates[0]
      const previous = candidates[1]
      if (
        newest.snapshot.previousDigest !== previous.digest ||
        BigInt(newest.snapshot.sequence) !== BigInt(previous.snapshot.sequence) + 1n
      )
        throw new SpeechPackError('tamper', 'speech-pack receipt history is inconsistent')
    } else if (candidates.length === 1 && candidates[0].snapshot.sequence !== '1') {
      throw new SpeechPackError('tamper', 'speech-pack receipt history is incomplete')
    }
    loaded = candidates[0] ?? null
    if (input.mode === 'open-existing' && !loaded)
      throw new SpeechPackError('tamper', 'speech-pack receipt registry is unavailable')
    if (input.mode === 'create-explicit' && loaded)
      throw new SpeechPackError('tamper', 'speech-pack receipt registry already exists')
  } catch (error) {
    protector.retire()
    await lease.release()
    await protector.settleAndDispose()
    throw error
  }
  let current = loaded?.snapshot ?? {
    schema: 1 as const,
    purpose: SPEECH_PACK_RECEIPT_PURPOSE,
    binding,
    sequence: '0',
    previousDigest: null,
    transactions: []
  }
  let currentSlot = loaded?.slot ?? 1
  let currentDigest = loaded?.digest ?? null

  const persist = async (next: PackRegistrySnapshot): Promise<void> => {
    assertCurrent()
    const sequence = BigInt(current.sequence) + 1n
    const candidate: PackRegistrySnapshot = {
      ...next,
      sequence: sequence.toString(),
      previousDigest: currentDigest
    }
    if (!validatePackRegistrySnapshot(candidate) || !isSameBinding(candidate.binding, binding))
      throw new SpeechPackError('tamper', 'invalid speech-pack receipt update')
    const plaintext = encodePackRegistrySnapshot(candidate)
    const envelope = await protector.encrypt(plaintext)
    assertCurrent()
    if (envelope.byteLength > SPEECH_PACK_REGISTRY_LIMITS.envelopeBytes)
      throw new SpeechPackError('tamper', 'speech-pack receipt envelope exceeds its limit')
    const slot: RegistrySlot = currentSlot === 0 ? 1 : 0
    const published = await backend.publishSlot({
      slot,
      bytes: envelope,
      expectedCurrentDigest: slotDigests[slot],
      assertCurrent
    })
    assertCurrent()
    if (!published.durable || published.digest !== digest(envelope))
      throw new SpeechPackError('tamper', 'speech-pack receipt publication was not verified')
    current = candidate
    currentSlot = slot
    currentDigest = published.digest
    slotDigests[slot] = published.digest
  }

  const replaceTransaction = async (
    transactionId: string,
    transform: (current: Readonly<PackTransactionRecord>) => PackTransactionRecord
  ): Promise<PackTransactionRecord> => {
    assertCurrent()
    const index = current.transactions.findIndex((record) => record.id === transactionId)
    if (index < 0) throw new SpeechPackError('tamper', 'speech-pack transaction receipt is missing')
    const before = current.transactions[index]
    const after = transform(frozenTransaction(before))
    if (!validateTransaction(after) || after.id !== before.id)
      throw new SpeechPackError('tamper', 'speech-pack transaction receipt update is invalid')
    assertTransactionTransition(before.phase, after.phase)
    const transactions = [...current.transactions]
    transactions[index] = after
    await persist({ ...current, transactions })
    return frozenTransaction(after)
  }

  if (input.mode === 'create-explicit') {
    try {
      await persist(current)
    } catch (error) {
      protector.retire()
      await lease.release()
      await protector.settleAndDispose()
      throw error
    }
  }

  return {
    snapshot: () => frozenSnapshot(current),
    async beginInstall(data) {
      assertCurrent()
      if (current.transactions.length >= SPEECH_PACK_REGISTRY_LIMITS.transactions)
        throw new SpeechPackError('tamper', 'speech-pack receipt transaction limit reached')
      if (!COMPONENT_IDS.has(data.componentId) || !TOKEN.test(data.transactionId))
        throw new SpeechPackError('tamper', 'speech-pack install receipt identity is invalid')
      const transaction: PackTransactionRecord = {
        id: data.transactionId,
        componentId: data.componentId,
        version: data.version,
        manifestIdentity: data.manifestIdentity,
        phase: 'install-intent',
        previousMarkerBase64: data.originalMarkerBase64,
        previousMarkerWasAbsent: data.previousMarkerWasAbsent,
        nodes: [],
        moves: [],
        supersedes: [],
        cleanupRemaining: []
      }
      if (!validateTransaction(transaction) || current.transactions.some((record) => record.id === transaction.id))
        throw new SpeechPackError('tamper', 'speech-pack install receipt is invalid')
      const next = { ...current, transactions: [...current.transactions, transaction] }
      await persist(next)
      return frozenTransaction(transaction)
    },
    async recordExtraction(transactionId, receipt) {
      if (!isOwnedExtractionReceipt(receipt))
        throw new SpeechPackError('tamper', 'speech-pack extraction inventory was not issued by its writer')
      return replaceTransaction(transactionId, (record) => {
        if (record.phase !== 'install-intent' || record.nodes.length !== 0)
          throw new SpeechPackError('tamper', 'speech-pack extraction inventory is out of order')
        const rootPath = receipt.root.relativePath
        if (!validRelativePath(rootPath))
          throw new SpeechPackError('tamper', 'speech-pack extraction root is not bound to its pack directory')
        const nodes: PackOwnedNode[] = [
          {
            path: rootPath,
            kind: 'directory',
            origin: 'writer-created',
            identity: { ...receipt.root.identity },
            sha256: null,
            bytes: null
          },
          ...receipt.nodes.map((node) => ({
            path: `${rootPath}/${node.relativePath}`,
            kind: node.kind,
            origin: 'writer-created' as const,
            identity: { ...node.identity },
            sha256: node.sha256,
            bytes: node.bytes === null ? null : String(node.bytes)
          }))
        ]
        const next = { ...record, nodes }
        if (!validateTransaction(next))
          throw new SpeechPackError('tamper', 'speech-pack extraction inventory exceeds its receipt limits')
        return next
      })
    },
    async recordMove(transactionId, move) {
      if (!validateMove(move)) throw new SpeechPackError('tamper', 'speech-pack move receipt is invalid')
      return replaceTransaction(transactionId, (record) => {
        if (record.moves.some((item) => item.from === move.from || item.to === move.to))
          throw new SpeechPackError('tamper', 'speech-pack move receipt conflicts with an earlier move')
        return { ...record, moves: [...record.moves, { ...move, identity: { ...move.identity } }] }
      })
    },
    async transition(transactionId, phase) {
      if (!PHASES.has(phase)) throw new SpeechPackError('tamper', 'speech-pack phase is invalid')
      return replaceTransaction(transactionId, (record) => ({ ...record, phase }))
    },
    async settleAndDispose() {
      if (disposed) return
      disposed = true
      protector.retire()
      try {
        await lease.release()
      } finally {
        await protector.settleAndDispose()
      }
    }
  }
}
