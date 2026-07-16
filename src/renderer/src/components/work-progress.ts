import type { ImportJobView } from '@shared/ipc'

export interface WorkProgressDescription {
  percent: number | null
  label: string
  valueText: string
}

export interface ImportProgressDescription extends WorkProgressDescription {
  active: boolean
  detail: string
  /** True once the meter should render a full bar with a persistent pulse instead of a stalled
   *  percentage. The post-transcription "wrapping up" stretch (saving the transcript, then writing its
   *  AI summary) has no further measurable checkpoint until the job reaches `done` — freezing the bar at
   *  99% for however long the LLM recap takes reads as broken, not busy. See WorkProgressMeter's
   *  `pulseAtFull` prop, which renders the same translate/opacity-only pulse used for the indeterminate
   *  state, just on top of a full track instead of an empty one. */
  pulseAtFull: boolean
}

type MeetingIndexSnapshot = {
  done: number
  failed?: number
  preparing?: boolean
  total: number
  running: boolean
}

type ImportProgressSnapshot = Pick<ImportJobView, 'state' | 'cursor' | 'totalChunks' | 'pct' | 'recapError'>

function wholeNumber(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
}

function percentage(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)))
}

function meetingNoun(count: number): string {
  return count === 1 ? 'meeting' : 'meetings'
}

function attentionDetail(count: number): string {
  return count === 1 ? '1 needs attention' : `${count} need attention`
}

/**
 * Turns the durable backfill counters into display state. The counter is intentionally the source of
 * truth: a UI poll can never claim more completed meetings than the main-process queue has reported.
 */
export function describeMeetingIndexProgress(snapshot: MeetingIndexSnapshot): WorkProgressDescription {
  if (snapshot.preparing) {
    return {
      percent: null,
      label: 'Preparing saved meetings…',
      valueText: 'Preparing saved meetings'
    }
  }
  const total = wholeNumber(snapshot.total)
  if (total === 0) {
    return {
      percent: null,
      label: 'Mapping meetings…',
      valueText: 'Mapping meetings'
    }
  }

  const done = Math.min(total, wholeNumber(snapshot.done))
  const failed = Math.min(done, wholeNumber(snapshot.failed ?? 0))
  const mapped = done - failed
  const percent = percentage((done / total) * 100)
  if (failed > 0) {
    const label = snapshot.running
      ? `Mapping ${done} of ${total} ${meetingNoun(total)} · ${percent}% · ${attentionDetail(failed)}`
      : `Mapped ${mapped} of ${total} ${meetingNoun(total)} · ${attentionDetail(failed)}`
    return {
      percent,
      label,
      valueText: `${mapped} of ${total} ${meetingNoun(total)} mapped; ${attentionDetail(failed)}`
    }
  }
  return {
    percent,
    label: `Mapping ${done} of ${total} ${meetingNoun(total)} · ${percent}%`,
    valueText: `${done} of ${total} ${meetingNoun(total)} mapped`
  }
}

/**
 * Describes import progress as three honest phases, without fabricating an overall completion
 * percentage:
 *
 *  1. Warm-up (queued, or decoding/transcribing before the first real checkpoint) — an indeterminate
 *     bar. `pct` starts null and, in practice, briefly reports a literal 0 (the decoder's first
 *     duration-based tick, or the state flipping to 'transcribing' before that chunk's ASR pass has
 *     returned anything) before the first meaningful checkpoint lands. Main has no cheaper way to tell
 *     these apart from a real 0%, so both are conservatively treated as "no signal yet" rather than
 *     rendering a determinate bar frozen at a dead-looking 0%.
 *  2. Transcribing — a determinate bar, `pct` emitted by the main process from durable checkpoints
 *     (capped at 99 by main until the import itself finishes).
 *  3. Wrapping up (saving, then recapping) — transcription's measurable work is done, but there is no
 *     further checkpoint until the job reaches `done`. Rendered as a full bar plus `pulseAtFull` instead
 *     of freezing at 99% for however long saving the transcript / the LLM recap call takes.
 */
