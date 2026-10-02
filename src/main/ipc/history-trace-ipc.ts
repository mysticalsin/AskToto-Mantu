/**
 * history-trace-ipc.ts — the renderer's History observability reports (M2-0215, M2-0032).
 *
 * Every handler checks its sender with the caller's assertMainWindow and audits nothing before sign-in. The
 * tracer validates each report against its schema, so a malformed one is dropped, never persisted.
 */
import { ipcMain } from 'electron'
import { IPC } from '@shared/ipc'
import type { HistoryTracer } from '../infra/observability/history-trace'

type AssertMainWindow = (event: Electron.IpcMainInvokeEvent) => void

export function registerHistoryTraceIpc(assertMainWindow: AssertMainWindow, requireAuth: () => boolean, history: HistoryTracer): void {
  // A History list request settled in the renderer: painted, discarded or failed.
  ipcMain.handle(IPC.historySettled, (e, report: unknown) => {
    assertMainWindow(e)
    if (!requireAuth()) return
    history.settle(report)
  })
  // A committed navigation into or out of History; from === to is the toggle-race no-op.
  ipcMain.handle(IPC.historyTransition, (e, transition: unknown) => {
    assertMainWindow(e)
    if (!requireAuth()) return
    history.transition(transition)
  })
}
