import { OutputsStaleSchema, SESSION_CONTEXT_IPC } from '@shared/session-context-request'

/** The one webFrame method used, so tests pass a plain object. Mirrors the transcript revision push. */
export interface OutputsStaleFrame {
  readonly parent: unknown
  isDestroyed?(): boolean
  send(channel: string, ...args: unknown[]): void
}

/**
 * Builds the sender that tells a meeting's renderer frame which of its delivered outputs a corrected line outdated
 * (G15). It reaches only the frame named by the meeting, only when that frame is a live top frame, and carries run ids
 * and nothing else. Every failure is swallowed: a dead window must never reach the transcript path.
 */
export function createOutputsStalePush(
  frameFor: (processId: number, routingId: number) => OutputsStaleFrame | null | undefined
): (frame: { processId: number; routingId: number }, outputIds: readonly string[]) => void {
  return (target, outputIds) => {
    try {
      const parsed = OutputsStaleSchema.safeParse({ ids: [...outputIds] })
      if (!parsed.success) return
      const frame = frameFor(target.processId, target.routingId)
      if (!frame || frame.isDestroyed?.() === true) return
      if (frame.parent !== null && frame.parent !== undefined) return
      frame.send(SESSION_CONTEXT_IPC.outputsStale, parsed.data)
    } catch {
      // A dead or detached frame, or a missing one, never breaks the ledger.
    }
  }
}
