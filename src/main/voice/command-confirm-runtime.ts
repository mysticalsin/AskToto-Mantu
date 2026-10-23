/**
 * Production composition of the confirmation card's main-process plumbing (V04): the durable task bridge, the
 * preflight, the focus exception's controller and assistive-technology lifetime, as one object index.ts spreads
 * into CommandConfirmation. Electron, the mac helper and the foreground watcher are touched only here.
 */
import { app } from 'electron'
import type { TrustedInputOwner } from '@shared/input-session'
import type { MetisCommandRecoveryNotice } from '@shared/metis-command-contract'
import type { CommandConfirmationDeps } from '../command-confirmation'
import { startForegroundWatcher, type ForegroundWatcher } from '../foreground-watcher'
import { createDesktopPermissionProbes } from '../desktop-permission-probes'
import { activatePid } from '../mac-helper'
import { mainLog } from '../logger'
import type { TaskCardRuntime } from '../ipc/task-card-ipc'
import {
  desktopActionTaskCards,
  desktopActionTaskDeps,
  setDesktopActionGestureSource
} from '../tasks/desktop-action-task-runtime'
import { createGestureBindings } from './gesture-binding'
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
  // stopTasks is required here, not optional: dropping it would leave Stop, sign-out and lock unable to reach queued
  // and running desktop tasks (G32) while everything still type-checks.
  deps: Pick<CommandConfirmationDeps, 'execute' | 'recoverTasks' | 'preflight' | 'card' | 'isAssistiveTechnologyOn'> &
    Required<Pick<CommandConfirmationDeps, 'stopTasks'>>
  takeRecoveryNotices(): Promise<MetisCommandRecoveryNotice[]>
  /** G33: the sidecar's task cards, served by the same shared bridge. */
  taskCards: TaskCardRuntime
  /** G34: the owner started a gesture (hold chord, panel command). Main captures what is in front right now. */
  gestureStarted(owner: TrustedInputOwner, sessionId: string): void
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
  const gestures = createGestureBindings({ frontmost: () => ensureWatcher().current() })
  setDesktopActionGestureSource({
    bindingFor: (webContentsId) => gestures.current(webContentsId),
    // A watcher that has given up reports null, and a bound task then refuses rather than trusting a stale app.
    currentTarget: () => (ensureWatcher().healthy() ? ensureWatcher().current() : null)
  })
  const platform = process.platform
  // The same probes the adapters read inside a dispatch (desktop-permission-probes.ts): one source of truth.
  const probes = createDesktopPermissionProbes(platform)
  const preflight = createCommandPreflight({
    platform,
    isAuthenticated: options.isAuthenticated,
    isRecordingMeeting: options.isRecordingMeeting,
    ...probes
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
      stopTasks: () => {
        gestures.clear()
        tasks.stopTasks()
      },
      preflight: (request, stage) => {
        ensureWatcher()
        return preflight(request, stage)
      },
      card: focus,
      isAssistiveTechnologyOn: () => app.isAccessibilitySupportEnabled()
    },
    takeRecoveryNotices: tasks.takeRecoveryNotices,
    taskCards: desktopActionTaskCards(),
    gestureStarted: (owner, sessionId) => {
      gestures.begin({ webContentsId: owner.webContentsId, revision: owner.contextRevision }, sessionId)
    },
    dispose: () => {
      setDesktopActionGestureSource(null)
      gestures.clear()
      watcher?.stop()
    }
  }
}
