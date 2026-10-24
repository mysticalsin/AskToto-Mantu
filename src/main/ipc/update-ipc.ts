import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron'
import { IPC, type UpdateCheckResult } from '@shared/ipc'
import {
  UPDATE_LIFECYCLE_IPC,
  UpdateLifecycleStateSchema,
  type UpdateInstallResult,
  type UpdateLifecycleState
} from '@shared/update-lifecycle'

export interface UpdateIpcDeps {
  ipcMain: Pick<IpcMain, 'handle'>
  assertMainWindow: (event: IpcMainInvokeEvent) => void
  requireAuth: () => boolean
  getWindow: () => Pick<BrowserWindow, 'isDestroyed' | 'webContents'> | null
  checkForUpdateNow: () => Promise<UpdateCheckResult>
  startUpdateDownload: () => Promise<{ started: boolean; reason?: string }>
  requestInstall: () => Promise<UpdateInstallResult>
  getUpdateState: () => UpdateLifecycleState
  onUpdateState: (listener: (state: UpdateLifecycleState) => void) => () => void
}

/**
 * Check, Download, Install and the lifecycle snapshot (G86). Every handler sits behind the main-window sender
 * check and a signed-in user, with the same signed-out shapes as before. Install answers inline, including why it
 * was deferred. The snapshot is validated before it crosses the bridge and is pushed on every transition.
 * Returns a disposer that stops the push.
 */
export function registerUpdateIpc(deps: UpdateIpcDeps): () => void {
  const { ipcMain, assertMainWindow, requireAuth } = deps
  ipcMain.handle(IPC.updateCheck, (e) => {
    assertMainWindow(e)
    if (!requireAuth()) return { ok: false, current: '', error: 'Not signed in.' }
    return deps.checkForUpdateNow()
  })
  ipcMain.handle(IPC.updateDownload, (e) => {
    assertMainWindow(e)
    if (!requireAuth()) return { started: false, reason: 'Not signed in.' }
    return deps.startUpdateDownload()
  })
  ipcMain.handle(IPC.updateInstall, (e): Promise<UpdateInstallResult> | UpdateInstallResult => {
    assertMainWindow(e)
    if (!requireAuth()) return { installed: false, reason: 'not-signed-in' }
    return deps.requestInstall()
  })
  ipcMain.handle(UPDATE_LIFECYCLE_IPC.stateGet, (e) => {
    assertMainWindow(e)
    if (!requireAuth()) return { phase: 'idle' } satisfies UpdateLifecycleState
    const parsed = UpdateLifecycleStateSchema.safeParse(deps.getUpdateState())
    return parsed.success ? parsed.data : { phase: 'idle' }
  })
  return deps.onUpdateState((state) => {
    const win = deps.getWindow()
    if (!win || win.isDestroyed()) return
    const parsed = UpdateLifecycleStateSchema.safeParse(state)
    if (parsed.success) win.webContents.send(UPDATE_LIFECYCLE_IPC.state, parsed.data)
  })
}
