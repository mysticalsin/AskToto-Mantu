/**
 * quit-ipc.ts — the renderer's quit, relaunch and quit-flush acknowledgement channels.
 *
 * Quit and relaunch are sender-checked invokes. The flush ack is one way, so it uses the non-throwing
 * sender check: a throw from a one-way listener becomes a main-process uncaught exception. Only the main
 * window may resolve a pending quit, and the lifecycle makes the resolution idempotent.
 */
import type { App, IpcMain, IpcMainEvent, IpcMainInvokeEvent } from 'electron'
import { IPC } from '@shared/ipc'
import type { QuitTrace } from '../lifecycle/quit-trace'

export interface QuitIpcDependencies {
  ipcMain: Pick<IpcMain, 'handle' | 'on'>
  app: Pick<App, 'quit' | 'relaunch'>
  quitTrace: Pick<QuitTrace, 'mark' | 'requestQuit' | 'call'>
  assertMainWindow: (event: IpcMainInvokeEvent) => void
  isMainWindowSender: (event: IpcMainEvent) => boolean
  /** Called by an explicit quit, whose renderer already saved the live meeting, so before-quit adds no flush. */
  markQuitFlushDone: () => void
  acknowledgeQuitFlush: () => void
}

export function registerQuitIpc(deps: QuitIpcDependencies): void {
  deps.ipcMain.handle(IPC.windowQuit, (event) => {
    deps.assertMainWindow(event)
    deps.quitTrace.mark('IPC_QUIT_RECEIVED')
    deps.quitTrace.requestQuit()
    deps.markQuitFlushDone()
    deps.quitTrace.call('IPC', () => deps.app.quit())
  })
  // A fresh Screen Recording grant only applies to a NEW launch, so Relaunch is that dead end's recovery.
  // It leaves the flush undone: before-quit still saves a live meeting first.
  deps.ipcMain.handle(IPC.windowRelaunch, (event) => {
    deps.assertMainWindow(event)
    deps.app.relaunch()
    deps.app.quit()
  })
  deps.ipcMain.on(IPC.quitFlushDone, (event) => {
    if (!deps.isMainWindowSender(event)) return
    deps.acknowledgeQuitFlush()
  })
}
