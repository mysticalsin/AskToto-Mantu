import { app } from 'electron'
import { join } from 'node:path'
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
    execute: (request) => executeDesktopAction(request),
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

/** The executor and boot-recovery hook CommandConfirmation needs, backed by one production bridge. */
export function desktopActionTaskDeps(): Pick<CommandConfirmationDeps, 'execute' | 'recoverTasks'> {
  const bridge = createDesktopActionTaskBridge()
  return { execute: bridge.execute, recoverTasks: bridge.recover }
}
