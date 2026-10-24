/**
 * Copy for suggestion cards and the suggestion queue (G69, CAP-32). Pure. A queued or running check is never shown as
 * a failure, and each evidence line keeps when the thing happened apart from when Métis read it.
 */
import type { AcceptResult, DismissReason, ListResult, RUN_ERROR_CLASSES } from '@shared/suggestions'
import { formatWhen } from '../routines/routine-copy'

type Evidence = Extract<ListResult, { ok: true }>['cards'][number]['evidence'][number]

export const STALE_COPY = 'This suggestion changed. Showing the latest.'
export const SOURCES_CHANGED_COPY = 'Its sources changed. Check again.'

export const DISMISS_REASON_COPY: Record<DismissReason, string> = {
  not_useful: 'Not useful',
  wrong: 'Wrong',
  already_done: 'Already done',
  other: 'Other'
}

const RUN_ERROR_LABELS: Record<(typeof RUN_ERROR_CLASSES)[number], string> = {
  connector: 'Connector error',
  internal: 'Something went wrong in Métis',
  timeout: 'Timed out'
}

const REFUSAL_COPY = {
  'signed-out': 'Sign in to use suggestions',
  disabled: 'Suggestions are off',
  unavailable: 'Suggestions are not available right now',
  invalid: 'Métis could not do that'
} as const

export interface QueueHealth {
  tone: 'queued' | 'checking' | 'failed' | 'empty' | 'idle' | 'off' | 'unavailable'
  text: string
}

/** Queued, Checking and Failed are distinct states; an active run always wins over the last run's failure. */
export function queueHealth(list: ListResult): QueueHealth {
  if (!list.ok) {
    if (list.reason === 'disabled') return { tone: 'off', text: REFUSAL_COPY.disabled }
    return { tone: 'unavailable', text: REFUSAL_COPY[list.reason] }
  }
  if (list.activeRun?.state === 'queued') return { tone: 'queued', text: 'Queued' }
  if (list.activeRun?.state === 'running') return { tone: 'checking', text: 'Checking' }
  if (list.lastRun?.state === 'failed') {
    return { tone: 'failed', text: `Failed: ${RUN_ERROR_LABELS[list.lastRun.errorClass ?? 'internal']}` }
  }
  if (list.lastRun?.state === 'succeeded' && list.cards.length === 0) {
    return { tone: 'empty', text: 'No suggestions right now. Check now anytime.' }
  }
  return { tone: 'idle', text: '' }
}

/** "5 min ago" style, coarse on purpose. */
export function relativeTime(ms: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - ms) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  return `${Math.floor(hours / 24)} d ago`
}

export function evidenceLine(evidence: Evidence, now: number): string {
  const when = evidence.eventAt === null ? 'no date' : formatWhen(evidence.eventAt)
  return `${evidence.label} · ${when} · read ${relativeTime(evidence.retrievedAt, now)}`
}

export function acceptOutcomeCopy(result: AcceptResult): string {
  if (result.ok) return result.sources.length > 0 ? `Accepted. Sources: ${result.sources.join(', ')}` : 'Accepted.'
  if (result.reason === 'stale') return STALE_COPY
  if (result.reason === 'sources_changed') return SOURCES_CHANGED_COPY
  return REFUSAL_COPY[result.reason]
}

/** Copy for a refused shown, dismiss or adjust reply. */
export function ackRefusalCopy(reason: keyof typeof REFUSAL_COPY | 'stale'): string {
  return reason === 'stale' ? STALE_COPY : REFUSAL_COPY[reason]
}
