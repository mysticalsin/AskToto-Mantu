import { IPC } from '@shared/ipc'
import { ensureHighTierAsrModelExplicit } from '../asr-model-download'

type AsrModelFetchEvent = Electron.IpcMainInvokeEvent
type AsrModelFetchIpcMain = Pick<Electron.IpcMain, 'handle'>

/** Register the explicit ASR-model transfer request at the IPC boundary. */
export function registerHighTierAsrModelFetch(options: {
  ipcMain: AsrModelFetchIpcMain
  assertMainWindow: (event: AsrModelFetchEvent) => void
  authenticated: () => boolean
  runtimeAvailable: () => Promise<boolean>
  authorityReadable: () => boolean | Promise<boolean>
  onTransfer: () => void
}): void {
  options.ipcMain.handle(IPC.asrModelFetch, async (event) => {
    options.assertMainWindow(event)
    const ok = await ensureHighTierAsrModelExplicit({
      authenticated: options.authenticated(),
      runtimeAvailable: options.runtimeAvailable,
      authorityReadable: options.authorityReadable,
      onTransfer: options.onTransfer
    })
    return { ok }
  })
}
