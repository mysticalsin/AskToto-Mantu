import type { IpcRenderer } from 'electron'
import {
  SESSION_CONTEXT_IPC,
  type SessionLedgerLine,
  type SessionLedgerLineResult
} from '../shared/session-context-request'

/**
 * The renderer's one write toward main's transcript ledger: a line a renderer-side engine committed. It feeds the
 * ledger only; no ask, suggestion, screen ask or follow-up carries transcript text any more.
 */
export function createSessionContextPreloadApi(ipc: Pick<IpcRenderer, 'invoke'>): {
  appendSessionLedgerLine(line: SessionLedgerLine): Promise<SessionLedgerLineResult>
} {
  return {
    appendSessionLedgerLine: (line) => ipc.invoke(SESSION_CONTEXT_IPC.appendLine, line)
  }
}
