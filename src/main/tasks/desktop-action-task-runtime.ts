import { app } from 'electron'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createProductionDesktopAdapterDeps } from '../desktop-adapter-deps'
import { executeDesktopAction } from '../desktop-adapters'
import { authSessionGeneration } from '../auth'
import { auditLog, mainLog } from '../logger'
import { atomicSavedWrite } from '../infra/storage/atomic-saved-write'
import { decryptSecret, encryptSecret } from '../secrets'
import type { CommandConfirmationDeps } from '../command-confirmation'
import { DesktopActionTaskBridge, type DesktopActionTaskBridgeDeps } from './desktop-action-task-bridge'
import { createEncryptedTaskFileStore } from './encrypted-task-file-store'

/** Task ids the person has been told about (random hex, no arguments), so boot recovery announces each once. */
function createAcknowledgementStore(file: () => string): NonNullable<DesktopActionTaskBridgeDeps['acknowledgements']> {
  return {
    async read() {
      try {
        const parsed: unknown = JSON.parse(await readFile(file(), 'utf8'))
        return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string').slice(0, 512) : []
      } catch {
        return []
      }
    },
    async write(ids) {
      await mkdir(dirname(file()), { recursive: true })
      await atomicSavedWrite(file(), Buffer.from(JSON.stringify(ids.slice(0, 512))))
    }
  }
}

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
    acknowledgements: createAcknowledgementStore(() => join(app.getPath('userData'), 'desktop-action-acks.json')),
    authSessionGeneration,
    audit: (event, metadata) => auditLog(event, metadata),
    log: mainLog
  })
}

type DesktopActionTaskDeps = Pick<CommandConfirmationDeps, 'execute' | 'recoverTasks' | 'stopTasks'> & {
  takeRecoveryNotices: DesktopActionTaskBridge['takeRecoveryNotices']
}
let sharedDeps: DesktopActionTaskDeps | null = null

/**
 * The executor and boot-recovery hook CommandConfirmation needs, backed by ONE production bridge for the process.
 * Voice actions dispatch through the same bridge, so a confirmed command and a spoken immediate run share one task
 * archive and one set of uncertain tasks, and an uncertain task is never replayed by either.
 */
export function desktopActionTaskDeps(): DesktopActionTaskDeps {
  if (!sharedDeps) {
    const bridge = createDesktopActionTaskBridge()
    sharedDeps = {
      execute: bridge.execute,
      recoverTasks: bridge.recover,
      stopTasks: bridge.stop.bind(bridge),
      takeRecoveryNotices: bridge.takeRecoveryNotices.bind(bridge)
    }
  }
  return sharedDeps
}
