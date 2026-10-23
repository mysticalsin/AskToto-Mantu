import { join } from 'node:path'
import type { IpcMain } from 'electron'
import { createMemoryKeyring, type DictationKeyCustody } from '../features/dictation'
import { createUserMemory, createUserMemoryStore, installUserMemory, type UserMemory } from '../features/user-memory'
import {
  generateContentKey,
  readWrappedKeyFile,
  unwrapContentKey,
  wrapContentKey,
  writeWrappedKeyFile
} from '../infra/security/content-key-wrap'
import { registerUserMemoryIpc } from '../ipc/user-memory-ipc'
import type { AuthorizeSender } from '../ipc/sender-auth'
import { memoryAccess } from '../memory-partition/memory-access'

export interface UserMemoryWiringDeps {
  ipcMain: Pick<IpcMain, 'handle'>
  authorizeSender: AuthorizeSender
  requireAuth(): boolean
  userDataPath(): string
  audit(record: { action: 'correct' | 'delete'; ok: boolean }): void
  /** Defaults to the real wrap/unwrap in `content-key-wrap.ts`; a test seam. */
  keys?: DictationKeyCustody
  /** Defaults to G19's partition in force; a test seam. */
  partition?(): string | null
}

const DEFAULT_KEYS: DictationKeyCustody = {
  generate: generateContentKey,
  wrap: wrapContentKey,
  unwrap: (wrapped) => unwrapContentKey(wrapped),
  writeFile: writeWrappedKeyFile,
  readFile: readWrappedKeyFile
}

function activePartition(): string | null {
  const access = memoryAccess()
  return access.status === 'ok' ? access.partitionId : null
}

/**
 * Builds the user memory (G57) under `<userData>/user-memory/` (its own sealed key, one sealed file per memory
 * partition), registers its IPC behind the shared sender authorizer and installs it for the ask path, which resolves it
 * on every turn. Reads and writes follow the partition in force, so an account switch or a sign-out reaches another
 * owner's file never. Hangs off `createOwnerSessionWiring`, so index.ts gains no lines.
 */
export function bootstrapUserMemory(deps: UserMemoryWiringDeps): UserMemory {
  const root = join(deps.userDataPath(), 'user-memory')
  const store = createUserMemoryStore({
    rootDir: () => root,
    keyring: createMemoryKeyring({ keyPath: join(root, 'key.v1'), keys: deps.keys ?? DEFAULT_KEYS }),
    partition: deps.partition ?? activePartition,
    now: Date.now
  })
  const memory = createUserMemory(store)
  registerUserMemoryIpc({
    ipcMain: deps.ipcMain,
    authorizeSender: deps.authorizeSender,
    requireAuth: deps.requireAuth,
    memory,
    audit: deps.audit
  })
  installUserMemory(memory)
  return memory
}
