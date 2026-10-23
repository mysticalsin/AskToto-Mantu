import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { TASK_BROWSER_IPC, type TaskBrowserOk, type TaskBrowserStatus } from '@shared/task-browser'

/** What Settings needs from the task browser. */
export interface TaskBrowserIpcRuntime {
  status(): TaskBrowserStatus | Promise<TaskBrowserStatus>
  acknowledgeDisclosure(): Promise<void>
  clearProfile(): Promise<boolean>
}

/**
 * Settings' view of the task browser (G41): status, the one-time profile disclosure, and clearing the task profile.
 * Every handler sits behind the main-window sender check. None takes input from the renderer: a page address or a
 * task id can never arrive over this channel, so the renderer cannot open a task window.
 */
export function registerTaskBrowserIpc(
  ipcMain: Pick<IpcMain, 'handle'>,
  assertMainWindow: (event: IpcMainInvokeEvent) => void,
  runtime: TaskBrowserIpcRuntime
): void {
  ipcMain.handle(TASK_BROWSER_IPC.status, async (event): Promise<TaskBrowserStatus> => {
    assertMainWindow(event)
    return await runtime.status()
  })
  ipcMain.handle(TASK_BROWSER_IPC.acknowledge, async (event): Promise<TaskBrowserOk> => {
    assertMainWindow(event)
    try {
      await runtime.acknowledgeDisclosure()
      return { ok: true }
    } catch {
      return { ok: false }
    }
  })
  ipcMain.handle(TASK_BROWSER_IPC.clear, async (event): Promise<TaskBrowserOk> => {
    assertMainWindow(event)
    return { ok: await runtime.clearProfile() }
  })
}
