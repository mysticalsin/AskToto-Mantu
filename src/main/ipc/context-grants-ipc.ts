import type { IpcMain } from 'electron'
import {
  CONTEXT_IPC,
  GrantDocumentSchema,
  RevokeGrantSchema,
  SnapshotDeleteSchema,
  SnapshotRequestSchema,
  TurnManifestRequestSchema,
  type ContextManifest,
  type GrantResult,
  type HeldContext,
  type SimpleResult,
  type SnapshotKind,
  type SnapshotResult
} from '@shared/context-manifest'
import type { DocumentGrants } from '../features/context-grants/document-grants'
import type { ManifestLog } from '../features/context-grants/manifest'
import type { ObservedContent, SnapshotStore } from '../features/context-grants/snapshot-store'

export interface ContextIpcDeps {
  ipcMain: Pick<IpcMain, 'handle'>
  /** Throws for any sender that is not the main window's top frame. */
  assertMainWindow(event: never): void
  requireAuth(): boolean
  store: SnapshotStore
  grants: DocumentGrants
  manifests: Pick<ManifestLog, 'get'>
  /** One explicit capture and reading of the screen or the foreground document. Called only by `snapshotRequest`. */
  observe(kind: SnapshotKind): Promise<ObservedContent>
}

const SIGNED_OUT = { ok: false, reason: 'signed-out' } as const
const INVALID = { ok: false, reason: 'invalid' } as const

/**
 * The renderer's view of G46: ask for a snapshot (the owner's gesture), grant or revoke a whole document, delete a
 * snapshot, list what is held (no text) and read a turn's manifest ("what Métis used"). Every channel is gated to the
 * main window and to a signed-in owner; payloads are strict.
 */
export function registerContextIpc(deps: ContextIpcDeps): void {
  const { ipcMain } = deps
  const gate = (event: unknown): void => deps.assertMainWindow(event as never)

  ipcMain.handle(CONTEXT_IPC.turnManifest, (event, raw): ContextManifest | null => {
    gate(event)
    if (!deps.requireAuth()) return null
    const parsed = TurnManifestRequestSchema.safeParse(raw)
    return parsed.success ? deps.manifests.get(parsed.data.turnId) : null
  })

  ipcMain.handle(CONTEXT_IPC.snapshotRequest, async (event, raw): Promise<SnapshotResult> => {
    gate(event)
    if (!deps.requireAuth()) return SIGNED_OUT
    const parsed = SnapshotRequestSchema.safeParse(raw)
    if (!parsed.success) return INVALID
    return deps.store.request(parsed.data, () => deps.observe(parsed.data.kind))
  })

  ipcMain.handle(CONTEXT_IPC.snapshotDelete, async (event, raw): Promise<SimpleResult> => {
    gate(event)
    if (!deps.requireAuth()) return SIGNED_OUT
    const parsed = SnapshotDeleteSchema.safeParse(raw)
    if (!parsed.success) return INVALID
    return (await deps.store.remove(parsed.data.snapshotId)) ? { ok: true } : { ok: false, reason: 'not-found' }
  })

  ipcMain.handle(CONTEXT_IPC.grantDocument, (event, raw): GrantResult => {
    gate(event)
    if (!deps.requireAuth()) return SIGNED_OUT
    const parsed = GrantDocumentSchema.safeParse(raw)
    return parsed.success ? deps.grants.grant(parsed.data) : INVALID
  })

  ipcMain.handle(CONTEXT_IPC.revokeGrant, (event, raw): SimpleResult => {
    gate(event)
    if (!deps.requireAuth()) return SIGNED_OUT
    const parsed = RevokeGrantSchema.safeParse(raw)
    if (!parsed.success) return INVALID
    return deps.grants.revoke(parsed.data.grantId) ? { ok: true } : { ok: false, reason: 'not-found' }
  })

  ipcMain.handle(CONTEXT_IPC.held, (event): HeldContext => {
    gate(event)
    if (!deps.requireAuth()) return { snapshots: [], grants: [] }
    const grants = deps.grants.active()
    const granted = new Set(grants.map((g) => g.snapshotId))
    return {
      snapshots: deps.store.list().map((s) => ({ ...s, granted: granted.has(s.snapshotId) })),
      grants: grants.map((g) => ({ grantId: g.grantId, snapshotId: g.snapshotId, expiresAt: g.expiresAt }))
    }
  })
}
