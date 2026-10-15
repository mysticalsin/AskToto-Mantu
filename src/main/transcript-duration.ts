import { meetingDurationMinutes } from '@shared/meeting-duration'

/** Preserve the main-process transcript duration API, including its legacy startedAt input shape. */
export const meetingDurationMin = meetingDurationMinutes as (m: {
  startedAt: number
  durationMs?: number
  lines: { t: number }[]
}) => number
