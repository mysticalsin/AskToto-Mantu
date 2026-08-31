/**
 * time-saved-events.ts — honest sensors for "time saved with Métis".
 *
 * Every minute is an ESTIMATE. Heuristics (also in docs/design/TIME-SAVED.md):
 *   note-taking     = words / 180 wpm          (hand-writing the note you did not write)
 *   second-brain    = 2 min per opportunity    (capturing a commitment / follow-up), cap 15
 *   email-summary   = 4 min                    (drafting the follow-up email by hand)
 *   mcp-push        = 3 min                    (filing the note into Outlook / CRM by hand)
 *
 * Never invent a percentage. Never credit an event that did not happen. A disconnected
 * connector does not write an mcp-push event.
 */

import { wordCount } from './answer-first'

export const TIME_SAVED_EVENT_KINDS = ['note-taking', 'second-brain', 'email-summary', 'mcp-push'] as const
export type TimeSavedEventKind = (typeof TIME_SAVED_EVENT_KINDS)[number]

export const TIME_SAVED_CONNECTORS = ['bidstack', 'plane', 'clickup', 'outlook', 'none'] as const
export type TimeSavedConnector = (typeof TIME_SAVED_CONNECTORS)[number]

/** Documented heuristics. Change here and in TIME-SAVED.md together. */
export const NOTE_TAKING_WPM = 180
export const SECOND_BRAIN_MIN_PER_OPPORTUNITY = 2
export const SECOND_BRAIN_CAP_MIN = 15
export const EMAIL_SUMMARY_MIN = 4
export const MCP_PUSH_MIN = 3

export interface TimeSavedEvent {
  kind: TimeSavedEventKind
  timestamp: number
  /** Estimate, never a measured stopwatch. */
  estimatedMinutes: number
  connector?: TimeSavedConnector
  ids?: {
    meeting?: string
    note?: string
    tool?: string
    draft?: string
  }
}

export interface TimeSavedEventTotals {
  savedMinutes: number
  byKind: Record<TimeSavedEventKind, number>
  events: number
}

export function estimateNoteTakingMinutes(words: number): number {
  const w = Number.isFinite(words) && words > 0 ? Math.floor(words) : 0
  if (w <= 0) return 0
  return Math.max(1, Math.round(w / NOTE_TAKING_WPM))
}

export function estimateSecondBrainMinutes(opportunities: number): number {
  const n = Number.isFinite(opportunities) && opportunities > 0 ? Math.floor(opportunities) : 0
  if (n <= 0) return 0
  return Math.min(SECOND_BRAIN_CAP_MIN, n * SECOND_BRAIN_MIN_PER_OPPORTUNITY)
}

export function estimateEmailSummaryMinutes(): number {
  return EMAIL_SUMMARY_MIN
}

export function estimateMcpPushMinutes(): number {
  return MCP_PUSH_MIN
}

export function wordsFromTexts(...parts: Array<string | undefined | null>): number {
  return wordCount(parts.filter((p): p is string => !!p).join(' '))
}

export function totalsFromEvents(events: TimeSavedEvent[]): TimeSavedEventTotals {
  const byKind: Record<TimeSavedEventKind, number> = {
    'note-taking': 0,
    'second-brain': 0,
    'email-summary': 0,
    'mcp-push': 0
  }
  let savedMinutes = 0
  for (const e of events) {
    const mins = Number.isFinite(e.estimatedMinutes) && e.estimatedMinutes > 0 ? e.estimatedMinutes : 0
    savedMinutes += mins
    if (e.kind in byKind) byKind[e.kind] += mins
  }
  return { savedMinutes, byKind, events: events.length }
}

export function kindLabel(kind: TimeSavedEventKind): string {
  switch (kind) {
    case 'note-taking':
      return 'Notes'
    case 'second-brain':
      return 'Second brain'
    case 'email-summary':
      return 'Email + next steps'
    case 'mcp-push':
      return 'Pushed'
  }
}

export function connectorLabel(connector: TimeSavedConnector | undefined): string {
  switch (connector) {
    case 'bidstack':
      return 'Polo Pre-Sales'
    case 'plane':
      return 'Plane'
    case 'clickup':
      return 'ClickUp'
    case 'outlook':
      return 'Outlook'
    default:
      return ''
  }
}
