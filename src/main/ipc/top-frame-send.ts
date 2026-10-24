/** The one webFrame surface used, so tests pass a plain object. */
export interface TopFrameLike {
  readonly parent: unknown
  isDestroyed?(): boolean
  send(channel: string, ...args: unknown[]): void
}

export type FrameLookup = (processId: number, routingId: number) => TopFrameLike | null | undefined

/**
 * Sends one payload to the frame a meeting names, only when that frame still exists and is a live top frame. Every
 * failure is swallowed: a dead or detached window must never reach the transcript path.
 */
export function sendToTopFrame(
  frameFor: FrameLookup,
  target: { processId: number; routingId: number },
  channel: string,
  payload: unknown
): void {
  try {
    const frame = frameFor(target.processId, target.routingId)
    if (!frame || frame.isDestroyed?.() === true) return
    if (frame.parent !== null && frame.parent !== undefined) return
    frame.send(channel, payload)
  } catch {
    // A dead or detached frame, or a missing one, never breaks the ledger.
  }
}
