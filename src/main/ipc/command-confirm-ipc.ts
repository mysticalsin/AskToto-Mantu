import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { registerTaskCardIpc, type TaskCardRuntime } from './task-card-ipc'
import { COMMAND_CONFIRM_IPC, type MetisCommandRecoveryNotice } from '@shared/metis-command-contract'

/**
 * Boot-recovery notices for the confirmation card. The renderer asks once when it mounts; each uncertain task is
 * returned once and then counts as acknowledged. The handler sits behind the main-window sender check.
 */
export function registerCommandConfirmIpc(
  ipcMain: Pick<IpcMain, 'handle'>,
  assertMainWindow: (event: IpcMainInvokeEvent) => void,
  runtime: { takeRecoveryNotices(): Promise<MetisCommandRecoveryNotice[]>; taskCards?: TaskCardRuntime },
  /** With the runtime's task cards, the sidecar's card IPC (G33) registers beside the confirmation card's. */
  getWindow?: Parameters<typeof registerTaskCardIpc>[3]
): void {
  ipcMain.handle(COMMAND_CONFIRM_IPC.recoveryNotices, (event) => {
    assertMainWindow(event)
    return runtime.takeRecoveryNotices()
  })
  if (runtime.taskCards && getWindow) registerTaskCardIpc(ipcMain, assertMainWindow, runtime.taskCards, getWindow)
}
