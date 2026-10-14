import { createHash } from 'node:crypto'
import {
  beginRuntimeRegistrySlotWrite,
  commitRuntimeRegistryReplace,
  createRuntimeRegistryRecordIssuer,
  disposeRuntimeRegistryNamespace,
  openRuntimeRegistryNamespace,
  prepareRuntimeRegistryReplace,
  readRuntimeRegistryCandidate,
  readRuntimeRegistryPendingCandidate,
  settleRuntimeRegistryReplace,
  type RegistrySlot,
  type RuntimeOwnedRegistrySlot,
  type RuntimeRegistryNamespace,
  type RuntimeRegistryPublicationBinding
} from '../infra/storage/runtime-owned-registry'
import type { RuntimeSpeechPackPurposeRoot, RuntimeStableFileOwner } from '../infra/storage/runtime-purpose-root'
import {
  assertRuntimeSpeechPackPurposeRootCurrent,
  describeRuntimeSpeechPackPurposeRoot
} from '../infra/storage/runtime-purpose-root'
import type { SpeechPackReceiptKeyHandle, SpeechPackReceiptKeyScope } from './speech-pack-receipt-key-contract'
import { SpeechPackError } from '../features/components/speech-pack/errors'
import {
  decodePackRegistrySnapshot,
  encodePackRegistrySnapshot,
  SPEECH_PACK_REGISTRY_LIMITS,
  type PackRegistryBinding,
  type PackRegistrySnapshot,
  type SpeechPackRegistryBackend
} from '../features/components/speech-pack/ownership-registry'

const REGISTRY_FRAME_KEYS = ['publication', 'snapshot'] as const
const PUBLICATION_KEYS = [
  'schemaVersion',
  'purpose',
  'rootBinding',
  'keyId',
  'slot',
  'publicationId',
  'createdOwner',
  'replacesDigest'
] as const
const HEX_256 = /^[a-f0-9]{64}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function ownerMatches(left: unknown, right: unknown): boolean {
  if (!isRecord(left) || !isRecord(right)) return false
  const fields = ['dev', 'ino', 'birthtimeNs', 'mode', 'uid', 'gid', 'rdev', 'nlink'] as const
  return (
    hasExactKeys(left, fields) && hasExactKeys(right, fields) && fields.every((field) => left[field] === right[field])
  )
}

function parsePublication(
  value: unknown,
  expected: {
    binding: PackRegistryBinding
    slot: RegistrySlot
    owner: unknown
  }
): RuntimeRegistryPublicationBinding {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, PUBLICATION_KEYS) ||
    value.schemaVersion !== 1 ||
    value.purpose !== 'metis-speech-pack-registry-slot/v1' ||
    value.rootBinding !== expected.binding.registryRootBinding ||
    value.keyId !== expected.binding.keyId ||
    value.slot !== expected.slot ||
    typeof value.publicationId !== 'string' ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(value.publicationId) ||
    !(
      value.replacesDigest === null ||
      (typeof value.replacesDigest === 'string' && HEX_256.test(value.replacesDigest))
    ) ||
    !ownerMatches(value.createdOwner, expected.owner)
  )
    throw new SpeechPackError('tamper', 'speech-pack registry publication is not bound to its created slot')
  const owner = value.createdOwner as Record<string, string>
  return {
    schemaVersion: 1,
    purpose: 'metis-speech-pack-registry-slot/v1',
    rootBinding: expected.binding.registryRootBinding,
    keyId: expected.binding.keyId,
    slot: expected.slot,
    publicationId: value.publicationId,
    createdOwner: {
      dev: owner.dev,
      ino: owner.ino,
      birthtimeNs: owner.birthtimeNs,
      mode: owner.mode,
      uid: owner.uid,
      gid: owner.gid,
      rdev: owner.rdev,
      nlink: owner.nlink
    } as RuntimeStableFileOwner,
    replacesDigest: value.replacesDigest as string | null
  }
}

function decodeFrame(
  plaintext: string,
  expected: { binding: PackRegistryBinding; slot: RegistrySlot; owner: unknown }
): { publication: RuntimeRegistryPublicationBinding; snapshot: PackRegistrySnapshot } {
  if (Buffer.byteLength(plaintext, 'utf8') > SPEECH_PACK_REGISTRY_LIMITS.plaintextBytes)
    throw new SpeechPackError('tamper', 'speech-pack receipt plaintext exceeds its limit')
  let parsed: unknown
  try {
    parsed = JSON.parse(plaintext)
  } catch {
    throw new SpeechPackError('tamper', 'speech-pack registry frame is malformed')
  }
  if (!isRecord(parsed) || !hasExactKeys(parsed, REGISTRY_FRAME_KEYS))
    throw new SpeechPackError('tamper', 'speech-pack registry frame has an invalid schema')
  const publication = parsePublication(parsed.publication, expected)
  const encodedSnapshot = new TextEncoder().encode(JSON.stringify(parsed.snapshot))
  const snapshot = decodePackRegistrySnapshot(encodedSnapshot, expected.binding)
  const canonical = JSON.stringify({ publication, snapshot })
  if (canonical !== plaintext) throw new SpeechPackError('tamper', 'speech-pack registry frame is not canonical')
  return { publication, snapshot }
}

