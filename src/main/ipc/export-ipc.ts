/**
 * export-ipc.ts — the diagnostics export and the open/reveal action for a finished export.
 *
 * The renderer never supplies a path to open or reveal: it sends a receipt id and main looks the destination
 * up in the local receipt log. Every handler keeps the main-window sender gate and the auth gate.
 */
import { join } from 'node:path'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import type { DiagnosticsPreviewResult } from '@shared/export-types'
import { IPC, type DiagnosticsExportResult, type ExportRevealResult } from '@shared/ipc'
import { collectDiagnosticsBundle, previewDiagnosticsBundle } from '../features/export/diagnostics-bundle'
import { readReceipt } from '../features/export/export-receipts'
import type { ExportService } from '../features/export/export-service'

export interface ExportIpcDependencies {
  ipcMain: Pick<IpcMain, 'handle'>
  assertMainWindow: (event: IpcMainInvokeEvent) => void
  requireAuth: () => boolean
  exporter: ExportService
  receiptLogPath: () => string
  downloadsPath: () => string
  userDataPath: () => string
  appInfo: () => { version: string; platform: string; arch: string; packaged: boolean }
  /** Opens a file with the OS default app; resolves to an error string, empty on success. */
  openPath: (path: string) => Promise<string>
  showItemInFolder: (path: string) => void
  audit: (event: 'diagnostics.export', data: Record<string, unknown>) => void
}

export function registerExportIpc(deps: ExportIpcDependencies): void {
  const { ipcMain, assertMainWindow, requireAuth, exporter } = deps
  // G84: read-only. Collects through the same redaction gate the export uses, so the owner sees the exact bytes
  // an export would write. It opens no dialog, writes nothing and sends nothing anywhere.
  ipcMain.handle(IPC.diagnosticsPreview, async (e): Promise<DiagnosticsPreviewResult> => {
    assertMainWindow(e)
    if (!requireAuth()) return { ok: false, error: 'Sign in with your Mantu account first.' }
    try {
      const bundle = await collectDiagnosticsBundle({ userData: deps.userDataPath(), ...deps.appInfo() })
      return { ok: true, ...previewDiagnosticsBundle(bundle) }
    } catch {
      return { ok: false, error: 'Could not preview diagnostics.' }
    }
  })

  // Support diagnosability: nothing in this app uploads anywhere (crashReporter uploadToServer:false, zero
  // telemetry), so the ONLY way the log trail reaches support is the user exporting it.
  ipcMain.handle(IPC.diagnosticsExport, async (e): Promise<DiagnosticsExportResult> => {
    assertMainWindow(e)
    if (!requireAuth()) return { ok: false, error: 'Sign in with your Mantu account first.' }
    try {
      const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')
      const bundle = await collectDiagnosticsBundle({ userData: deps.userDataPath(), ...deps.appInfo() })
      const result = await exporter.exportDirectory({
        kind: 'diagnostics-bundle',
        label: 'diagnostics bundle',
        entries: bundle.entries,
        dialog: {
          title: 'Export diagnostics bundle',
          defaultPath: join(deps.downloadsPath(), `Metis-diagnostics-${stamp}`),
          buttonLabel: 'Choose destination'
        }
      })
      if (!result.ok) return 'cancelled' in result ? { ok: false, cancelled: true } : { ok: false, error: result.error }
      deps.audit('diagnostics.export', { files: bundle.files })
      return { ok: true, path: result.receipt.destination, files: bundle.files, receipt: result.receipt }
    } catch {
      return { ok: false, error: 'Could not export diagnostics.' }
    }
  })

  ipcMain.handle(IPC.exportReveal, async (e, raw: unknown): Promise<ExportRevealResult> => {
    assertMainWindow(e)
    if (!requireAuth()) return { ok: false, error: 'Sign in with your Mantu account first.' }
    const input = raw as { exportId?: unknown; action?: unknown } | null
    if (!input || typeof input.exportId !== 'string' || (input.action !== 'open' && input.action !== 'reveal')) {
      return { ok: false, error: 'Invalid export request.' }
    }
    const receipt = await readReceipt(deps.receiptLogPath(), input.exportId)
    if (!receipt) return { ok: false, error: 'That export is not in the local receipt log.' }
    if (input.action === 'reveal') {
      deps.showItemInFolder(receipt.destination)
      return { ok: true }
    }
    const failed = await deps.openPath(receipt.destination)
    return failed ? { ok: false, error: 'Could not open the exported file.' } : { ok: true }
  })
}
