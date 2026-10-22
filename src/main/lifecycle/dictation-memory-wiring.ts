import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { IpcMain } from 'electron'
import type { OwnerSessionRef, OwnerSessionRevokeReason } from '@shared/contracts/owner-session'
import {
  createDictationMemory,
  installDictationMemory,
  type DictationKeyCustody,
  type DictationMemory,
  type DictationMemoryAuditRecord
} from '../features/dictation'
import {
  generateContentKey,
  readWrappedKeyFile,
  unwrapContentKey,
  wrapContentKey,
  writeWrappedKeyFile
} from '../infra/security/content-key-wrap'
import { registerDictationMemoryIpc } from '../ipc/dictation-memory-ipc'
import type { AuthorizeSender } from '../ipc/sender-auth'

export interface DictationMemoryWiringDeps {
  ipcMain: Pick<IpcMain, 'handle'>
  authorizeSender: AuthorizeSender
  requireAuth(): boolean
  ownerSession: { onRevoked(cb: (ref: OwnerSessionRef, reason: OwnerSessionRevokeReason) => void): () => void }
  userDataPath(): string
  /** The signed-in owner's key now, or null while signed out. */
  currentOwnerKey(): string | null
  audit(record: DictationMemoryAuditRecord): void
  onWillQuit(listener: () => void): void
  /** Defaults to the real wrap/unwrap in `content-key-wrap.ts`; a test seam. */
  keys?: DictationKeyCustody
}

const DEFAULT_KEYS: DictationKeyCustody = {
  generate: generateContentKey,
  wrap: wrapContentKey,
  unwrap: (wrapped) => unwrapContentKey(wrapped),
  writeFile: writeWrappedKeyFile,
  readFile: readWrappedKeyFile
}

/**
 * The opaque memory partition of the verified person: a one-way digest of the owner key, so no file name carries it.
 * With no owner (signed out, or an install that allows an unsigned profile) it is the local profile partition. This
 * is the typed seam for G19's local memory partition: when that API lands, its id replaces this derivation.
 */
export function dictationPartitionId(ownerKey: string | null): string {
  if (!ownerKey) return 'local'
  return createHash('sha256').update(`dictation-memory:${ownerKey}`).digest('hex').slice(0, 32)
}

/**
 * Builds the dictation memory (G26) under `<userData>/dictation-memory/`, registers its IPC behind the shared sender
 * authorizer, installs it for the dictation runtime (which resolves it on every use) and runs the launch sweep. It
 * forgets the previous person's correction window on owner revocation and flushes its writes at will-quit. Hangs off
 * `createOwnerSessionWiring`, so index.ts gains no lines.
 */
export function bootstrapDictationMemory(deps: DictationMemoryWiringDeps): DictationMemory {
  const memory = createDictationMemory({
    rootDir: () => join(deps.userDataPath(), 'dictation-memory'),
    keys: deps.keys ?? DEFAULT_KEYS,
    partition: () => dictationPartitionId(deps.currentOwnerKey()),
    enabled: () => deps.requireAuth(),
    now: Date.now,
    audit: deps.audit
  })
  registerDictationMemoryIpc({
    ipcMain: deps.ipcMain,
    authorizeSender: deps.authorizeSender,
    requireAuth: deps.requireAuth,
    memory
  })
  installDictationMemory(memory)
  // The disposers are discarded on purpose: these bindings live for the app lifetime.
  deps.ownerSession.onRevoked(() => memory.onOwnerRevoked())
  deps.onWillQuit(() => {
    void memory
      .flush()
      .then(() => memory.dispose())
      .catch(() => undefined)
  })
  void memory.launch().catch(() => undefined)
  return memory
}
