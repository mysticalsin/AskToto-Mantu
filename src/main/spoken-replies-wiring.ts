/** Main-process composition for the spoken-replies feature (G27). */
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { registerSpokenRepliesIpc } from './ipc/spoken-replies-ipc'
import { createSpokenRepliesRuntime, type SpokenRepliesRuntimeDeps } from './features/spoken-replies'

export function createSpokenRepliesWiring(deps: SpokenRepliesRuntimeDeps) {
  const runtime = createSpokenRepliesRuntime(deps)
  return {
    runtime,
    onOwnerRevoked(): void {
      try {
        runtime.bargeIn('hard-stop')
      } catch {
        // The input lease stays revoked if playback cleanup fails.
      }
    },
    registerIpc(ipcMain: Pick<IpcMain, 'handle'>, assertMainWindow: (event: IpcMainInvokeEvent) => void): void {
      registerSpokenRepliesIpc(ipcMain, assertMainWindow, runtime)
    }
  }
}
