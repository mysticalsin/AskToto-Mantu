/**
 * The renderer's History observability reports (IPC.recallList's trace, IPC.historySettled,
 * IPC.historyTransition). Re-exported from ipc.ts, where every other IPC contract lives.
 */
import { z } from 'zod'
import { RENDERER_VIEWS } from './renderer-view'

export const HistoryTraceSchema = z.object({ requestId: z.string().uuid(), sentAt: z.number().finite().positive() })
export type HistoryTrace = z.infer<typeof HistoryTraceSchema>
export const HistorySettledSchema = z.object({
  requestId: z.string().uuid(),
  outcome: z.enum(['ok', 'failed', 'discarded']),
  ipcMs: z.number().finite().nonnegative(),
  renderMs: z.number().finite().nonnegative().optional()
})
export type HistorySettled = z.infer<typeof HistorySettledSchema>
/** A committed navigation that a History request took part in. `from === to` is a request that committed
 *  as a no-op (an open and a close batched into one render: the toggle race); a freeze commits nothing. */
export const HistoryTransitionSchema = z.object({
  from: z.enum(RENDERER_VIEWS),
  to: z.enum(RENDERER_VIEWS),
  committedAtMs: z.number().finite().nonnegative()
})
export type HistoryTransition = z.infer<typeof HistoryTransitionSchema>
