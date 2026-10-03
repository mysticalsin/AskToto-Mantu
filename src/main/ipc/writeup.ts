import { z } from 'zod'
import { IPC, WriteupSpanPayloadSchema } from '@shared/ipc'
import { requireAuth } from '../auth'
import { appleEngineStatus } from '../llm/local'
import { auditLog } from '../logger'
import { registerHandler } from './register'

type SenderCheck = (event: Electron.IpcMainInvokeEvent) => void

/**
 * Post-meeting write-up IPC (M2-0430): Settings' Apple engine status, and the renderer's content-free
 * latency spans. Every handler rejects a sender that is not the main window's top frame. A span is
 * audited only when signed in and only as a known span name with a millisecond count; anything else
 * is dropped, so no meeting content can reach the audit log through this channel.
 */
export function registerWriteupIpc(assertMainWindow: SenderCheck): void {
  registerHandler({
    channel: IPC.localAppleEngineStatus,
    auth: 'public',
    args: z.tuple([]),
    assertSender: assertMainWindow
  }, () => {
    return appleEngineStatus()
  })
  registerHandler({
    channel: IPC.writeupSpan,
    auth: 'required',
    isAuthenticated: requireAuth,
    args: z.tuple([z.unknown()]),
    assertSender: assertMainWindow
  }, (_e, report) => {
    const parsed = WriteupSpanPayloadSchema.safeParse(report)
    if (parsed.success) auditLog('writeup.span', { span: parsed.data.span, ms: parsed.data.ms })
  })
}
