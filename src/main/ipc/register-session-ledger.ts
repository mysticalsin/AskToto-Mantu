import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import {
  SESSION_CONTEXT_IPC,
  SessionLedgerLineSchema,
  type SessionLedgerLineResult
} from '@shared/session-context-request'
import type { MeetingContextRegistry } from '../features/session-context/meeting-context-registry'
import type { AuthorizeSender, SenderEventLike } from './sender-auth'

export interface SessionLedgerIpcDependencies {
  ipcMain: Pick<IpcMain, 'handle'>
  /** Audited main-window top-frame gate; throws a typed refusal for any other sender. */
  authorizeSender: AuthorizeSender
  requireAuth(): boolean
  registry: Pick<MeetingContextRegistry, 'ingestLocalLine' | 'retractLocalLine' | 'labelLine'>
}

const REFUSED: SessionLedgerLineResult = { status: 'refused' }
const ACCEPTED: SessionLedgerLineResult = { status: 'accepted' }

/**
 * `session-context:appendLine`: how a line committed by a renderer-side engine (on-device ASR, the legacy cloud path)
 * reaches the ledger main owns. Relay segments never come through here: main sees those itself. The frame comes from
 * the IPC sender, never the payload, and the registry binds each meeting to the frame and owner that opened it, so a
 * renderer cannot write into a meeting it does not own. The reply is content-free.
 */
export function registerSessionLedgerIpc(deps: SessionLedgerIpcDependencies): void {
  deps.ipcMain.handle(SESSION_CONTEXT_IPC.appendLine, (event, raw): SessionLedgerLineResult => {
    deps.authorizeSender(event as IpcMainInvokeEvent as SenderEventLike, {
      surface: 'sessionContext.appendLine',
      requireOwner: false,
      allowedFrames: 'main-window-top'
    })
    if (!deps.requireAuth()) return REFUSED
    const parsed = SessionLedgerLineSchema.safeParse(raw)
    const frame = event.senderFrame
    if (!parsed.success || !frame) return REFUSED
    const line = parsed.data
    const accepted =
      line.op === 'final'
        ? deps.registry.ingestLocalLine(frame, line)
        : line.op === 'retract'
          ? deps.registry.retractLocalLine(frame, line)
          : deps.registry.labelLine(frame, line)
    return accepted ? ACCEPTED : REFUSED
  })
}
