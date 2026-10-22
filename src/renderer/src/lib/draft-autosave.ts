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
  // True from the moment a snapshot is handed to main until its promise settles. Main serialises draft writes per
  // path, so a tick that fired while a stalled write was pending would queue another full-transcript payload behind
  // it, without bound and without the user ever hearing about it.
  let inFlight = false
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
    if (inFlight) {
      // The previous snapshot has not even settled: this tick cannot start, and that is a failure to save.
      recordFailure()
      return
    }
    const title = options.title(lines, options.mode)
    const startedAt = options.getStartedAt()
    inFlight = true
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
        inFlight = false
      })
  }, 60_000)
  return () => {
    active = false
    clearInterval(iv)
  }
}
