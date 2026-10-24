import { COMPONENT_OFFLOAD_IPC } from '@shared/component-offload'
import type { ComponentOffloadService } from '../features/components/offload/service'

type OffloadIpcEvent = Electron.IpcMainInvokeEvent
type OffloadIpcMain = Pick<Electron.IpcMain, 'handle' | 'removeHandler'>

/**
 * Register the offload surface (G87). Every handler validates the main-window sender first; the service parses the
 * payload itself and answers `invalid-request` for anything malformed, so no renderer value reaches the filesystem.
 */
export function registerComponentOffloadIpc(options: {
  ipcMain: OffloadIpcMain
  assertMainWindow: (event: OffloadIpcEvent) => void
  service: Pick<ComponentOffloadService, 'preview' | 'confirm' | 'receipts'>
}): () => void {
  const channels = [
    COMPONENT_OFFLOAD_IPC.preview,
    COMPONENT_OFFLOAD_IPC.confirm,
    COMPONENT_OFFLOAD_IPC.receipts
  ] as const
  const removeAll = (): void => {
    for (const channel of channels) {
      try {
        options.ipcMain.removeHandler(channel)
      } catch {
        // A channel that was never registered has nothing to remove.
      }
    }
  }
  removeAll()
  try {
    options.ipcMain.handle(COMPONENT_OFFLOAD_IPC.preview, (event, request) => {
      options.assertMainWindow(event)
      return options.service.preview(request)
    })
    options.ipcMain.handle(COMPONENT_OFFLOAD_IPC.confirm, (event, request) => {
      options.assertMainWindow(event)
      return options.service.confirm(request)
    })
    options.ipcMain.handle(COMPONENT_OFFLOAD_IPC.receipts, (event) => {
      options.assertMainWindow(event)
      return options.service.receipts()
    })
  } catch (error) {
    removeAll()
    throw error
  }
  let cleaned = false
  return () => {
    if (cleaned) return
    cleaned = true
    removeAll()
  }
}
