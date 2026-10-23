import type { IpcRenderer } from 'electron'
import {
  CONTEXT_IPC,
  type ContextManifest,
  type GrantResult,
  type HeldContext,
  type SimpleResult,
  type SnapshotGesture,
  type SnapshotKind,
  type SnapshotResult
} from '../shared/context-manifest'

/**
 * The renderer's side of G46: ask for a snapshot with the gesture the owner just made, grant or revoke a whole
 * document, delete a snapshot, list what is held, and read what a turn used. Replies carry ids, sizes and refusal
 * codes, never the text of a snapshot, a document or a prompt.
 */
export function createContextGrantsPreloadApi(ipc: Pick<IpcRenderer, 'invoke'>): {
  getTurnContextManifest(turnId: string): Promise<ContextManifest | null>
  requestContextSnapshot(gesture: SnapshotGesture, kind?: SnapshotKind): Promise<SnapshotResult>
  deleteContextSnapshot(snapshotId: string): Promise<SimpleResult>
  grantWholeDocument(snapshotId: string, gesture: SnapshotGesture): Promise<GrantResult>
  revokeDocumentGrant(grantId: string): Promise<SimpleResult>
  getHeldContext(): Promise<HeldContext>
} {
  return {
    getTurnContextManifest: (turnId) => ipc.invoke(CONTEXT_IPC.turnManifest, { turnId }),
    requestContextSnapshot: (gesture, kind = 'screen') => ipc.invoke(CONTEXT_IPC.snapshotRequest, { gesture, kind }),
    deleteContextSnapshot: (snapshotId) => ipc.invoke(CONTEXT_IPC.snapshotDelete, { snapshotId }),
    grantWholeDocument: (snapshotId, gesture) => ipc.invoke(CONTEXT_IPC.grantDocument, { snapshotId, gesture }),
    revokeDocumentGrant: (grantId) => ipc.invoke(CONTEXT_IPC.revokeGrant, { grantId }),
    getHeldContext: () => ipc.invoke(CONTEXT_IPC.held)
  }
}
