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

/**
 * Own one listening effect's periodic folder snapshot, including warning and cleanup ownership.
 * Live accessors read the latest transcript without restarting the 60-second timer on every line.
 * Paused meetings still snapshot; only the caller's listening/mode effect starts or retires this owner.
 */
export function startDraftAutosave(options: DraftAutosaveOptions): () => void {
  let active = true
  options.failures.current = 0
  options.warn(false)
  const iv = setInterval(() => {
    const lines = options.getLines()
    if (!lines.length) return
    const title = options.title(lines, options.mode)
    const startedAt = options.getStartedAt()
    void options.save({ title, mode: options.mode, startedAt, lines, recap: '' })
      .then((result) => {
        if (!active || options.getStartedAt() !== startedAt) return
        // Retention-disabled snapshots neither claim a save nor count as a failed write.
        if (result?.status === 'disabled') return
        if (result?.status !== 'saved') {
          options.failures.current += 1
          if (options.failures.current >= 2) options.warn(true)
          return
        }
        // A good save clears any prior warning after a transient failure.
        options.failures.current = 0
        options.warn(false)
      })
      .catch(() => {
        if (!active || options.getStartedAt() !== startedAt) return
        // Two consecutive failures (~2 min) warn without interrupting the meeting.
        options.failures.current += 1
        if (options.failures.current >= 2) options.warn(true)
      })
  }, 60_000)
  return () => {
    active = false
    clearInterval(iv)
  }
}
