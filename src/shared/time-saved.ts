/**
 * time-saved.ts — the honest "time saved with Métis" estimate.
 *
 * This is an ESTIMATE, not a measured fact, and the rest of the app is strict about never presenting a
 * prediction as a fact (see shared/mars.ts's "counted or quoted, never predicted" law). So the model here
 * is deliberately ONE defensible axis, fully transparent, and driven by numbers the user can see and
 * adjust: the meeting write-up you did NOT do because Métis summarized the conversation for you.
 *
 * Per meeting, the notes/recap you'd otherwise write by hand ≈ a fraction of the meeting's length, floored
 * and capped so a 3-minute call and a 3-hour call both land in a sane band:
 *
 *     perMeetingSaved(durationMin) = clamp(durationMin * writeupRatio, floorMin, capMin)
 *
 * No speculative second axis (per-ask recall time, live-suggestion value) — those would inflate the number
 * with things we cannot defend. The UI labels the result as an estimate and shows the assumption.
 */

/** The adjustable assumption behind the estimate (persisted as settings.timeSaved). */
export interface TimeSavedAssumptions {
  /** Fraction of a meeting's length spent writing it up by hand. */
  writeupRatio: number
  /** Never credit less than this per meeting (even a 2-minute call needs a note). */
  floorMin: number
  /** Never credit more than this per meeting (a long meeting is not summarized proportionally forever). */
  capMin: number
}

export const DEFAULT_TIME_SAVED_ASSUMPTIONS: TimeSavedAssumptions = {
  writeupRatio: 0.2,
  floorMin: 5,
  capMin: 30
}

/** The computed estimate plus every input that produced it, so the UI can show its work. */
export interface TimeSaved {
  /** The headline: estimated minutes of write-up avoided across all summarized meetings. */
  savedMinutes: number
  /** Number of meetings the figure is based on. */
  meetings: number
  /** Total minutes of conversation Métis captured. */
  conversationMinutes: number
  /** The effective per-meeting figure, for the "~13 min avoided per meeting" line. 0 when no meetings. */
  perMeetingAvgMin: number
}

function clampAssumptions(a: TimeSavedAssumptions): TimeSavedAssumptions {
  // A hand-edited or managed-config value could arrive out of range or non-finite; keep the math sane
  // rather than propagate NaN into a user-facing number.
  const num = (v: number, def: number, lo: number, hi: number): number =>
    Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def
  const floorMin = num(a.floorMin, DEFAULT_TIME_SAVED_ASSUMPTIONS.floorMin, 0, 600)
  const capMin = Math.max(floorMin, num(a.capMin, DEFAULT_TIME_SAVED_ASSUMPTIONS.capMin, 0, 600))
  return {
    writeupRatio: num(a.writeupRatio, DEFAULT_TIME_SAVED_ASSUMPTIONS.writeupRatio, 0, 2),
    floorMin,
    capMin
  }
}

/** Minutes of write-up avoided for a single meeting of `durationMin` length. */
export function perMeetingSaved(durationMin: number, a: TimeSavedAssumptions): number {
  const dur = Number.isFinite(durationMin) && durationMin > 0 ? durationMin : 0
  if (dur === 0) return 0 // a zero-length "meeting" (no speech captured) saved nothing to write up
  const { writeupRatio, floorMin, capMin } = clampAssumptions(a)
  return Math.min(capMin, Math.max(floorMin, dur * writeupRatio))
}

/**
 * Precise estimate over the meetings still on disk (each carries its own durationMin). Used where the
 * meeting list is already in hand (the dashboard), so every meeting is credited by its real length.
 */
export function timeSavedFromMeetings(
  meetings: { durationMin: number }[],
  a: TimeSavedAssumptions = DEFAULT_TIME_SAVED_ASSUMPTIONS
): TimeSaved {
  let savedMinutes = 0
  let conversationMinutes = 0
  for (const m of meetings) {
    const dur = Number.isFinite(m.durationMin) && m.durationMin > 0 ? m.durationMin : 0
    conversationMinutes += dur
    savedMinutes += perMeetingSaved(dur, a)
  }
  const meetingsCount = meetings.length
  return {
    savedMinutes: Math.round(savedMinutes),
    meetings: meetingsCount,
    conversationMinutes: Math.round(conversationMinutes),
    perMeetingAvgMin: meetingsCount ? Math.round(savedMinutes / meetingsCount) : 0
  }
}

/**
 * Aggregate estimate from the durable lifetime counters (settings.usageStats), which survive retention
 * deletion. Individual meeting lengths are gone, so it credits each meeting at the average length — the
 * honest best estimate once the transcripts themselves have been purged. This is the "since you started"
 * figure; timeSavedFromMeetings is the precise "from your current meetings" one.
 */
export function timeSavedFromTotals(
  totals: { meetingsSummarized: number; conversationMinutes: number },
  a: TimeSavedAssumptions = DEFAULT_TIME_SAVED_ASSUMPTIONS
): TimeSaved {
  const meetings = Math.max(0, Math.floor(totals.meetingsSummarized || 0))
  const conversationMinutes = Math.max(0, totals.conversationMinutes || 0)
  if (meetings === 0) {
    return { savedMinutes: 0, meetings: 0, conversationMinutes: 0, perMeetingAvgMin: 0 }
  }
  const avgDuration = conversationMinutes / meetings
  const perMeeting = perMeetingSaved(avgDuration, a)
  const savedMinutes = perMeeting * meetings
  return {
    savedMinutes: Math.round(savedMinutes),
    meetings,
    conversationMinutes: Math.round(conversationMinutes),
    perMeetingAvgMin: Math.round(perMeeting)
  }
}

/** Human-friendly "5.2 hours" / "45 min" for a minute count. Whole minutes under an hour; one decimal
 *  hour above, trimming a trailing ".0" so a clean 6h reads "6 hours", not "6.0 hours". */
export function formatSavedTime(savedMinutes: number): string {
  const mins = Math.max(0, Math.round(savedMinutes))
  if (mins < 60) return `${mins} min`
  const hours = mins / 60
  const rounded = Math.round(hours * 10) / 10
  const label = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
  return `${label} ${rounded === 1 ? 'hour' : 'hours'}`
}
