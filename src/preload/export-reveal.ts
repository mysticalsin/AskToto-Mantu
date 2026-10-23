import type { IpcRenderer } from 'electron'
import { IPC, type ExportRevealResult } from '../shared/ipc'

/** Open or reveal a finished export by its receipt id. The renderer never supplies a path. */
export function createExportPreloadApi(ipc: Pick<IpcRenderer, 'invoke'>): {
  exportReveal(input: { exportId: string; action: 'open' | 'reveal' }): Promise<ExportRevealResult>
} {
  return {
    exportReveal: (input) => ipc.invoke(IPC.exportReveal, input)
  }
}
