import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { IPC } from '@shared/ipc'

interface OperatorReportingIpcDependencies {
  ipcMain: Pick<IpcMain, 'handle'>
  assertMainWindow: (event: IpcMainInvokeEvent) => void
  snapshot: () => { status: string; origin: string | null; state: string }
}

/** Organisation reporting state for Settings and onboarding. Status, origin and state only, never a credential. */
export function registerOperatorReportingIpc(deps: OperatorReportingIpcDependencies): void {
  deps.ipcMain.handle(IPC.operatorReportingStatus, (event) => {
    deps.assertMainWindow(event)
    return deps.snapshot()
  })
}
