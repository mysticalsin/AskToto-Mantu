import { createHash } from 'node:crypto'
import {
  admitRuntimeKeyAnchorCandidate,
  assertRuntimeKeyAnchorCurrent,
  createRuntimeKeyAnchor,
  describeRuntimeKeyAnchor,
  disposeRuntimeKeyAnchorOwner,
  openRuntimeKeyAnchorOwner,
  readRuntimeKeyAnchorCandidate,
  type RuntimeKeyAnchor,
  type RuntimeKeyAnchorCandidate,
  type RuntimeKeyAnchorOwner
} from '../infra/storage/runtime-key-anchor'
import { assertRuntimeSpeechPackPurposeRootCurrent } from '../infra/storage/runtime-purpose-root'
import type { MainSpeechPackRootLease } from './main-speech-pack-root'
import type {
  ProtectedSpeechPackKeyAnchorLease,
  ProtectedSpeechPackKeyAnchorOwner,
  SpeechPackReceiptKeyScope,
  SpeechPackReceiptRegistryRoot
} from './speech-pack-receipt-key-contract'

/**
 * Adapts the runtime's fixed profile-purpose key owner to the protected receipt-key service.
 * Callers cannot supply a root path, and candidate bytes are promoted only by the service's
 * post-authentication hook.
 */
