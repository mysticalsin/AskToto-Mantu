/**
 * Production composition of the confirmation card's main-process plumbing (V04): the durable task bridge, the
 * preflight, the focus exception's controller and assistive-technology lifetime, as one object index.ts spreads
 * into CommandConfirmation. Electron, the mac helper and the foreground watcher are touched only here.
 */
import { app, systemPreferences } from 'electron'
import type { MetisCommandRecoveryNotice } from '@shared/metis-command-contract'
import type { CommandConfirmationDeps } from '../command-confirmation'
import { startForegroundWatcher, type ForegroundWatcher } from '../foreground-watcher'
import { activatePid, askAutomation, getBundleCopies, getTccStatus } from '../mac-helper'
import { mainLog } from '../logger'
import { desktopActionTaskDeps } from '../tasks/desktop-action-task-runtime'
import { createCommandPreflight } from './command-preflight'
import { createConfirmFocus } from './confirm-focus'

export interface CommandConfirmRuntimeOptions {
  isAuthenticated(): boolean
  isRecordingMeeting(): boolean
  /** index.ts's third focus exception: un-park the overlay, then show and focus it. */
  showForConfirm(): void
  /** Windows: blur the overlay so the system returns to the previous window. */
  blurWindow(): void
}

export interface CommandConfirmRuntime {
  deps: Pick<CommandConfirmationDeps, 'execute' | 'recoverTasks' | 'preflight' | 'card' | 'isAssistiveTechnologyOn'>
  takeRecoveryNotices(): Promise<MetisCommandRecoveryNotice[]>
  dispose(): void
}

export function createCommandConfirmRuntime(options: CommandConfirmRuntimeOptions): CommandConfirmRuntime {
  const tasks = desktopActionTaskDeps()
  let watcher: ForegroundWatcher | null = null
  // Started at the first proposal, so a person who never uses voice actions never pays for a second watcher
  // process. Its initial emit lands while the propose-stage preflight runs, before the card takes focus.
  const ensureWatcher = (): ForegroundWatcher => {
    watcher ??= startForegroundWatcher(() => {}, {
      onError: (message) => mainLog.warn(`[command-confirm] foreground watcher: ${message}`)
    })
    return watcher
  }
  const platform = process.platform
  const preflight = createCommandPreflight({
    platform,
    isAuthenticated: options.isAuthenticated,
    isRecordingMeeting: options.isRecordingMeeting,
    appInstalled: async (bundleId) => {
      const copies = await getBundleCopies(bundleId)
      return copies === null ? null : copies.length > 0
    },
    automationStatus: (bundleId, { ask }) => (ask ? askAutomation(bundleId) : getTccStatus('automation', bundleId)),
    accessibilityTrusted: () => platform !== 'darwin' || systemPreferences.isTrustedAccessibilityClient(false)
  })
  const focus = createConfirmFocus({
    platform,
    ownPid: process.pid,
    frontmost: () => ensureWatcher().current(),
    showForConfirm: options.showForConfirm,
    activatePid,
    blurWindow: options.blurWindow
  })
  return {
    deps: {
      execute: tasks.execute,
      recoverTasks: tasks.recoverTasks,
      preflight: (request, stage) => {
        ensureWatcher()
        return preflight(request, stage)
      },
      card: focus,
      isAssistiveTechnologyOn: () => app.isAccessibilitySupportEnabled()
    },
    takeRecoveryNotices: tasks.takeRecoveryNotices,
    dispose: () => watcher?.stop()
  }
}
