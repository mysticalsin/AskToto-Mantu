import type { IpcRenderer } from 'electron'
import {
  TASK_BROWSER_IPC,
  TaskBrowserOkSchema,
  TaskBrowserStatusSchema,
  type TaskBrowserStatus
} from '../shared/task-browser'

/**
 * `window.toto.taskBrowser` (G41): Settings' status, disclosure acknowledgement and clear-profile control. No method
 * takes an address or a task id, so the renderer cannot open or steer a task window. Replies are validated here.
 */
export function createTaskBrowserPreloadApi(ipc: Pick<IpcRenderer, 'invoke'>): {
  taskBrowser: {
    status(): Promise<TaskBrowserStatus | null>
    acknowledge(): Promise<{ ok: boolean }>
    clear(): Promise<{ ok: boolean }>
  }
} {
  const decide = async (channel: string): Promise<{ ok: boolean }> => {
    const parsed = TaskBrowserOkSchema.safeParse(await ipc.invoke(channel))
    return { ok: parsed.success && parsed.data.ok }
  }
  return {
    taskBrowser: {
      async status() {
        const parsed = TaskBrowserStatusSchema.safeParse(await ipc.invoke(TASK_BROWSER_IPC.status))
        return parsed.success ? parsed.data : null
      },
      acknowledge: () => decide(TASK_BROWSER_IPC.acknowledge),
      clear: () => decide(TASK_BROWSER_IPC.clear)
    }
  }
}
