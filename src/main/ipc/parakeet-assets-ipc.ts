import { IPC } from '@shared/ipc'

type ParakeetAssetsIpcMain = Pick<Electron.IpcMain, 'handle' | 'removeHandler'>
type ParakeetEnsureProgress = { pct: number }

/** Register the trusted renderer surface for Parakeet readiness and explicit model installation. */
export function registerParakeetAssetsIpc(options: {
  ipcMain: ParakeetAssetsIpcMain
  assertMainWindow: (event: Electron.IpcMainInvokeEvent) => void
  requireAuth: () => boolean
  modelReady: () => Promise<boolean>
  addonError: () => Promise<string | null>
  ensureModel: (onProgress: (percentage: number) => void) => Promise<void>
  publishProgress: (progress: ParakeetEnsureProgress) => void
}): { cleanup(): void } {
  try {
    options.ipcMain.handle(IPC.parakeetStatus, async (event) => {
      options.assertMainWindow(event)
      // Read both values on every request; model and native-addon availability may change at runtime.
      return { ready: await options.modelReady(), addonError: await options.addonError() }
    })
    options.ipcMain.handle(IPC.parakeetEnsure, async (event) => {
      options.assertMainWindow(event)
      if (!options.requireAuth()) return { ok: false }
      try {
        await options.ensureModel((pct) => options.publishProgress({ pct }))
        return { ok: await options.modelReady() }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    })
  } catch (error) {
    for (const channel of [IPC.parakeetStatus, IPC.parakeetEnsure]) {
      try {
        options.ipcMain.removeHandler(channel)
      } catch {
        // Preserve the original registration failure while trying to remove both handlers.
      }
    }
    throw error
  }

  let cleaned = false
  return {
    cleanup(): void {
      if (cleaned) return
      cleaned = true
      let cleanupFailed = false
      let cleanupError: unknown
      for (const channel of [IPC.parakeetStatus, IPC.parakeetEnsure]) {
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
