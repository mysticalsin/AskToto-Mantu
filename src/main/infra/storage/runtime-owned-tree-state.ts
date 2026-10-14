import type { RuntimePhysicalAdmission, RuntimePhysicalSnapshotInput } from './runtime-owned-files'
import type { RuntimeOwnedTreeManifest, RuntimeOwnedTreeReceipt } from './runtime-owned-tree-record'

export interface RuntimeOwnedTreeReceiptState {
  readonly rootPath: string
  readonly snapshot: RuntimePhysicalSnapshotInput
  readonly manifest: RuntimeOwnedTreeManifest
  readonly physical: RuntimePhysicalAdmission
  disposed: boolean
  consumed: boolean
}

export const runtimeOwnedTreeReceipts = new WeakMap<object, RuntimeOwnedTreeReceiptState>()

export function registerRuntimeOwnedTreeReceipt(
  receipt: RuntimeOwnedTreeReceipt,
  state: RuntimeOwnedTreeReceiptState
): void {
  runtimeOwnedTreeReceipts.set(receipt as object, state)
}
