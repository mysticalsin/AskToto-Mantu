import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { IpcMain } from 'electron'
import {
  createConversationService,
  createConversationStore,
  type ConversationAuditPhase
} from '../features/conversations'
import type { AssistantService } from '../features/assistants'
import { atomicSavedWrite } from '../infra/storage/atomic-saved-write'
import type { SealedScopedIo } from '../infra/storage/sealed-scoped-store'
import { registerConversationsIpc } from '../ipc/conversations-ipc'
import type { AuthorizeSender } from '../ipc/sender-auth'
import { ownerPartitionScope } from './owner-partition-scope'

export interface ConversationsWiringDeps {
  ipcMain: Pick<IpcMain, 'handle'>
  authorizeSender: AuthorizeSender
  requireAuth(): boolean
  ownerSession: { currentOwnerKey(): string | null; currentTenantKey(): string | null }
  userDataPath(): string
  /** The app's own secret sealing (`encryptSecret` / `decryptSecret`). */
  seal(plain: string): Buffer
  open(sealed: Buffer): string
  /** The owner's assistants (system assistants included), read only. */
  assistants: Pick<AssistantService, 'list'>
  /** The saved meetings, read only. */
  meetings(): Promise<ReadonlyArray<{ file: string }>>
  /** The remote (Dust) conversation epoch, whether one is held, and its time to live. */
  remote(): { epoch: number; active: boolean; ttlMs: number }
  audit(record: { phase: ConversationAuditPhase; reason?: string; count?: number }): void
  /** Defaults to G19's partition in force; a test seam. */
  partition?(): string | null
  now?(): number
}

const PARTITION = /^(?:legacy|[0-9a-f]{24})$/
const CONVERSATION = /^c_[0-9a-f]{32}$/

/**
 * Builds the conversation store and service (G49) under `<userData>/conversations/<partition>.bin` (the index: records
 * and drafts) and `<userData>/conversations/<partition>/<conversationId>.bin` (one turn file per conversation), both
 * sealed, and registers its IPC behind the shared sender authorizer. Both path segments are validated by pattern, so no
 * renderer-influenced string can escape the directory. Hangs off `createOwnerSessionWiring`, so index.ts gains no lines.
 *
 * With no verified owner key, tenant key and open partition there is no scope and every call is refused as signed out.
 * The service holds no state between calls, so an owner switch needs no reset: a call in flight when the scope changes
 * is refused as stale by the store.
 */
export function bootstrapConversations(deps: ConversationsWiringDeps) {
  const scope = ownerPartitionScope({ ownerSession: deps.ownerSession, partition: deps.partition })
  const root = (): string => join(deps.userDataPath(), 'conversations')
  const partitionOf = (partitionId: string): string => {
    if (!PARTITION.test(partitionId)) throw new Error('invalid memory partition')
    return partitionId
  }
  const fileOf = (partitionId: string, name?: string): { dir: string; target: string } => {
    const partition = partitionOf(partitionId)
    if (name === undefined) return { dir: root(), target: join(root(), `${partition}.bin`) }
    if (!CONVERSATION.test(name)) throw new Error('invalid conversation id')
    return { dir: join(root(), partition), target: join(root(), partition, `${name}.bin`) }
  }
  const io: SealedScopedIo = {
    async read(partitionId, name) {
      try {
        return await readFile(fileOf(partitionId, name).target)
      } catch (error) {
        if ((error as { code?: unknown } | null)?.code === 'ENOENT') return null
        throw error
      }
    },
    async write(partitionId, data, name) {
      const { dir, target } = fileOf(partitionId, name)
      await mkdir(dir, { recursive: true, mode: 0o700 })
      await atomicSavedWrite(target, data)
    }
  }
  const service = createConversationService({
    store: createConversationStore({ indexIo: io, turnIo: io, seal: deps.seal, open: deps.open, scope }),
    scope,
    now: deps.now ?? Date.now,
    assistants: async () => {
      const listed = await deps.assistants.list()
      if (!listed.ok) throw new Error('assistants unavailable')
      return listed.assistants.map((a) => ({ id: a.assistantId, archived: a.archived }))
    },
    meetings: async () => (await deps.meetings()).map((row) => row.file),
    remote: deps.remote,
    audit: (phase, detail) => deps.audit({ phase, ...detail })
  })
  registerConversationsIpc({
    ipcMain: deps.ipcMain,
    authorizeSender: deps.authorizeSender,
    requireAuth: deps.requireAuth,
    service
  })
  return service
}
