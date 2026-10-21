/** True when a Parakeet/Apple feed returned empty because echo-defense dropped operator bleed — not an engine stall. */
export function feedEmptyIsEcho(res: string | { text: string; name?: string; echo?: boolean }): boolean {
  return typeof res !== 'string' && res.echo === true && res.text === ''
}

/**
 * Exported for unit testing — the pure trim behind pushAudio's backpressure guard (1B.2a). Bounds the
 * queue to maxLen by dropping the OLDEST windows first, same as before — but a naive drop-the-front trim
 * can silently erase every queued window of one speaker's channel when the other channel produced a
 * longer burst just ahead of it (e.g. five consecutive THEM windows queued right before a stale YOU one)
 * even though there was still room to keep one of each. So the newest already-queued window of EACH
 * speaker present is protected from the trim; oldest-first dropping still applies to everything else, so
 * a single-speaker backlog (the common case) trims exactly as it always did.
 */
export function trimQueue<T extends { speaker: string }>(queue: readonly T[], maxLen: number): T[] {
  if (queue.length <= maxLen) return queue.slice()
  const lastIndexOfSpeaker = new Map<string, number>()
  queue.forEach((job, i) => lastIndexOfSpeaker.set(job.speaker, i))
  const protectedIdx = new Set(lastIndexOfSpeaker.values())
  let excess = queue.length - maxLen
  const kept: T[] = []
  for (let i = 0; i < queue.length; i++) {
    if (excess > 0 && !protectedIdx.has(i)) {
      excess--
      continue
    }
    kept.push(queue[i])
  }
  return kept
}
