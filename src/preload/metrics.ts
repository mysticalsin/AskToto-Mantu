import type { IpcRenderer } from 'electron'
import { IPC, type EvalMetrics } from '../shared/ipc'
import { RESPONSIVENESS_IPC } from '../shared/responsiveness-ipc'
import type { ResponsivenessReport } from '../shared/responsiveness-metrics'

/**
 * The renderer's view of on-device metrics: the eval numbers from the audit log, the responsiveness report
 * (G12), and the display receipt that confirms a suggestion was painted. Counts and timings only.
 */
export function createMetricsPreloadApi(ipc: Pick<IpcRenderer, 'invoke'>): {
  readMetrics(): Promise<EvalMetrics>
  readResponsiveness(): Promise<ResponsivenessReport>
  reportDisplayReceipt(askId: string): Promise<void>
} {
  return {
    readMetrics: () => ipc.invoke(IPC.metricsRead),
    readResponsiveness: () => ipc.invoke(RESPONSIVENESS_IPC.report),
    async reportDisplayReceipt(askId) {
      try {
        await ipc.invoke(RESPONSIVENESS_IPC.displayReceipt, askId)
      } catch {
        // A lost receipt is a missing count, never a UI error.
      }
    }
  }
}
