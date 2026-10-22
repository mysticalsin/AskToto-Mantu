import type { ConversationMode, SaveDraftTranscriptResult, SaveMeeting, TranscriptLine } from '@shared/ipc'

interface DraftAutosaveOptions {
  mode: ConversationMode
  getLines: () => TranscriptLine[]
  getStartedAt: () => number
  title: (lines: TranscriptLine[], mode: ConversationMode) => string
  save: (meeting: SaveMeeting) => Promise<SaveDraftTranscriptResult>
  failures: { current: number }
  warn: (value: boolean) => void
}

/** A snapshot still pending this long after it started counts as a failed save (the tick is 60 s). */
export const DRAFT_SAVE_DEADLINE_MS = 45_000

/**
 * Own one listening effect's periodic folder snapshot, including warning and cleanup ownership.
 * Live accessors read the latest transcript without restarting the 60-second timer on every line.
 * Paused meetings still snapshot; only the caller's listening/mode effect starts or retires this owner.
 */
export function startDraftAutosave(options: DraftAutosaveOptions): () => void {
  let active = true
  // The meeting whose snapshot is with main, from hand-off until its promise settles. Main serialises draft writes
  // per path (one path per meeting), so a tick for that same meeting while its write is stalled would queue another
  // full-transcript payload behind it, without bound and without the user ever hearing about it. A different
  // meeting writes a different path, so an old stalled snapshot never blocks the new meeting's autosave.
  let inFlightStartedAt: number | null = null
  options.failures.current = 0
  options.warn(false)
  const recordFailure = (): void => {
    options.failures.current += 1
    // Two consecutive failures (~2 min) warn without interrupting the meeting.
    if (options.failures.current >= 2) options.warn(true)
  }
  const iv = setInterval(() => {
    const lines = options.getLines()
    if (!lines.length) return
    const startedAt = options.getStartedAt()
    if (inFlightStartedAt === startedAt) {
      // This meeting's previous snapshot has not even settled: this tick cannot start, and that is a failure to save.
      recordFailure()
      return
    }
    const title = options.title(lines, options.mode)
    inFlightStartedAt = startedAt
    let timedOut = false
    const deadline = setTimeout(() => {
      timedOut = true
      if (active && options.getStartedAt() === startedAt) recordFailure()
    }, DRAFT_SAVE_DEADLINE_MS)
    void options
      .save({ title, mode: options.mode, startedAt, lines, recap: '' })
      .then((result) => {
        if (!active || options.getStartedAt() !== startedAt) return
        // Retention-disabled snapshots neither claim a save nor count as a failed write.
        if (result?.status === 'disabled') return
        if (result?.status !== 'saved') {
          // A timeout already counted this snapshot as failed; do not count it twice.
          if (!timedOut) recordFailure()
          return
        }
        // A good save clears any prior warning after a transient failure.
        options.failures.current = 0
        options.warn(false)
      })
      .catch(() => {
        if (!active || options.getStartedAt() !== startedAt) return
        if (!timedOut) recordFailure()
      })
      .finally(() => {
        clearTimeout(deadline)
        if (inFlightStartedAt === startedAt) inFlightStartedAt = null
      })
  }, 60_000)
  return () => {
    active = false
    clearInterval(iv)
  }
}