export function describeImportProgress(job: ImportProgressSnapshot): ImportProgressDescription {
  const totalChunks = wholeNumber(job.totalChunks)
  const completedChunks = Math.min(totalChunks, wholeNumber(job.cursor))
  const reportedPercent = job.pct === null ? null : percentage(job.pct)
  const hasNumericProgress = totalChunks > 0 || reportedPercent !== null
  const percent = hasNumericProgress ? reportedPercent : null
  const chunkDetail = percent === null || totalChunks === 0 ? null : `chunk ${Math.min(totalChunks, completedChunks + 1)} of ${totalChunks}`
  const transcribed = percent === null ? null : `${percent}% transcribed`

  switch (job.state) {
    case 'queued':
      return {
        active: true,
        detail: 'Waiting for the import queue',
        label: 'Queued to import',
        percent: null,
        valueText: 'Waiting for the import queue',
        pulseAtFull: false
      }
    case 'decoding':
    case 'transcribing': {
      // Phase 1: no real checkpoint yet — see the doc comment above for why a literal 0 is folded in here.
      if (percent === null || percent === 0) {
        return {
          active: true,
          detail: 'Loading the transcription engine — this can take a moment.',
          label: 'Preparing on-device engine…',
          percent: null,
          valueText: 'Preparing on-device engine',
          pulseAtFull: false
        }
      }
      // Phase 2: a real, monotonic transcription percentage. Shown in exactly one place (the detail
      // line below the header) — the header names the phase only, so the number never appears twice.
      if (job.state === 'decoding') {
        return {
          active: true,
          detail: `${percent}% transcribed · preparing the next audio segment`,
          label: 'Decoding audio',
          percent,
          valueText: `${percent}% transcribed`,
          pulseAtFull: false
        }
      }
      return {
        active: true,
        detail: `${percent}% transcribed${chunkDetail ? ` · ${chunkDetail}` : ''}`,
        label: 'Transcribing audio',
        percent,
        valueText: `${percent}% transcribed`,
        pulseAtFull: false
      }
    }
    case 'saving':
      // Phase 3: rendered as a full, pulsing bar (see pulseAtFull) rather than the stalled 99% a raw
      // checkpoint readout would show — saving is usually quick, but never leaves the bar looking dead.
      return {
        active: true,
        detail: 'Finalizing your meeting…',
        label: 'Saving transcript…',
        percent: 100,
        valueText: 'Finalizing your meeting',
        pulseAtFull: true
      }
    case 'recapping':
      // Phase 3, continued: this is the stretch that can legitimately take a while (an LLM call) — the
      // bar reads as busy for the whole wait instead of stuck.
      return {
        active: true,
        detail: 'Writing an AI summary of your meeting…',
        label: 'Creating summary…',
        percent: 100,
        valueText: 'Creating summary',
        pulseAtFull: true
      }
    case 'done':
      if (job.recapError) {
        return {
          active: false,
          detail: 'Transcript saved. Open the meeting to retry the summary.',
          label: 'Summary needs attention',
          percent: 100,
          valueText: 'Transcript saved; summary needs attention',
          pulseAtFull: false
        }
      }
      return {
        active: false,
        detail: 'Import complete',
        label: 'Import complete',
        percent: 100,
        valueText: '100% imported',
        pulseAtFull: false
      }
    case 'cancelled':
      return {
        active: false,
        detail: 'Import cancelled',
        label: 'Cancelled',
        percent,
        valueText: transcribed ?? 'Import cancelled',
        pulseAtFull: false
      }
    case 'failed':
      return {
        active: false,
        detail: 'Use Resume to continue from the last saved transcript checkpoint',
        label: 'Import needs attention',
        percent,
        valueText: transcribed ?? 'Import needs attention',
        pulseAtFull: false
      }
  }
}
