import type { IpcRenderer } from 'electron'
import {
  OutputsStaleSchema,
  SESSION_CONTEXT_IPC,
  type OutputsStale,
  type SessionLedgerLine,
  type SessionLedgerLineResult
} from '../shared/session-context-request'

/**
 * The renderer's one write toward main's transcript ledger: a line a renderer-side engine committed. It feeds the
 * ledger only; no ask, suggestion, screen ask or follow-up carries transcript text any more.
 *
 * The one thing that comes back is a list of run ids (G15): answers or suggestions already delivered whose transcript
 * lines main's ledger has since corrected. It carries no text; the renderer drops its own memory of those runs.
 */
export function createSessionContextPreloadApi(ipc: Pick<IpcRenderer, 'invoke' | 'on' | 'removeListener'>): {
  appendSessionLedgerLine(line: SessionLedgerLine): Promise<SessionLedgerLineResult>
  onSessionOutputsStale(cb: (stale: OutputsStale) => void): () => void
} {
  return {
    appendSessionLedgerLine: (line) => ipc.invoke(SESSION_CONTEXT_IPC.appendLine, line),
    onSessionOutputsStale(cb) {
      const listener = (_event: unknown, payload: unknown): void => {
        const parsed = OutputsStaleSchema.safeParse(payload)
        if (!parsed.success) return
        try {
          cb(parsed.data)
        } catch {
          // A throwing subscriber must not break the bridge.
        }
      }
      ipc.on(SESSION_CONTEXT_IPC.outputsStale, listener)
      return () => ipc.removeListener(SESSION_CONTEXT_IPC.outputsStale, listener)
    }
  }
}
