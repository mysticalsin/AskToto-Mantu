import type { IpcMain } from 'electron'
import type { SnapshotKind } from '@shared/context-manifest'
import { createDocumentGrants, type DocumentGrants } from './document-grants'
import { registerContextIpc } from '../../ipc/context-grants-ipc'
import { registerAttachmentsIpc } from '../../ipc/attachments-ipc'
import { createAttachmentService, type AttachmentService, type AttachmentServiceDeps } from '../attachments'
import { createManifestLog, type ManifestLog } from './manifest'
import { currentUserMemory } from '../user-memory'
import { createContextRuntime, type ContextRuntime } from './runtime'
import { createSnapshotFileIo } from './snapshot-io'
import { createSnapshotStore, type ObservedContent, type SnapshotStore } from './snapshot-store'

export interface ContextGrantsDeps {
  ipcMain: Pick<IpcMain, 'handle'>
  assertMainWindow(event: never): void
  requireAuth(): boolean
  /** The directory the sealed snapshot files live under (inside the app's own data folder). */
  root: string
  /** The memory partition in force (the owner), or null while none is open. */
  owner(): string | null
  /** The screen-observation generation, after reconciling Screen Recording and Private View. */
  generation(): number
  /** The main-owned id of the live session or conversation; a grant ends when it changes. */
  sessionId(): string
  seal(plain: string): Buffer
  open(sealed: Buffer): string
  /** One explicit capture and reading, taken only when the owner asked for a snapshot. */
  observe(kind: SnapshotKind): Promise<ObservedContent>
  /** Subscribes to owner (memory partition) changes; returns the unsubscribe. */
  onOwnerChange(listener: () => void): () => void
  now?(): number
  /** Main-owned sources for composer attachments (G54): its own dialog and clipboard read. */
  attachmentSources?: Pick<AttachmentServiceDeps, 'pickFiles' | 'readClipboard' | 'isProtectedPath'>
}

export interface ContextGrants {
  readonly store: SnapshotStore
  readonly grants: DocumentGrants
  readonly manifests: ManifestLog
  readonly runtime: ContextRuntime
  /** Composer attachments held in main, bound to the owner, session and conversation (G54). */
  readonly attachments: AttachmentService
  /** Ends every snapshot and grant, forgets the manifests, deletes the sealed files: stop, sign-out, owner switch, lock. */
  revokeAll(reason: string): Promise<void>
}

/** Composes the snapshot store, whole-document grants, per-turn manifests and their IPC (G46). */
export function createContextGrants(deps: ContextGrantsDeps): ContextGrants {
  const now = deps.now ?? Date.now
  const store = createSnapshotStore({
    io: createSnapshotFileIo(deps.root, deps.owner),
    seal: deps.seal,
    open: deps.open,
    owner: deps.owner,
    generation: deps.generation,
    now
  })
  const grants = createDocumentGrants({
    store,
    owner: deps.owner,
    generation: deps.generation,
    sessionId: deps.sessionId,
    now
  })
  const manifests = createManifestLog({ owner: deps.owner, now })
  const attachments = createAttachmentService({
    owner: deps.owner,
    session: deps.sessionId,
    now,
    pickFiles: deps.attachmentSources?.pickFiles ?? (async () => null),
    readClipboard: deps.attachmentSources?.readClipboard ?? (async () => null),
    isProtectedPath: deps.attachmentSources?.isProtectedPath
  })
  const runtime = createContextRuntime({
    store,
    grants,
    manifests,
    userMemory: currentUserMemory,
    conversation: deps.sessionId,
    attachments
  })
  const revokeAll = async (reason: string): Promise<void> => {
    attachments.clear(reason)
    grants.revokeAll(reason)
    manifests.clear()
    await store.revokeAll(reason)
  }
  deps.onOwnerChange(() => void revokeAll('owner_switch').catch(() => undefined))
  registerContextIpc({
    ipcMain: deps.ipcMain,
    assertMainWindow: deps.assertMainWindow,
    requireAuth: deps.requireAuth,
    store,
    grants,
    manifests,
    observe: deps.observe
  })
  registerAttachmentsIpc({
    ipcMain: deps.ipcMain,
    assertMainWindow: deps.assertMainWindow,
    requireAuth: deps.requireAuth,
    service: attachments
  })
  // Expired or no-longer-valid snapshots are removed as they are noticed, not left on disk.
  void store.sweep()
  return { store, grants, manifests, runtime, attachments, revokeAll }
}