export function createMainSpeechPackKeyAnchorOwner(
  mainLease: MainSpeechPackRootLease
): ProtectedSpeechPackKeyAnchorOwner {
  const scope = mainLease.scope
  const registryRoot = mainLease.keyRegistryRoot
  const purposeRoot = mainLease.keyPurposeRoot

  const assertCaptured = (
    receivedScope: SpeechPackReceiptKeyScope,
    receivedRoot: SpeechPackReceiptRegistryRoot
  ): void => {
    if (receivedScope !== scope || receivedRoot !== registryRoot) {
      throw new Error('SPEECH_PACK_KEY_OWNER_SCOPE_MISMATCH')
    }
    mainLease.assertCurrentSync()
    scope.assertCurrent()
    registryRoot.assertCurrent()
  }

  const openOwner = async (): Promise<RuntimeKeyAnchorOwner> => {
    await assertPhysicalCurrent()
    return openRuntimeKeyAnchorOwner(purposeRoot, {
      assertCurrentSync: () => {
        mainLease.assertCurrentSync()
        scope.assertCurrent()
        registryRoot.assertCurrent()
      },
      assertPhysicalCurrent
    })
  }

  const assertPhysicalCurrent = async (): Promise<void> => {
    mainLease.assertCurrentSync()
    scope.assertCurrent()
    registryRoot.assertCurrent()
    await Promise.all([
      mainLease.assertPhysicalCurrent(),
      scope.assertPhysicalCurrent(),
      registryRoot.assertPhysicalCurrent(),
      assertRuntimeSpeechPackPurposeRootCurrent(purposeRoot)
    ])
    mainLease.assertCurrentSync()
    scope.assertCurrent()
    registryRoot.assertCurrent()
  }

  const makeLease = (input: {
    owner: RuntimeKeyAnchorOwner
    bytes: Uint8Array
    candidate?: RuntimeKeyAnchorCandidate
    createdAnchor?: RuntimeKeyAnchor
    maxBytes: number
  }): ProtectedSpeechPackKeyAnchorLease => {
    const bytes = Buffer.from(input.bytes)
    let disposed = false
    let admission: Promise<void> | null = null
    let disposal: Promise<void> | null = null
    const assertLive = async (): Promise<void> => {
      if (disposed) throw new Error('SPEECH_PACK_KEY_ANCHOR_LEASE_RETIRED')
      await assertPhysicalCurrent()
      if (input.createdAnchor) await assertRuntimeKeyAnchorCurrent(input.createdAnchor)
    }
    return Object.freeze({
      bytes,
      assertCurrent: assertLive,
      admitAuthenticated(keyId: string, authenticatedBytes: Uint8Array): Promise<void> {
        if (admission) return admission
        admission = (async () => {
          await assertLive()
          if (
            typeof keyId !== 'string' ||
            !/^[A-Za-z0-9_-]{1,128}$/.test(keyId) ||
            !(authenticatedBytes instanceof Uint8Array) ||
            authenticatedBytes.byteLength > input.maxBytes ||
            !bytes.equals(Buffer.from(authenticatedBytes))
          ) {
            throw new Error('SPEECH_PACK_KEY_ANCHOR_AUTHENTICATION_MISMATCH')
          }
          if (input.createdAnchor) {
            const description = describeRuntimeKeyAnchor(input.createdAnchor)
            if (
              description.keyId !== keyId ||
              description.byteLength !== bytes.byteLength ||
              description.digest !== createHash('sha256').update(bytes).digest('hex')
            ) {
              throw new Error('SPEECH_PACK_KEY_ANCHOR_AUTHENTICATION_MISMATCH')
            }
            await assertRuntimeKeyAnchorCurrent(input.createdAnchor)
          } else {
            if (!input.candidate) throw new Error('SPEECH_PACK_KEY_ANCHOR_CANDIDATE_MISSING')
            const anchor = await admitRuntimeKeyAnchorCandidate(input.owner, input.candidate, keyId, authenticatedBytes)
            const description = describeRuntimeKeyAnchor(anchor)
            if (
              description.keyId !== keyId ||
              description.byteLength !== bytes.byteLength ||
              description.digest !== createHash('sha256').update(bytes).digest('hex')
            ) {
              throw new Error('SPEECH_PACK_KEY_ANCHOR_AUTHENTICATION_MISMATCH')
            }
            input.createdAnchor = anchor
          }
          await assertLive()
        })()
        return admission
      },
      async dispose(): Promise<void> {
        if (disposal) return disposal
        disposed = true
        bytes.fill(0)
        disposal = disposeRuntimeKeyAnchorOwner(input.owner)
        return disposal
      }
    })
  }

  return Object.freeze({
    async openExisting(
      receivedScope: SpeechPackReceiptKeyScope,
      receivedRoot: SpeechPackReceiptRegistryRoot,
      maxBytes: number
    ) {
      assertCaptured(receivedScope, receivedRoot)
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 65_536) {
        throw new Error('SPEECH_PACK_KEY_ANCHOR_LIMIT_INVALID')
      }
      const owner = await openOwner()
      try {
        const candidate = await readRuntimeKeyAnchorCandidate(owner)
        await assertPhysicalCurrent()
        if (!candidate) {
          await disposeRuntimeKeyAnchorOwner(owner)
          return null
        }
        if (!(candidate.bytes instanceof Uint8Array) || candidate.bytes.byteLength > maxBytes) {
          await disposeRuntimeKeyAnchorOwner(owner)
          throw new Error('SPEECH_PACK_KEY_ANCHOR_LIMIT_INVALID')
        }
        const lease = makeLease({ owner, candidate: candidate.candidate, bytes: candidate.bytes, maxBytes })
        candidate.bytes.fill(0)
        return lease
      } catch (error) {
        await disposeRuntimeKeyAnchorOwner(owner).catch(() => undefined)
        throw error
      }
    },
    async createExclusive(
      receivedScope: SpeechPackReceiptKeyScope,
      receivedRoot: SpeechPackReceiptRegistryRoot,
      bytes: Buffer,
      keyId: string,
      maxBytes: number
    ) {
      assertCaptured(receivedScope, receivedRoot)
      if (
        !Buffer.isBuffer(bytes) ||
        !Number.isSafeInteger(maxBytes) ||
        maxBytes < 1 ||
        maxBytes > 65_536 ||
        bytes.byteLength > maxBytes ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(keyId)
      ) {
        throw new Error('SPEECH_PACK_KEY_ANCHOR_LIMIT_INVALID')
      }
      const owner = await openOwner()
      try {
        const anchor = await createRuntimeKeyAnchor(owner, bytes, keyId)
        await assertPhysicalCurrent()
        const description = describeRuntimeKeyAnchor(anchor)
        if (
          description.keyId !== keyId ||
          description.byteLength !== bytes.byteLength ||
          description.digest !== createHash('sha256').update(bytes).digest('hex')
        ) {
          throw new Error('SPEECH_PACK_KEY_ANCHOR_CREATE_UNCONFIRMED')
        }
        return makeLease({ owner, bytes, createdAnchor: anchor, maxBytes })
      } catch (error) {
        await disposeRuntimeKeyAnchorOwner(owner).catch(() => undefined)
        throw error
      }
    }
  })
}
