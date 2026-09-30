/**
 * AppContext: the main process's composition seam. A plain object built once in index.ts and passed
 * explicitly to the modules extracted from it (IPC guards, handler registration); it is not a DI container,
 * a service locator or an event bus, and nothing reads it through a module-level singleton.
 *
 * INV-LAZY: window accessors read the live binding on every call. The main window is created, destroyed
 * and recreated (crash recovery, onboarding hand-off) after the context exists, so a captured
 * BrowserWindow reference would go stale; mainWindow() always returns what index.ts holds right now.
 */
import type { BrowserWindow } from 'electron'
import type { Settings } from '@shared/ipc'
import type { AuditSink } from '../logger'
import type { StorageGateway } from '../infra/storage/gateway'

export interface AppContext {
  /** The overlay (main) window as index.ts holds it at call time; null before creation or after a failed create. */
  readonly mainWindow: () => BrowserWindow | null
  /** mainWindow() when it exists and is not destroyed, otherwise null. */
  readonly liveMainWindow: () => BrowserWindow | null
  /** set is index.ts's policy-enforcing writer (Speaker Intelligence revocation included), never the raw store write. */
  readonly settings: {
    readonly get: () => Settings
    readonly set: (patch: Partial<Settings>) => Settings
  }
  readonly audit: AuditSink
  /** Teardown of every child process this app owns; signal-only and idempotent. */
  readonly supervisor: { readonly stopAll: () => void }
  /** The storage gateway for the meetings root the current settings resolve to. */
  readonly gateway: () => StorageGateway
  /** Unattended work runs through the maintenance gate. */
  readonly scheduler: { readonly runAsMaintenance: <T>(work: () => T | Promise<T>) => Promise<T> }
  readonly clock: { readonly now: () => number }
}

export type AppContextDeps = Omit<AppContext, 'liveMainWindow'>

export function createAppContext(deps: AppContextDeps): AppContext {
  const { mainWindow } = deps
  return Object.freeze({
    mainWindow: () => mainWindow(),
    liveMainWindow: () => {
      const w = mainWindow()
      return w && !w.isDestroyed() ? w : null
    },
    settings: Object.freeze({ get: deps.settings.get, set: deps.settings.set }),
    audit: deps.audit,
    supervisor: Object.freeze({ stopAll: deps.supervisor.stopAll }),
    gateway: deps.gateway,
    scheduler: Object.freeze({ runAsMaintenance: deps.scheduler.runAsMaintenance }),
    clock: Object.freeze({ now: deps.clock.now })
  })
}
