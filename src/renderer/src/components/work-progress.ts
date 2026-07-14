import type { ImportJobView } from '@shared/ipc'

export interface WorkProgressDescription {
  percent: number | null
  label: string
  valueText: string
}

export interface ImportProgressDescription extends WorkProgressDescription {
  active: boolean
  detail: string
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
 * Describes import progress without fabricating an overall completion percentage. `pct` is emitted by
 * the main process from durable transcription checkpoints; stages after transcription retain the real
 * checkpoint value (capped at 99 by main) until the import itself is finished.
 */
export function describeImportProgress(job: ImportProgressSnapshot): ImportProgressDescription {
  const totalChunks = wholeNumber(job.totalChunks)
  const completedChunks = Math.min(totalChunks, wholeNumber(job.cursor))
  const percent = totalChunks > 0 ? percentage(job.pct) : null
  const chunkDetail = percent === null ? null : `chunk ${Math.min(totalChunks, completedChunks + 1)} of ${totalChunks}`
  const transcribed = percent === null ? null : `${percent}% transcribed`

  switch (job.state) {
    case 'queued':
      return {
        active: true,
        detail: 'Waiting for the import queue',
        label: 'Queued to import',
        percent: null,
        valueText: 'Waiting for the import queue'
      }
    case 'decoding':
      return {
        active: true,
        detail: transcribed ? `${transcribed} · preparing the next audio segment` : 'Preparing audio for transcription',
        label: 'Decoding audio',
        percent,
        valueText: transcribed ?? 'Preparing audio for transcription'
      }
    case 'transcribing':
      return {
        active: true,
        detail: transcribed && chunkDetail ? `${transcribed} · ${chunkDetail}` : 'Listening for speech',
        label: 'Transcribing audio',
        percent,
        valueText: transcribed ?? 'Listening for speech'
      }
    case 'saving':
      return {
        active: true,
        detail: transcribed ? `${transcribed} · finalizing your meeting` : 'Finalizing your meeting',
        label: 'Saving transcript',
        percent,
        valueText: transcribed ?? 'Finalizing your meeting'
      }
    case 'recapping':
      return {
        active: true,
        detail: transcribed ? `${transcribed} · creating a summary` : 'Creating a summary',
        label: 'Creating summary',
        percent,
        valueText: transcribed ?? 'Creating a summary'
      }
    case 'done':
      if (job.recapError) {
        return {
          active: false,
          detail: 'Transcript saved. Open the meeting to retry the summary.',
          label: 'Summary needs attention',
          percent: 100,
          valueText: 'Transcript saved; summary needs attention'
        }
      }
      return {
        active: false,
        detail: 'Import complete',
        label: 'Import complete',
        percent: 100,
        valueText: '100% imported'
      }
    case 'cancelled':
      return {
        active: false,
        detail: 'Import cancelled',
        label: 'Cancelled',
        percent,
        valueText: transcribed ?? 'Import cancelled'
      }
    case 'failed':
      return {
        active: false,
        detail: 'Use Resume to continue from the last saved transcript checkpoint',
        label: 'Import needs attention',
        percent,
        valueText: transcribed ?? 'Import needs attention'
      }
  }
}
