import type { NativeMeetingKeyBackend } from './protected-meeting-keys'

/** An explicit main-process install or recovery authority. This is never reconstructed from a receipt. */
export interface SpeechPackReceiptKeyScope {
  readonly profileNamespace: string
  readonly principalAssociation: string
  readonly profileGeneration: string
  readonly nativeKeyAccess: 'allowed' | 'explicitly-disabled'
  readonly intent: 'explicit-pack-maintenance'
  assertCurrent(): void
  assertPhysicalCurrent(): Promise<void>
}

/** A main-owned registry root binding. It deliberately exposes no renderer-selected path. */
export interface SpeechPackReceiptRegistryRoot {
  readonly bindingId: string
  assertCurrent(): void
  assertPhysicalCurrent(): Promise<void>
}

/** Held, bounded bytes for the fixed profile-level key anchor; implementations own path and ACL admission. */
export interface ProtectedSpeechPackKeyAnchorLease {
  readonly bytes: Buffer
  assertCurrent(): Promise<void>
  dispose(): Promise<void>
}

/**
 * Main storage-owner dependency for `<admitted-profile>/component-ownership/speech-packs/key.v1`.
 * openExisting must be read-only and return null only for absence. createExclusive must use a synced,
 * exclusive publication and refuse an existing, linked, nonregular, or untrusted anchor. Both methods
 * must retain and revalidate the exact bounded file version and private ancestor/ACL state.
 */
export interface ProtectedSpeechPackKeyAnchorOwner {
  openExisting(
    scope: SpeechPackReceiptKeyScope,
    registryRoot: SpeechPackReceiptRegistryRoot,
    maxBytes: number
  ): Promise<ProtectedSpeechPackKeyAnchorLease | null>
  createExclusive(
    scope: SpeechPackReceiptKeyScope,
    registryRoot: SpeechPackReceiptRegistryRoot,
    bytes: Buffer,
    maxBytes: number
  ): Promise<ProtectedSpeechPackKeyAnchorLease>
}

export interface SpeechPackReceiptKeyUse {
  /** Returns the existing ATKENC2 envelope with a fresh IV. */
  encrypt(plaintext: string): Promise<Buffer>
  /** Accepts only the existing ATKENC2 envelope shape and the anchor's exact expected kLocal. */
  decrypt(envelopeBytes: Uint8Array): Promise<string>
}

export interface SpeechPackReceiptKeyHandle {
  readonly keyId: string
  readonly expectedKLocal: string
  assertCurrent(): void
  withKeyUse<T>(use: (keyUse: SpeechPackReceiptKeyUse) => T | Promise<T>): Promise<T>
  retire(): void
  settleAndDispose(): Promise<void>
}

export interface ProtectedSpeechPackReceiptKeys {
  createForExplicitInstall(
    scope: SpeechPackReceiptKeyScope,
    registryRoot: SpeechPackReceiptRegistryRoot
  ): Promise<SpeechPackReceiptKeyHandle>
  openExistingForRecovery(
    scope: SpeechPackReceiptKeyScope,
    registryRoot: SpeechPackReceiptRegistryRoot
  ): Promise<SpeechPackReceiptKeyHandle>
  retire(handle: SpeechPackReceiptKeyHandle): void
  settleAndDispose(handle: SpeechPackReceiptKeyHandle): Promise<void>
}

export interface SpeechPackReceiptKeyAnchorRecord {
  readonly v: 1
  readonly purpose: 'metis-speech-pack-owner-key/v1'
  readonly profileNamespace: string
  readonly principalAssociation: string
  readonly profileGeneration: string
  readonly registryRootBinding: string
  readonly keyId: string
  readonly backend: NativeMeetingKeyBackend
}
