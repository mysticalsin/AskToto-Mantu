import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { COMMAND_CONFIRM_IPC, type MetisCommandRecoveryNotice } from '@shared/metis-command-contract'

/**
 * Boot-recovery notices for the confirmation card. The renderer asks once when it mounts; each uncertain task is
 * returned once and then counts as acknowledged. The handler sits behind the main-window sender check.
 */
export function registerCommandConfirmIpc(
  ipcMain: Pick<IpcMain, 'handle'>,
  assertMainWindow: (event: IpcMainInvokeEvent) => void,
  runtime: { takeRecoveryNotices(): Promise<MetisCommandRecoveryNotice[]> }
): void {
  ipcMain.handle(COMMAND_CONFIRM_IPC.recoveryNotices, (event) => {
    assertMainWindow(event)
    return runtime.takeRecoveryNotices()
  })
}
