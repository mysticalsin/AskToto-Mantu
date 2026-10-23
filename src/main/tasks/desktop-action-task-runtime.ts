import { app } from 'electron'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createProductionDesktopAdapterDeps } from '../desktop-adapter-deps'
import { executeDesktopAction } from '../desktop-adapters'
import { authSessionGeneration } from '../auth'
import { auditLog, mainLog } from '../logger'
import { QA_IDENTITY_BUILD } from '../qa-identity'
import { createQaDesktopSink, qaDesktopSinkEnabled } from '../qa-voice-hooks'
import { atomicSavedWrite } from '../infra/storage/atomic-saved-write'
import { decryptSecret, encryptSecret } from '../secrets'
import type { CommandConfirmationDeps } from '../command-confirmation'
import {
  DesktopActionTaskBridge,
  type DesktopActionGestureGate,
  type DesktopActionTaskBridgeDeps
} from './desktop-action-task-bridge'
import type { TaskCardRuntime } from '../ipc/task-card-ipc'
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
 * G34: the gesture source the one production bridge reads. The confirm runtime installs it once it owns the
 * foreground watcher. Until then (or without one) there is no binding, so a command is not constrained by a gesture.
 */
let gestureSource: Omit<DesktopActionGestureGate, 'ownPid'> | null = null
export function setDesktopActionGestureSource(source: Omit<DesktopActionGestureGate, 'ownPid'> | null): void {
  gestureSource = source
}

/**
 * Production composition for confirmed desktop commands. Task history lives in userData, encrypted with the
 * per-install AES-256-GCM key that already protects settings and meeting envelopes (secrets.ts), and is replaced
 * atomically. Paths resolve lazily because userData can be redirected after this module loads.
 */
export function createDesktopActionTaskBridge(): DesktopActionTaskBridge {
  // QA-identity builds only (V08, compiled out of shipping bytes): the acceptance run records dispatches in a sink so
  // the sandbox never opens the owner's real Notes, browser or camera. Everything above the executor stays real.
  const qaSink =
    QA_IDENTITY_BUILD &&
    qaDesktopSinkEnabled({ qaIdentity: QA_IDENTITY_BUILD, packaged: app.isPackaged, env: process.env })
      ? createQaDesktopSink((event, detail) => auditLog(event, detail))
      : null
  return new DesktopActionTaskBridge({
    // The envelope main derived rides along so a verified outcome can carry a receipt bound to this dispatch.
    execute: (request, envelope, signal) =>
      qaSink
        ? qaSink(request, envelope)
        : executeDesktopAction(request, { envelope, deps: createProductionDesktopAdapterDeps(), signal }),
    store: createEncryptedTaskFileStore({
      file: () => join(app.getPath('userData'), 'desktop-action-tasks.bin'),
      encrypt: encryptSecret,
      decrypt: decryptSecret,
      atomicWrite: (file, data) => atomicSavedWrite(file, data)
    }),
    acknowledgements: createAcknowledgementStore(() => join(app.getPath('userData'), 'desktop-action-acks.json')),
    authSessionGeneration,
    gesture: {
      bindingFor: (webContentsId) => gestureSource?.bindingFor(webContentsId) ?? null,
      currentTarget: () => gestureSource?.currentTarget() ?? null,
      ownPid: process.pid
    },
    audit: (event, metadata) => auditLog(event, metadata),
    log: mainLog
  })
}

type DesktopActionTaskDeps = Pick<CommandConfirmationDeps, 'execute' | 'recoverTasks'> &
  Required<Pick<CommandConfirmationDeps, 'stopTasks'>> & {
    takeRecoveryNotices: DesktopActionTaskBridge['takeRecoveryNotices']
  }
let sharedDeps: DesktopActionTaskDeps | null = null
let sharedBridge: DesktopActionTaskBridge | null = null

function desktopActionBridge(): DesktopActionTaskBridge {
  sharedBridge ??= createDesktopActionTaskBridge()
  return sharedBridge
}

/**
 * The executor and boot-recovery hook CommandConfirmation needs, backed by ONE production bridge for the process.
 * Voice actions dispatch through the same bridge, so a confirmed command and a spoken immediate run share one task
 * archive and one set of uncertain tasks, and an uncertain task is never replayed by either.
 */
export function desktopActionTaskDeps(): DesktopActionTaskDeps {
  if (!sharedDeps) {
    const bridge = desktopActionBridge()
    sharedDeps = {
      execute: bridge.execute,
      recoverTasks: bridge.recover,
      stopTasks: bridge.stop.bind(bridge),
      takeRecoveryNotices: bridge.takeRecoveryNotices.bind(bridge)
    }
  }
  return sharedDeps
}

/** The task cards of the same shared bridge, for the sidecar's IPC (G33). */
export function desktopActionTaskCards(): TaskCardRuntime {
  const bridge = desktopActionBridge()
  return {
    cards: (owner) => bridge.cards(owner),
    stopCard: (owner, cardId) => bridge.stopCard(owner, cardId),
    dismissCard: (owner, cardId) => bridge.dismissCard(owner, cardId),
    onCardsChanged: (listener) => bridge.onCardsChanged(listener)
  }
}
