/**
 * Polls while an update is deferred behind a meeting or task (G86). The tick only RE-OFFERS or starts a deferred
 * download; it never relaunches. Returns a disposer; the timer never keeps the process alive.
 */
export function startUpdateIdlePoll(tick: () => void, everyMs = 15_000): () => void {
  const timer = setInterval(tick, everyMs)
  timer.unref?.()
  return () => clearInterval(timer)
}
