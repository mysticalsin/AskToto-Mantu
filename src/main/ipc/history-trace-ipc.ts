/**
 * history-trace-ipc.ts — the renderer's History observability reports (M2-0215, M2-0032).
 *
 * Every handler checks its sender with the caller's assertMainWindow and audits nothing before sign-in. The
 * tracer validates each report against its schema, so a malformed one is dropped, never persisted.
 */
import { z } from 'zod'
import { IPC } from '@shared/ipc'
import type { HistoryTracer } from '../infra/observability/history-trace'
import { registerHandler } from './register'

type AssertMainWindow = (event: Electron.IpcMainInvokeEvent) => void

export function registerHistoryTraceIpc(assertMainWindow: AssertMainWindow, requireAuth: () => boolean, history: HistoryTracer): void {
  // A History list request settled in the renderer: painted, discarded or failed.
  registerHandler({
    channel: IPC.historySettled,
    auth: 'required',
    isAuthenticated: requireAuth,
    args: z.tuple([z.unknown()]),
    assertSender: assertMainWindow
  }, (_e, report) => {
    history.settle(report)
  })
  // A committed navigation into or out of History; from === to is the toggle-race no-op.
  registerHandler({
    channel: IPC.historyTransition,
    auth: 'required',
    isAuthenticated: requireAuth,
    args: z.tuple([z.unknown()]),
    assertSender: assertMainWindow
  }, (_e, transition) => {
    history.transition(transition)
  })
}
