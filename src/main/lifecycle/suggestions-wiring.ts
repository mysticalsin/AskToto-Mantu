import { randomBytes } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { IpcMain } from 'electron'
import {
  createSuggestionService,
  createSuggestionStore,
  type ResearchSource,
  type SuggestionAuditRecord,
  type SuggestionService
} from '../features/suggestions'
import { atomicSavedWrite } from '../infra/storage/atomic-saved-write'
import { registerSuggestionsIpc } from '../ipc/suggestions-ipc'
import type { AuthorizeSender } from '../ipc/sender-auth'
import { memoryAccess, memoryPartitionsConfigured, onMemoryPartitionChange } from '../memory-partition/memory-access'

export interface SuggestionsWiringDeps {
  ipcMain: Pick<IpcMain, 'handle'>
  authorizeSender: AuthorizeSender
  requireAuth(): boolean
  ownerSession: {
    currentOwnerKey(): string | null
    currentTenantKey(): string | null
    onRevoked(cb: () => void): () => void
  }
  userDataPath(): string
  /** The app's own secret sealing (`encryptSecret` / `decryptSecret`). */
  seal(plain: string): Buffer
  open(sealed: Buffer): string
  /** The sources research may read: already-granted ones only (calendar through the read-only port, user memory). */
  sources: readonly ResearchSource[]
  /** The owner's `suggestionsEnabled` setting, read live. */
  enabled(): boolean
  /** The quiet-gated notification path (`showQuietNotification`). Called with `directRequest: false` and a count-only body. */
  notify(notification: { title: string; body: string; directRequest: false }): void
  audit(record: SuggestionAuditRecord): void
  /** Defaults to G19's partition in force; a test seam. */
  partition?(): string | null
  /** Subscribes to a change of the partition in force; defaults to G19's. A test seam. */
  onPartitionChange?(listener: () => void): () => void
  now?(): number
}

/** G19's partition in force: its id, or null while none is open (signed out, unverified, a switch in flight). */
function activePartition(): string | null {
  if (!memoryPartitionsConfigured()) return null
  const access = memoryAccess()
  return access.status === 'ok' ? access.partitionId : null
}

/**
 * Builds the suggestion store and service (G67) under `<userData>/suggestions/<partition>.bin` (sealed, one file per
 * memory partition, so the file belongs to the verified tenant and user), registers its IPC behind the shared sender
 * authorizer, and aborts the run in flight when the owner is revoked or the partition changes. Hangs off
 * `createOwnerSessionWiring`, so index.ts gains no lines.
 *
 * Without a verified owner key, tenant key and an open partition there is no scope and every call is refused as signed
 * out. The pipeline has no timer and no process of its own: a routine (G66) calls its research port, and a manual check
 * comes from the renderer.
 */
export function bootstrapSuggestions(deps: SuggestionsWiringDeps): SuggestionService {
  const partition = deps.partition ?? activePartition
  const scope = () => {
    const partitionId = partition()
    const ownerKey = deps.ownerSession.currentOwnerKey()
    const tenantKey = deps.ownerSession.currentTenantKey()
    return partitionId && ownerKey && tenantKey ? { partitionId, ownerKey, tenantKey } : null
  }
  const file = (partitionId: string): string => {
    if (!/^(?:legacy|[0-9a-f]{24})$/.test(partitionId)) throw new Error('invalid memory partition')
    return join(deps.userDataPath(), 'suggestions', `${partitionId}.bin`)
  }
  const store = createSuggestionStore({
    io: {
      async read(partitionId) {
        try {
          return await readFile(file(partitionId))
        } catch (error) {
          if ((error as { code?: unknown } | null)?.code === 'ENOENT') return null
          throw error
        }
      },
      async write(partitionId, data) {
        const target = file(partitionId)
        await mkdir(join(deps.userDataPath(), 'suggestions'), { recursive: true, mode: 0o700 })
        await atomicSavedWrite(target, data)
      }
    },
    seal: deps.seal,
    open: deps.open,
    scope
  })
  const service = createSuggestionService({
    store,
    scope,
    enabled: deps.enabled,
    sources: deps.sources,
    now: deps.now ?? Date.now,
    newId: () => randomBytes(12).toString('hex'),
    newNonce: () => randomBytes(16).toString('hex'),
    notify: deps.notify,
    audit: deps.audit
  })
  registerSuggestionsIpc({
    ipcMain: deps.ipcMain,
    authorizeSender: deps.authorizeSender,
    requireAuth: deps.requireAuth,
    service
  })
  // The disposers are discarded on purpose: these bindings live for the app lifetime.
  deps.ownerSession.onRevoked(() => service.onOwnerChange())
  ;(deps.onPartitionChange ?? onMemoryPartitionChange)(() => service.onOwnerChange())
  return service
}
