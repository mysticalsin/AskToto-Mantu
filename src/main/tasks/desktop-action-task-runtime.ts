import { app } from 'electron'
import { join } from 'node:path'
import { createProductionDesktopAdapterDeps } from '../desktop-adapter-deps'
import { executeDesktopAction } from '../desktop-adapters'
import { authSessionGeneration } from '../auth'
import { auditLog, mainLog } from '../logger'
import { atomicSavedWrite } from '../infra/storage/atomic-saved-write'
import { decryptSecret, encryptSecret } from '../secrets'
import type { CommandConfirmationDeps } from '../command-confirmation'
import { DesktopActionTaskBridge } from './desktop-action-task-bridge'
import { createEncryptedTaskFileStore } from './encrypted-task-file-store'

/**
 * Production composition for confirmed desktop commands. Task history lives in userData, encrypted with the
 * per-install AES-256-GCM key that already protects settings and meeting envelopes (secrets.ts), and is replaced
 * atomically. Paths resolve lazily because userData can be redirected after this module loads.
 */
export function createDesktopActionTaskBridge(): DesktopActionTaskBridge {
  return new DesktopActionTaskBridge({
    // The envelope main derived rides along so a verified outcome can carry a receipt bound to this dispatch.
    execute: (request, envelope) =>
      executeDesktopAction(request, { envelope, deps: createProductionDesktopAdapterDeps() }),
    store: createEncryptedTaskFileStore({
      file: () => join(app.getPath('userData'), 'desktop-action-tasks.bin'),
      encrypt: encryptSecret,
      decrypt: decryptSecret,
      atomicWrite: (file, data) => atomicSavedWrite(file, data)
    }),
    authSessionGeneration,
    audit: (event, metadata) => auditLog(event, metadata),
    log: mainLog
  })
}

let sharedDeps: Pick<CommandConfirmationDeps, 'execute' | 'recoverTasks'> | null = null

/**
 * The executor and boot-recovery hook CommandConfirmation needs, backed by ONE production bridge for the process.
 * Voice actions dispatch through the same bridge, so a confirmed command and a spoken immediate run share one task
 * archive and one set of uncertain tasks, and an uncertain task is never replayed by either.
 */
export function desktopActionTaskDeps(): Pick<CommandConfirmationDeps, 'execute' | 'recoverTasks'> {
  if (!sharedDeps) {
    const bridge = createDesktopActionTaskBridge()
    sharedDeps = { execute: bridge.execute, recoverTasks: bridge.recover }
  }
  return sharedDeps
}
