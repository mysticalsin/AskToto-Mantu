/** Only measured, finite, non-negative durations may override a legacy transcript-span estimate. */
export function measuredDurationMs(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER
    ? Math.round(value)
    : undefined
}

type Timing = { durationMs?: number; lines: readonly { t: number }[] }

export function transcriptSpanMs(lines: Timing['lines']): number {
  let first = Infinity
  let last = -Infinity
  for (const line of lines) {
    if (!Number.isFinite(line.t)) continue
    first = Math.min(first, line.t)
    last = Math.max(last, line.t)
  }
  return first === Infinity ? 0 : last - first
}

export function meetingDurationMinutes(meeting: Timing): number {
  const measured = measuredDurationMs(meeting.durationMs)
  if (measured !== undefined) return measured > 0 ? Math.max(1, Math.round(measured / 60_000)) : 0
  if (!meeting.lines.some((line) => Number.isFinite(line.t))) return 0
  return Math.max(1, Math.round(transcriptSpanMs(meeting.lines) / 60_000))
}

export function reviewDurationSeconds(meeting: Timing & {
  startedAt?: number; endedAt: number; isPastMeeting?: boolean
}): number {
  const measured = measuredDurationMs(meeting.durationMs)
  if (measured !== undefined) return Math.round(measured / 1000)
  if (meeting.lines.length > 1) return Math.floor(transcriptSpanMs(meeting.lines) / 1000)
  // Unknown legacy duration must not grow just because its Review was opened today.
  if (meeting.isPastMeeting || !meeting.startedAt) return 0
  return Math.max(0, Math.floor((meeting.endedAt - meeting.startedAt) / 1000))
}
