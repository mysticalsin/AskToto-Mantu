import { IPC } from '@shared/ipc'
import type { SpeechPackService } from '../features/components'

type SpeechPackIpcEvent = Electron.IpcMainInvokeEvent
type SpeechPackIpcMain = Pick<Electron.IpcMain, 'handle' | 'removeHandler'>

/** Register the renderer-facing speech-pack surface after validating the trusted main-window sender. */
export function registerSpeechPackIpc(options: {
  ipcMain: SpeechPackIpcMain
  assertMainWindow: (event: SpeechPackIpcEvent) => void
  sendProgress: Parameters<SpeechPackService['subscribe']>[0]
  service: SpeechPackService
}): () => void {
  const channels = [IPC.speechPackState, IPC.speechPackAction] as const
  for (const channel of channels) {
    try {
      options.ipcMain.removeHandler(channel)
    } catch {
      // The first registration has no old handler to remove.
    }
  }

  let unsubscribe: (() => void) | null = null
  try {
    options.ipcMain.handle(IPC.speechPackState, (event) => {
      options.assertMainWindow(event)
      return options.service.snapshot()
    })
    options.ipcMain.handle(IPC.speechPackAction, (event, request) => {
      options.assertMainWindow(event)
      return options.service.action(request)
    })
    unsubscribe = options.service.subscribe(options.sendProgress)
  } catch (error) {
    for (const channel of channels) {
      try {
        options.ipcMain.removeHandler(channel)
      } catch {
        // Continue removing the rest of the adapter if one channel was already absent.
      }
    }
    throw error
  }

  let cleaned = false
  return () => {
    if (cleaned) return
    cleaned = true
    let cleanupFailed = false
    let cleanupError: unknown
    try {
      unsubscribe?.()
    } catch (error) {
      cleanupFailed = true
      cleanupError = error
    }
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
