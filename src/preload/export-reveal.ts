import type { IpcRenderer } from 'electron'
import type { DiagnosticsPreviewResult } from '../shared/export-types'
import { IPC, type ExportRevealResult } from '../shared/ipc'

/** Open or reveal a finished export by its receipt id (the renderer never supplies a path), and preview what a
 *  diagnostics export would write (read-only; nothing leaves the device). */
export function createExportPreloadApi(ipc: Pick<IpcRenderer, 'invoke'>): {
  exportReveal(input: { exportId: string; action: 'open' | 'reveal' }): Promise<ExportRevealResult>
  diagnosticsPreview(): Promise<DiagnosticsPreviewResult>
} {
  return {
    exportReveal: (input) => ipc.invoke(IPC.exportReveal, input),
    diagnosticsPreview: () => ipc.invoke(IPC.diagnosticsPreview)
  }
}
