import type { TranscriptLine } from '@shared/ipc'
import type { BackfillRun, BackfillStartOptions } from './ingest'
import { backfillCompletionError, SUMMARY_INDEX_RETRY_COPY, type IntelligenceIndexRun } from './intelligence-index'

interface MissingSummary {
  file: string
  mode: string
  lines: TranscriptLine[]
}

interface IntelligenceWorkDependencies {
  list(): Promise<MissingSummary[]>
  generate(meeting: MissingSummary): Promise<string | undefined>
  save(file: string, recap: string): Promise<{ ok: boolean }>
  backfill(options: BackfillStartOptions, beforeComplete: Promise<unknown>): BackfillRun
  logFailure(error: unknown): void
}

async function recapMissingMeetings(deps: IntelligenceWorkDependencies): Promise<{ recapped: number; failed: number }> {
  let recapped = 0
  let failed = 0
  try {
    const meetings = await deps.list()
    for (const meeting of meetings) {
      try {
        const recap = await deps.generate(meeting)
        if (!recap?.trim() || !(await deps.save(meeting.file, recap)).ok) {
          failed++
          continue
        }
        recapped++
      } catch (error) {
        failed++
        deps.logFailure(error)
      }
    }
  } catch (error) {
    failed++
    deps.logFailure(error)
  }
  return { recapped, failed }
}

/** Dispatch quickly, keep independent model work parallel, and join actual terminal outcomes. */
export function startIntelligenceWork(deps: IntelligenceWorkDependencies): IntelligenceIndexRun {
  const recaps = recapMissingMeetings(deps)
  // Recaps rewrite the source Markdown. Extraction can start immediately, but its final source-version
  // verification must wait for these writes so a later recap cannot invalidate a claimed success.
  const backfill = deps.backfill({ force: true }, recaps)
  return {
    result: { ...backfill.result, ran: !backfill.result.deferred, recapped: 0 },
    completion: Promise.all([backfill.completion, recaps]).then(([index, summaries]) => {
      const error = backfillCompletionError(index) || (summaries.failed > 0 ? SUMMARY_INDEX_RETRY_COPY : undefined)
      return { ok: !error, recapped: summaries.recapped, ...(error ? { error } : {}) }
    })
  }
}
