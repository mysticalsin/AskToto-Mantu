/**
 * history-ipc.ts — the History list, search and open-in-editor handlers.
 *
 * Moved verbatim from the main entry point. Each handler keeps its main-window sender gate and sign-in
 * gate; the list request is traced through the History tracer the caller owns (see history-trace-ipc.ts).
 */
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { IPC } from '@shared/ipc'
import { getSettings } from '../store'
import { auditLog } from '../logger'
import { safeMeetingBasename } from '../meeting-path'
import { resolveMeetingsFolder } from '../transcripts'
import { meetingOpenTarget } from '../history-actions'
import { listMeetings, searchMeetingsLatest } from '../history-read'
import { openExplicitly } from '../recall'
import type { HistoryTracer } from '../infra/observability/history-trace'

export interface HistoryIpcDependencies {
  ipcMain: Pick<IpcMain, 'handle'>
  /** Main-window top frame only. */
  assertMainWindow: (event: IpcMainInvokeEvent) => void
  requireAuth: () => boolean
  history: Pick<HistoryTracer, 'traceList'>
  /** OS open of a file; resolves to an error string, or '' on success. */
  openPath: (path: string) => Promise<string>
}

export function registerHistoryIpc(deps: HistoryIpcDependencies): void {
  const { ipcMain, assertMainWindow, requireAuth, history, openPath } = deps
  ipcMain.handle(IPC.recallList, (e, trace: unknown) => {
    assertMainWindow(e)
    return history.traceList(trace, () => (requireAuth() ? listMeetings() : Promise.resolve([])))
  })
  ipcMain.handle(IPC.recallSearch, (e, q: string) => {
    assertMainWindow(e)
    return requireAuth() ? searchMeetingsLatest(String(q ?? '')) : { hits: [], total: 0 }
  })
  ipcMain.handle(IPC.recallOpen, async (e, file: string) => {
    assertMainWindow(e)
    if (!requireAuth()) return ''
    const folder = resolveMeetingsFolder(getSettings())
    const safeName = safeMeetingBasename(file)
    // Only ever open Métis's own .md meeting transcripts. The meetings folder is user-chosen
    // (could be Desktop/Downloads), and shell.openPath launches the OS handler for whatever it finds,
    // which would execute a .command/.app/.exe. Mirror deleteMeeting()/debriefSave()'s .md guard.
    if (!safeName) return ''
    // Encrypted transcripts are unreadable in an editor — the target is a decrypted temp copy instead.
    const target = await openExplicitly(
      safeName,
      (event) => e.sender.send(IPC.recallHydration, event),
      (options) => meetingOpenTarget(folder, safeName, options)
    )
    if (!target.ok) return target.error
    auditLog('recall.open', { encrypted: target.encrypted })
    return openPath(target.path)
  })
}
