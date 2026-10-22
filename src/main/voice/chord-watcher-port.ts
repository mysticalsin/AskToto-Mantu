/**
 * The typed seam between the voice session (V02) and the global hold-chord watcher (V01).
 *
 * V01 owns the helper process, the pure recognizer and the watcher that implements this interface. The session
 * depends only on this shape, so it can be built and tested before V01 merges and the QA FIFO source (V08) can
 * stand in for the helper later. The events are the recognizer's verdicts, never key identities.
 */
import type { VoiceChordToken } from '@shared/voice-actions-settings'

/**
 * - armed: the chord was held alone for the threshold; a turn may begin.
 * - released: the chord was let go; the turn is sealed.
 * - aborted: another key or an added modifier interrupted the hold; the turn is discarded.
 * - latched: two quick presses latched hands-free listening; a turn begins.
 * - latch-ended: the latch ended (press, Escape or the cap); the turn is sealed.
 */
export type VoiceChordEvent = 'armed' | 'released' | 'aborted' | 'latched' | 'latch-ended'

export interface VoiceChordWatcher {
  /** Begin watching. Idempotent. */
  start(): void
  /** Stop watching and release the helper. Idempotent and synchronous. */
  stop(): void
  /** Subscribe to recognizer verdicts. Returns an unsubscribe function. */
  onEvent(listener: (event: VoiceChordEvent) => void): () => void
}

/** V01 supplies this factory. Absent on a platform or build with no hold watcher. */
export type VoiceChordWatcherFactory = (chord: readonly VoiceChordToken[]) => VoiceChordWatcher
