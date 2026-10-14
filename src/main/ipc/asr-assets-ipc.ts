import { IPC, type AsrAssetsStatus, type ImportAssetsProgress } from '@shared/ipc'

type AsrAssetsIpcEvent = Electron.IpcMainInvokeEvent
type AsrAssetsIpcMain = Pick<Electron.IpcMain, 'handle' | 'removeHandler'>

/** Register the ASR asset IPC handlers. Registration itself performs no probing or transfer work. */
export function registerAsrAssetsIpc(options: {
  ipcMain: AsrAssetsIpcMain
  isRecentlyRetiredOverlaySender: (event: AsrAssetsIpcEvent) => boolean
  assertMainWindow: (event: AsrAssetsIpcEvent) => void
  readBundledStatus: () => Promise<boolean>
  getStatus: () => Promise<AsrAssetsStatus>
  ensureAllowed: () => boolean
  ensureAssets: (onProgress: (percentage: number) => void) => Promise<unknown>
  getProgress: () => ImportAssetsProgress
  publishProgress: (progress: ImportAssetsProgress) => void
  warn: (message: string, detail?: unknown) => void
}): { primeBundledStatus(): Promise<void>; cleanup(): void } {
  const channels = [IPC.asrBundled, IPC.asrAssetsStatus, IPC.asrAssetsEnsure] as const
  for (const channel of channels) {
    try {
      options.ipcMain.removeHandler(channel)
    } catch {
      // The first registration has no old handler to remove.
    }
  }

  try {
    options.ipcMain.handle(IPC.asrBundled, async (event) => {
      if (options.isRecentlyRetiredOverlaySender(event)) return true
      options.assertMainWindow(event)
      // Do not cache this result: selection and profile activation can change while the app is open.
      return await options.readBundledStatus()
    })
    options.ipcMain.handle(IPC.asrAssetsStatus, async (event) => {
      options.assertMainWindow(event)
      return await options.getStatus()
    })
    options.ipcMain.handle(IPC.asrAssetsEnsure, async (event) => {
      options.assertMainWindow(event)
      if (!options.ensureAllowed()) return await options.getStatus()
      try {
        await options.ensureAssets((percentage) => {
          options.publishProgress({ ...options.getProgress(), progress: percentage / 100 })
        })
      } catch (error) {
        options.warn('[asr-assets] ensure failed:', error instanceof Error ? error.message : error)
        options.publishProgress(options.getProgress())
      }
      return await options.getStatus()
    })
  } catch (error) {
    for (const channel of channels) {
      try {
        options.ipcMain.removeHandler(channel)
      } catch {
        // Preserve the registration error while attempting all cleanup.
      }
    }
    throw error
  }

  let cleaned = false
  return {
    /** Best-effort boot callers own error reporting and must retain this Promise in their work queue. */
    async primeBundledStatus(): Promise<void> {
      await options.readBundledStatus()
    },
    cleanup(): void {
      if (cleaned) return
      cleaned = true
      let cleanupFailed = false
      let cleanupError: unknown
      for (const channel of channels) {
        try {
          options.ipcMain.removeHandler(channel)
        } catch (error) {
          if (!cleanupFailed) {
            cleanupFailed = true
            cleanupError = error
          }
        }
      }
      if (cleanupFailed) throw cleanupError
    }
  }
}
