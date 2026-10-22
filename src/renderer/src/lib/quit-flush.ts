/**
 * Main asks for 'quit-flush' when the app is quitting with a live meeting. The renderer saves the meeting,
 * then acknowledges so main quits at once instead of waiting out its ceiling. The ack is sent even when the
 * save fails: a failed save is already preserved as a draft, and holding quit would not retry it.
 */
export async function runQuitFlush(flush: () => Promise<void>, acknowledge: () => void): Promise<void> {
  try {
    await flush()
  } catch {
    /* the draft journal already holds the transcript */
  } finally {
    acknowledge()
  }
}

/** How long a quit waits for Stop's drain. Main quits at 12 s regardless, so this leaves it time to save. */
export const QUIT_DRAIN_CAP_MS = 8_000

/** Resolves when the stop drain settles, or at the cap if it never does. */
export function drainWithCap(stop: (onDrained: () => void) => void, capMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, capMs)
    stop(() => {
      clearTimeout(timer)
      resolve()
    })
  })
}
