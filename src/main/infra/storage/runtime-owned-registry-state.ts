import type { BigIntStats } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import type { RuntimePhysicalAdmission } from './runtime-owned-files'
import type {
  RuntimeProfileBinding,
  RuntimeSpeechPackPurposeRoot,
  RuntimeStableFileOwner,
  RuntimeStableOwner
} from './runtime-purpose-root'

export type RegistrySlot = 0 | 1
declare const runtimeRegistryNamespaceBrand: unique symbol
declare const runtimeRegistryCandidateBrand: unique symbol
declare const runtimeOwnedRegistrySlotBrand: unique symbol
declare const runtimeRegistryScratchBrand: unique symbol
declare const runtimeRegistryReplaceAdmissionBrand: unique symbol
declare const runtimeRegistryRenameReceiptBrand: unique symbol
export type RuntimeRegistryNamespace = { readonly [runtimeRegistryNamespaceBrand]: true }
export type RuntimeRegistryCandidate = { readonly [runtimeRegistryCandidateBrand]: true }
export type RuntimeOwnedRegistrySlot = { readonly [runtimeOwnedRegistrySlotBrand]: true }
export type RuntimeRegistryScratch = { readonly [runtimeRegistryScratchBrand]: true }
export type RuntimeRegistryReplaceAdmission = { readonly [runtimeRegistryReplaceAdmissionBrand]: true }
export type RuntimeRegistryRenameReceipt = { readonly [runtimeRegistryRenameReceiptBrand]: true }

export type RuntimeRegistryPublicationBinding = Readonly<{
  schemaVersion: 1
  purpose: 'metis-speech-pack-registry-slot/v1'
  rootBinding: string
  keyId: string
  slot: RegistrySlot
  publicationId: string
  createdOwner: RuntimeStableFileOwner
  replacesDigest: string | null
}>

export interface CandidateState {
  readonly namespace: NamespaceState
  readonly member: string
  readonly path: string
  readonly bytes: Buffer
  readonly owner: RuntimeStableFileOwner
  readonly version: BigIntStats
  readonly file: FileHandle
  disposed: boolean
  admitted: boolean
}

export interface SlotState {
  readonly namespace: NamespaceState
  readonly slot: RegistrySlot
  readonly owner: RuntimeStableFileOwner
  readonly digest: string
  readonly version: BigIntStats
  stale: boolean
}

export interface ScratchState {
  readonly namespace: NamespaceState
  readonly publication: RuntimeRegistryPublicationBinding
  readonly owner: RuntimeStableFileOwner
  readonly version: BigIntStats
  readonly digest: string
  readonly ciphertext: Buffer
  readonly fromPendingCandidate: boolean
  consumed: boolean
}

export interface NamespaceState {
  readonly root: RuntimeSpeechPackPurposeRoot
  readonly rootPath: string
  readonly rootBinding: string
  readonly profile: RuntimeProfileBinding
  readonly rootOwner: RuntimeStableOwner
  readonly keyId: string
  readonly assertKeyCurrentSync: () => void
  rootVersion: BigIntStats
  children: string[]
  readonly rootHandle: FileHandle
  readonly handles: Set<FileHandle>
  readonly candidates: Set<CandidateState>
  disposed: boolean
  retired: boolean
  frozen: boolean
  writing: boolean
}

export interface RecordIssuerState {
  readonly namespace: NamespaceState
  readonly keyId: string
  readonly rootBinding: string
  readonly assertKeyCurrentSync: () => void
  retired: boolean
}

export interface ReplaceAdmissionState {
  readonly namespace: NamespaceState
  readonly scratch: ScratchState
  readonly expected: SlotState | null
  readonly destination: string
  readonly physical: RuntimePhysicalAdmission
  readonly childrenBefore: readonly string[]
  disposed: boolean
  consumed: boolean
}

export interface RenameReceiptState {
  readonly admission: ReplaceAdmissionState
  movedVersion: BigIntStats | null
  rootVersion: BigIntStats | null
  childrenAfter: readonly string[] | null
  settled: boolean
  movedUnconfirmed: boolean
}

export const namespaces = new WeakMap<object, NamespaceState>()
export const candidates = new WeakMap<object, CandidateState>()
export const slots = new WeakMap<object, SlotState>()
export const scratches = new WeakMap<object, ScratchState>()
export const issuers = new WeakMap<object, RecordIssuerState>()
export const replacements = new WeakMap<object, ReplaceAdmissionState>()
export const renameReceipts = new WeakMap<object, RenameReceiptState>()