function encodeFrame(publication: RuntimeRegistryPublicationBinding, snapshot: PackRegistrySnapshot): string {
  const snapshotBytes = encodePackRegistrySnapshot(snapshot)
  const canonical = JSON.stringify({
    publication,
    snapshot: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(snapshotBytes))
  })
  if (Buffer.byteLength(canonical, 'utf8') > SPEECH_PACK_REGISTRY_LIMITS.plaintextBytes)
    throw new SpeechPackError('tamper', 'speech-pack registry frame exceeds its plaintext limit')
  return canonical
}

function ciphertextDigest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Main-owned adapter. The storage owner issues the pending file's physical identity before encryption,
 * then CAS-publishes only the exact finished ciphertext against the retained slot token.
 */
export async function createSpeechPackRegistryBackend(input: {
  readonly scope: SpeechPackReceiptKeyScope
  readonly root: RuntimeSpeechPackPurposeRoot
  readonly key: SpeechPackReceiptKeyHandle
  readonly mode: 'create-explicit' | 'open-existing'
  readonly assertMainInstanceCurrentSync: () => void
}): Promise<SpeechPackRegistryBackend> {
  const { scope, root, key } = input
  const rootBinding = describeRuntimeSpeechPackPurposeRoot(root).bindingId
  const assertCurrent = (): void => {
    scope.assertCurrent()
    describeRuntimeSpeechPackPurposeRoot(root)
    key.assertCurrent()
    input.assertMainInstanceCurrentSync()
  }
  const assertPhysicalCurrent = async (): Promise<void> => {
    assertCurrent()
    await Promise.all([scope.assertPhysicalCurrent(), assertRuntimeSpeechPackPurposeRootCurrent(root)])
    assertCurrent()
  }
  await assertPhysicalCurrent()
  const namespace: RuntimeRegistryNamespace = await openRuntimeRegistryNamespace(root, {
    keyId: key.keyId,
    assertKeyCurrentSync: assertCurrent
  })
  await assertPhysicalCurrent()
  const issuer = createRuntimeRegistryRecordIssuer(namespace, {
    keyId: key.keyId,
    rootBinding,
    assertKeyCurrentSync: assertCurrent
  })
  const slotOwners = new Map<RegistrySlot, RuntimeOwnedRegistrySlot>()
  const slotDigests: Record<RegistrySlot, string | null> = { 0: null, 1: null }
  const slotSnapshots = new Map<RegistrySlot, PackRegistrySnapshot>()
  let disposed = false
  const assertLive = (): void => {
    if (disposed) throw new SpeechPackError('policy', 'speech-pack registry session is retired')
    assertCurrent()
  }

  const admitSlot = async (slot: RegistrySlot): Promise<void> => {
    await assertPhysicalCurrent()
    const candidate = await readRuntimeRegistryCandidate(namespace, slot)
    await assertPhysicalCurrent()
    if (!candidate) return
    if (
      !(candidate.bytes instanceof Uint8Array) ||
      candidate.bytes.byteLength > SPEECH_PACK_REGISTRY_LIMITS.envelopeBytes
    )
      throw new SpeechPackError('tamper', 'speech-pack registry ciphertext exceeds its limit')
    const plaintext = await key.withKeyUse((use) => use.decrypt(candidate.bytes))
    await assertPhysicalCurrent()
    const decoded = decodeFrame(plaintext, {
      binding: bindingFor(scope, rootBinding, key),
      slot,
      owner: candidate.createdOwner
    })
    const owned = await issuer.admitCandidate(candidate.candidate, decoded.publication)
    await assertPhysicalCurrent()
    slotOwners.set(slot, owned)
    slotDigests[slot] = ciphertextDigest(candidate.bytes)
    slotSnapshots.set(slot, decoded.snapshot)
  }

  const newestSlot = (): { slot: RegistrySlot; snapshot: PackRegistrySnapshot; digest: string } | null => {
    const candidates = ([0, 1] as const)
      .map((slot) => {
        const snapshot = slotSnapshots.get(slot)
        const digest = slotDigests[slot]
        return snapshot && digest ? { slot, snapshot, digest } : null
      })
      .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null)
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
    return candidates[0] ?? null
  }

  const recoverPending = async (): Promise<void> => {
    const pending = await readRuntimeRegistryPendingCandidate(namespace)
    await assertPhysicalCurrent()
    if (!pending) return
    if (input.mode !== 'open-existing')
      throw new SpeechPackError('tamper', 'speech-pack registry has an unfinished publication')
    if (!(pending.bytes instanceof Uint8Array) || pending.bytes.byteLength > SPEECH_PACK_REGISTRY_LIMITS.envelopeBytes)
      throw new SpeechPackError('tamper', 'speech-pack pending registry ciphertext exceeds its limit')
    const plaintext = await key.withKeyUse((use) => use.decrypt(pending.bytes))
    await assertPhysicalCurrent()
    const current = newestSlot()
    const nextSequence = current ? BigInt(current.snapshot.sequence) + 1n : 1n
    const slot: RegistrySlot = nextSequence % 2n === 0n ? 1 : 0
    const decoded = decodeFrame(plaintext, {
      binding: bindingFor(scope, rootBinding, key),
      slot,
      owner: pending.createdOwner
    })
    if (
      BigInt(decoded.snapshot.sequence) !== nextSequence ||
      decoded.snapshot.previousDigest !== (current?.digest ?? null) ||
      decoded.publication.replacesDigest !== slotDigests[slot]
    )
      throw new SpeechPackError('tamper', 'speech-pack pending registry history is not the unique next update')
    const scratch = await issuer.admitPendingCandidate(pending.candidate, decoded.publication)
    await assertPhysicalCurrent()
    const admission = await prepareRuntimeRegistryReplace({
      namespace,
      scratch,
      expected: slotOwners.get(slot) ?? null
    })
    await assertPhysicalCurrent()
    const receipt = commitRuntimeRegistryReplace(admission)
    const owned = await settleRuntimeRegistryReplace(receipt)
    await assertPhysicalCurrent()
    slotOwners.set(slot, owned)
    slotDigests[slot] = ciphertextDigest(pending.bytes)
    slotSnapshots.set(slot, decoded.snapshot)
  }

  try {
    await admitSlot(0)
    await admitSlot(1)
    await assertPhysicalCurrent()
    newestSlot()
    await recoverPending()
  } catch (error) {
    issuer.retire()
    await disposeRuntimeRegistryNamespace(namespace).catch(() => undefined)
    throw error
  }

  return {
    async readSlot(slot) {
      await assertPhysicalCurrent()
      const snapshot = slotSnapshots.get(slot)
      const digest = slotDigests[slot]
      return snapshot && digest ? { snapshot, digest } : null
    },
    async publishSnapshot({ slot, snapshot, expectedCurrentDigest }) {
      await assertPhysicalCurrent()
      if (slotDigests[slot] !== expectedCurrentDigest)
        throw new SpeechPackError('policy', 'speech-pack registry slot revision changed')
      let writer: Awaited<ReturnType<typeof beginRuntimeRegistrySlotWrite>> | null = null
      let committed = false
      try {
        writer = await beginRuntimeRegistrySlotWrite(namespace, slot, slotOwners.get(slot) ?? null)
        await assertPhysicalCurrent()
        const publication = parsePublication(writer.publication, {
          binding: bindingFor(scope, rootBinding, key),
          slot,
          owner: writer.publication.createdOwner
        })
        if (publication.replacesDigest !== expectedCurrentDigest)
          throw new SpeechPackError('policy', 'speech-pack registry replacement target changed')
        const plaintext = encodeFrame(publication, snapshot)
        const ciphertext = await key.withKeyUse((use) => use.encrypt(plaintext))
        await assertPhysicalCurrent()
        if (ciphertext.byteLength > SPEECH_PACK_REGISTRY_LIMITS.envelopeBytes)
          throw new SpeechPackError('tamper', 'speech-pack registry ciphertext exceeds its limit')
        const scratch = await writer.finish(ciphertext)
        await assertPhysicalCurrent()
        const admission = await prepareRuntimeRegistryReplace({
          namespace,
          scratch,
          expected: slotOwners.get(slot) ?? null
        })
        await assertPhysicalCurrent()
        const renameReceipt = commitRuntimeRegistryReplace(admission)
        committed = true
        const owned = await settleRuntimeRegistryReplace(renameReceipt)
        await assertPhysicalCurrent()
        const digest = ciphertextDigest(ciphertext)
        slotOwners.set(slot, owned)
        slotDigests[slot] = digest
        slotSnapshots.set(slot, snapshot)
        return { digest, durable: true }
      } catch (error) {
        if (!committed) await writer?.dispose().catch(() => undefined)
        throw error
      }
    },
    assertCurrent: assertLive,
    async settleAndDispose() {
      if (disposed) return
      disposed = true
      issuer.retire()
      try {
        await disposeRuntimeRegistryNamespace(namespace)
      } finally {
        key.retire()
        await key.settleAndDispose()
      }
    }
  }
}

function bindingFor(
  scope: SpeechPackReceiptKeyScope,
  rootBinding: string,
  key: SpeechPackReceiptKeyHandle
): PackRegistryBinding {
  return {
    profileNamespace: scope.profileNamespace,
    profileGeneration: scope.profileGeneration,
    principalAssociation: scope.principalAssociation,
    registryRootBinding: rootBinding,
    keyId: key.keyId
  }
}
