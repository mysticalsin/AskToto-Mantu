import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { IpcMain } from 'electron'
import {
  createAssistantService,
  createAssistantStore,
  type AssistantService,
  type CustomMode
} from '../features/assistants'
import type { AssistantAuditPhase } from '../features/assistants'
import type { InterviewAuditPhase } from '../features/onboarding'
import { atomicSavedWrite } from '../infra/storage/atomic-saved-write'
import { registerAssistantsIpc } from '../ipc/assistants-ipc'
import type { AuthorizeSender } from '../ipc/sender-auth'
import { memoryAccess, memoryPartitionsConfigured, onMemoryPartitionChange } from '../memory-partition/memory-access'
import { bootstrapOnboardingInterview } from './onboarding-interview-wiring'
import { ownerPartitionScope } from './owner-partition-scope'

export interface AssistantsWiringDeps {
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
  /** The person's custom modes, shown as read-only system assistants beside the built-in ones. */
  customModes(): readonly CustomMode[]
  /** The saved meetings (their own ids and modes). Read only. */
  meetings(): Promise<ReadonlyArray<{ file: string; mode: string }>>
  audit(record: { phase: AssistantAuditPhase; reason?: string; count?: number }): void
  /** The G56 onboarding interview's audit: phase tokens and counts only. */
  onboardingAudit?(record: { phase: InterviewAuditPhase; reason?: string; count?: number }): void
  /** Defaults to G19's partition in force; a test seam. */
  partition?(): string | null
  /** Subscribes to a change of the partition in force; defaults to G19's. A test seam. */
  onPartitionChange?(listener: () => void): () => void
  now?(): number
}

/**
 * Builds the assistant store and service (G48) under `<userData>/assistants/<partition>.bin` (sealed, one file per
 * memory partition, so the file itself belongs to the verified tenant and user), registers its IPC behind the shared
 * sender authorizer, and forgets pending proposals when the owner is revoked or the partition changes. Hangs off
 * `createOwnerSessionWiring`, so index.ts gains no lines.
 *
 * Without a verified owner key, tenant key and an open partition there is no scope and every call is refused as signed
 * out: assistants are not available to an installation that has no sign-in.
 */
export function bootstrapAssistants(deps: AssistantsWiringDeps): AssistantService {
  const scope = ownerPartitionScope({ ownerSession: deps.ownerSession, partition: deps.partition })
  const file = (partitionId: string): string => {
    if (!/^(?:legacy|[0-9a-f]{24})$/.test(partitionId)) throw new Error('invalid memory partition')
    return join(deps.userDataPath(), 'assistants', `${partitionId}.bin`)
  }
  const store = createAssistantStore({
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
        await mkdir(join(deps.userDataPath(), 'assistants'), { recursive: true, mode: 0o700 })
        await atomicSavedWrite(target, data)
      }
    },
    seal: deps.seal,
    open: deps.open,
    scope
  })
  const service = createAssistantService({
    store,
    scope,
    now: deps.now ?? Date.now,
    customModes: deps.customModes,
    meetings: deps.meetings,
    audit: (phase, detail) => deps.audit({ phase, ...detail })
  })
  registerAssistantsIpc({
    ipcMain: deps.ipcMain,
    authorizeSender: deps.authorizeSender,
    requireAuth: deps.requireAuth,
    service
  })
  // The disposers are discarded on purpose: these bindings live for the app lifetime.
  deps.ownerSession.onRevoked(() => service.onOwnerChange())
  ;(deps.onPartitionChange ?? onMemoryPartitionChange)(() => service.onOwnerChange())
  // G56: the onboarding role interview creates its assistants through this service, under the same scope.
  bootstrapOnboardingInterview({
    ipcMain: deps.ipcMain,
    authorizeSender: deps.authorizeSender,
    requireAuth: deps.requireAuth,
    userDataPath: deps.userDataPath,
    seal: deps.seal,
    open: deps.open,
    scope,
    assistants: service,
    audit: (record) => deps.onboardingAudit?.(record),
    now: deps.now ?? Date.now
  })
  return service
}
