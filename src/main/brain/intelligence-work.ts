import type { TranscriptLine } from '@shared/ipc'
import type { BackfillRun, BackfillStartOptions } from './ingest'
import { backfillCompletionError, SUMMARY_INDEX_RETRY_COPY, triggerForReason, type IntelligenceIndexReason, type IntelligenceIndexRun } from './intelligence-index'
import { runAsMaintenance } from '../infra/scheduler/maintenance'

interface MissingSummary {
  file: string
  mode: string
  lines: TranscriptLine[]
}

interface IntelligenceWorkDependencies {
  list(): Promise<MissingSummary[]>
  generate(meeting: MissingSummary): Promise<string | undefined>
  save(file: string, recap: string, recapStatus: 'complete'): Promise<{ ok: boolean }>
  backfill(options: BackfillStartOptions, beforeComplete: Promise<unknown>): BackfillRun | Promise<BackfillRun>
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
        if (!recap?.trim() || !(await deps.save(meeting.file, recap, 'complete')).ok) {
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

/** Dispatch quickly, route work by trigger, and join actual terminal outcomes. */
export function startIntelligenceWork(deps: IntelligenceWorkDependencies, reason: IntelligenceIndexReason): IntelligenceIndexRun {
  const trigger = triggerForReason(reason)
  // Unattended recaps are model work nobody is waiting on: each one takes the maintenance slot.
  const generate = trigger === 'user'
    ? deps.generate
    : (meeting: MissingSummary) => runAsMaintenance(() => deps.generate(meeting))
  const recaps = recapMissingMeetings({ ...deps, generate })
  // Recaps rewrite the source Markdown. Extraction can start immediately, but its final source-version
  // verification must wait for these writes so a later recap cannot invalidate a claimed success.
  const backfill = Promise.resolve(deps.backfill({ force: true, trigger }, recaps))
  const initial: IntelligenceIndexRun = {
    result: { queued: 0, preparing: true, ran: true, recapped: 0 },
    completion: Promise.all([backfill.then((run) => run.completion), recaps])
      .then(([indexCompletion, summaries]) => Promise.all([indexCompletion, Promise.resolve(summaries)]))
      .then(([index, summaries]) => {
        const error = backfillCompletionError(index) || (summaries.failed > 0 ? SUMMARY_INDEX_RETRY_COPY : undefined)
        return { ok: !error, recapped: summaries.recapped, ...(error ? { error } : {}) }
      })
  }
  void backfill.then((run) => {
    initial.result = { ...run.result, ran: !run.result.deferred, recapped: 0 }
  })
  return initial
}
