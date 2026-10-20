import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { IPC } from '@shared/ipc'
import type { RecoveredDraftCount, RecoveredDraftCountSnapshot } from '../recovered-draft-count'

interface RecoveredDraftCountIpcDependencies {
  ipcMain: Pick<IpcMain, 'handle'>
  assertMainWindow: (event: IpcMainInvokeEvent) => void
  requireAuth: () => boolean
  counter: Pick<RecoveredDraftCount, 'snapshot'>
}

/** The authenticated snapshot query the renderer uses to recover a count it missed while not listening. */
export function registerRecoveredDraftCountIpc(deps: RecoveredDraftCountIpcDependencies): void {
  deps.ipcMain.handle(IPC.recoveredDraftCount, (event): RecoveredDraftCountSnapshot => {
    deps.assertMainWindow(event)
    return deps.counter.snapshot(deps.requireAuth())
  })
}
