import type { IpcRenderer } from 'electron'
import { IPC, type EvalMetrics } from '../shared/ipc'
import { RESPONSIVENESS_IPC } from '../shared/responsiveness-ipc'
import type { ResponsivenessReport } from '../shared/responsiveness-metrics'

/** How a displayed suggestion's duplicate review ended (G71). A closed set; main ignores anything else. */
export type CardOutcomeReport = 'duplicate_rolled_back' | 'duplicate_retained' | 'review_expired' | 'review_superseded'

/**
 * The renderer's view of on-device metrics: the eval numbers from the audit log, the responsiveness report
 * (G12), the display receipt that confirms a suggestion was painted, and its card outcome. Counts and
 * timings only.
 */
export function createMetricsPreloadApi(ipc: Pick<IpcRenderer, 'invoke'>): {
  readMetrics(): Promise<EvalMetrics>
  readResponsiveness(): Promise<ResponsivenessReport>
  reportDisplayReceipt(askId: string): Promise<void>
  reportCardOutcome(askId: string, outcome: CardOutcomeReport): Promise<void>
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
    },
    async reportCardOutcome(askId, outcome) {
      try {
        await ipc.invoke(RESPONSIVENESS_IPC.cardOutcome, askId, outcome)
      } catch {
        // A lost outcome is a missing count, never a UI error.
      }
    }
  }
}
