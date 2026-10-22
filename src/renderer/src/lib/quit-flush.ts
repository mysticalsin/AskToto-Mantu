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
