import { join } from 'node:path'
import type { IpcMain } from 'electron'
import { isSummaryOnlyProfile, resolveEnterpriseLiveProfile } from '@shared/enterprise-live-profile'
import { resolveDictationEnabled } from '@shared/dictation-options'
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
import { memoryAccess, onMemoryPartitionChange } from '../memory-partition/memory-access'
import { registerDictationMemoryIpc } from '../ipc/dictation-memory-ipc'
import type { AuthorizeSender } from '../ipc/sender-auth'
import type { SettingsObservation } from '../settings-observation'

export interface DictationMemoryWiringDeps {
  ipcMain: Pick<IpcMain, 'handle'>
  authorizeSender: AuthorizeSender
  requireAuth(): boolean
  ownerSession: { onRevoked(cb: (ref: OwnerSessionRef, reason: OwnerSessionRevokeReason) => void): () => void }
  userDataPath(): string
  /** The last published settings (managed policy already merged in), or null before any. */
  readSettings(): SettingsObservation | null
  /** The QA-identity build turns dictation on by default; release builds follow the owner flag. */
  qaIdentity: boolean
  audit(record: DictationMemoryAuditRecord): void
  onWillQuit(listener: () => void): void
  /** Defaults to the real wrap/unwrap in `content-key-wrap.ts`; a test seam. */
  keys?: DictationKeyCustody
  /** Defaults to G19's partition in force (`memoryAccess()`); a test seam. */
  partition?(): string | null
  /** Subscribes to a change of the partition in force; defaults to G19's. A test seam. */
  onPartitionChange?(listener: () => void): () => void
}

const DEFAULT_KEYS: DictationKeyCustody = {
  generate: generateContentKey,
  wrap: wrapContentKey,
  unwrap: (wrapped) => unwrapContentKey(wrapped),
  writeFile: writeWrappedKeyFile,
  readFile: readWrappedKeyFile
}

/** G19's partition in force: its id, or null while none is open (signed out, unverified, a switch in flight). */
function activePartition(): string | null {
  const access = memoryAccess()
  return access.status === 'ok' ? access.partitionId : null
}

/**
 * Whether dictated text may be recorded or learned right now. Fails closed: signed out, an unreadable or absent
 * settings snapshot, dictation not effectively on (the person's or the organization's choice) and a managed
 * summary-only profile (the organization chose that no transcript is kept) all say no.
 */
export function dictationMemoryAllowed(
  published: SettingsObservation | null,
  signedIn: boolean,
  qaIdentity: boolean
): boolean {
  if (!signedIn || !published || !published.readable) return false
  const settings = published.settings
  if (!resolveDictationEnabled(settings.voiceActions?.dictation, { qaIdentity })) return false
  return dictationTextAtRest(published) === 'allowed'
}

/** Whether dictated text may exist at rest: a managed summary-only profile keeps no text, so it is `denied`. */
export function dictationTextAtRest(published: SettingsObservation | null): 'allowed' | 'denied' | 'unknown' {
  if (!published || !published.readable) return 'unknown'
  const summaryOnly = isSummaryOnlyProfile(
    resolveEnterpriseLiveProfile(published.settings.enterpriseLive ?? published.settings)
  )
  return summaryOnly ? 'denied' : 'allowed'
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
    partition: deps.partition ?? activePartition,
    enabled: () => dictationMemoryAllowed(deps.readSettings(), deps.requireAuth(), deps.qaIdentity),
    atRest: () => dictationTextAtRest(deps.readSettings()),
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
  // An account switch: the correction window of the previous partition's person is forgotten at once.
  ;(deps.onPartitionChange ?? onMemoryPartitionChange)(() => memory.onOwnerRevoked())
  deps.onWillQuit(() => {
    void memory
      .flush()
      .then(() => memory.dispose())
      .catch(() => undefined)
  })
  void memory.launch().catch(() => undefined)
  return memory
}
