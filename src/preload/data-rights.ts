import type { IpcRenderer } from 'electron'
import {
  DATA_RIGHTS_IPC,
  ConfirmResultSchema,
  ExportResultSchema,
  LastReceiptResultSchema,
  PreviewResultSchema,
  type ConfirmResult,
  type DataExportResult,
  type LastReceiptResult,
  type PreviewResult
} from '../shared/data-rights'

const UNAVAILABLE = { ok: false, reason: 'unavailable' } as const

/**
 * The data-rights bridge (G82). Every reply from main is validated here against the contract (strict, so a reply that
 * carried a path or an owner key would be dropped) and a malformed one is replaced by a content-free refusal. Erasing is
 * two calls on purpose: `preview` returns what would go with a hash, `confirm` echoes it.
 */
export function createDataRightsPreloadApi(ipc: Pick<IpcRenderer, 'invoke'>): {
  dataRights: {
    preview(): Promise<PreviewResult>
    confirm(proposalId: string, previewHash: string): Promise<ConfirmResult>
    exportData(): Promise<DataExportResult>
    lastReceipt(): Promise<LastReceiptResult>
  }
} {
  const call = async <T>(
    schema: { safeParse(raw: unknown): { success: true; data: T } | { success: false } },
    channel: string,
    payload?: unknown
  ): Promise<T> => {
    try {
      const parsed = schema.safeParse(await ipc.invoke(channel, payload))
      return parsed.success ? parsed.data : (UNAVAILABLE as unknown as T)
    } catch {
      return UNAVAILABLE as unknown as T
    }
  }
  return {
    dataRights: {
      preview: () => call(PreviewResultSchema, DATA_RIGHTS_IPC.preview),
      confirm: (proposalId, previewHash) =>
        call(ConfirmResultSchema, DATA_RIGHTS_IPC.confirm, { proposalId, previewHash }),
      exportData: () => call(ExportResultSchema, DATA_RIGHTS_IPC.export),
      lastReceipt: () => call(LastReceiptResultSchema, DATA_RIGHTS_IPC.lastReceipt)
    }
  }
}
