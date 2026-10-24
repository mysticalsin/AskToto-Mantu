/**
 * Copy and formatting for routines (G69, CAP-31). Pure: every string a routine row, the editor or a refusal shows comes
 * from here, so the waiting and paused wording stays exact and testable. A routine runs only while Métis is open, so no
 * string here may claim it is always on.
 */
import {
  ROUTINE_FAILURE_PAUSE_AT,
  type COMPILE_REFUSALS,
  type CONSENT_REFUSALS,
  type LIST_REFUSALS,
  type MUTATION_REFUSALS,
  type ERROR_CLASSES,
  type PauseReasonSchema,
  type RoutineView,
  type WAIT_REASONS
} from '@shared/routines'
import type { z } from 'zod'

type ErrorClass = (typeof ERROR_CLASSES)[number]
type WaitReason = (typeof WAIT_REASONS)[number]
type PauseReason = z.infer<typeof PauseReasonSchema>
type HistoryEntry = RoutineView['history'][number]

const WHEN = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit'
})

/** A local date and time, for next runs, resets and outcomes. */
export function formatWhen(ms: number): string {
  return WHEN.format(new Date(ms))
}

export const ERROR_LABELS: Record<ErrorClass, string> = {
  provider: 'AI provider error',
  connector: 'Connector error',
  timeout: 'Timed out',
  internal: 'Something went wrong in Métis'
}

export const WAIT_COPY: Record<WaitReason, string> = {
  network: 'Waiting: network',
  quiet: 'Waiting: quiet mode',
  owner_busy: "Waiting: you're busy"
}
const WAIT_SHORT: Record<WaitReason, string> = { network: 'network', quiet: 'quiet mode', owner_busy: "you're busy" }

export const PURPOSE_COPY = {
  reminder: 'Reminder',
  read_only_suggestion: 'Suggestion check',
  scheduled_task: 'Task'
} as const

export const TOOL_COPY = { 'connector.read': 'Read connected accounts', 'web.search': 'Search the web' } as const

export const consentKindCopy = (kind: RoutineView['consentKind']): string => (kind === 'once' ? 'Runs once' : 'Repeats')

export const LIST_REFUSAL_COPY: Record<(typeof LIST_REFUSALS)[number], string> = {
  'signed-out': 'Sign in to use routines',
  invalid: 'Métis could not read your routines',
  unavailable: 'Routines are not available right now'
}

export const COMPILE_REFUSAL_COPY: Record<(typeof COMPILE_REFUSALS)[number], string> = {
  'signed-out': 'Sign in to use routines',
  invalid: 'Check the routine details and try again',
  invalid_zone: 'Your time zone is not recognised',
  invalid_schedule: 'That schedule is not valid',
  unrecognized_schedule: 'Métis did not understand when to run it. Try "every weekday at 9am".',
  consent_mismatch: 'Choose Just once for a one-time schedule, or Repeat for a repeating one',
  tool_not_allowed: 'That routine cannot use one of the chosen tools',
  unsupported: 'That kind of routine is not supported yet',
  unknown_assistant: 'That assistant no longer exists',
  assistant_archived: 'That assistant is archived',
  limit: 'You have reached the routine limit',
  unavailable: 'Routines are not available right now'
}

export const CONSENT_REFUSAL_COPY: Record<(typeof CONSENT_REFUSALS)[number], string> = {
  'signed-out': 'Sign in to use routines',
  invalid: 'Preview again before creating',
  'unknown-proposal': 'Preview expired. Preview again.',
  expired: 'Preview expired. Preview again.',
  'preview-mismatch': 'The preview changed. Preview again.',
  unknown_assistant: 'That assistant no longer exists',
  assistant_archived: 'That assistant is archived',
  limit: 'You have reached the routine limit',
  stale: 'Something changed. Preview again.',
  unavailable: 'Routines are not available right now'
}

export const MUTATION_REFUSAL_COPY: Record<(typeof MUTATION_REFUSALS)[number], string> = {
  'signed-out': 'Sign in to use routines',
  invalid: 'Métis could not do that',
  'not-found': 'That routine no longer exists',
  paused: 'Resume the routine first',
  not_runnable: 'That routine cannot run right now',
  reconciliation_required: 'Check the last interrupted run before resuming',
  assistant_archived: 'That assistant is archived',
  stale: 'The routine changed. Try again.',
  unavailable: 'Routines are not available right now'
}

/** The availability line every row shows. Never "always on". */
export function availabilityLine(view: RoutineView): string {
  return view.availability.runner === 'not_running'
    ? `${view.availability.copy} · Not running now`
    : view.availability.copy
}

export interface RoutineStatus {
  tone: 'active' | 'waiting' | 'paused' | 'done'
  primary: string
  secondary?: string
}

const PAUSE_ORDER: readonly PauseReason[] = ['failure', 'archive', 'review', 'quota', 'user']

function pauseCopy(reason: PauseReason, view: RoutineView): string {
  switch (reason) {
    case 'failure':
      return `Paused after ${ROUTINE_FAILURE_PAUSE_AT} failures · last error: ${ERROR_LABELS[view.lastErrorClass ?? 'internal']}`
    case 'archive':
      return 'Paused: assistant archived'
    case 'review':
      return 'Paused: needs review'
    case 'quota':
      return view.quotaResetAt === null
        ? 'Waiting for allowance reset'
        : `Waiting for allowance reset ${formatWhen(view.quotaResetAt)}`
    case 'user':
      return 'Paused'
  }
}

/** Row status in precedence order: done, paused (every reason), waiting, then active. */
export function routineStatus(view: RoutineView, _now: number): RoutineStatus {
  if (view.status === 'completed') return { tone: 'done', primary: 'Done' }
  if (view.pauseReasons.length > 0) {
    const primary = PAUSE_ORDER.filter((r) => view.pauseReasons.includes(r))
      .map((r) => pauseCopy(r, view))
      .join(' · ')
    return { tone: 'paused', primary }
  }
  const parts: string[] = []
  if (view.nextDueAt !== null) parts.push(`Next run ${formatWhen(view.nextDueAt)}`)
  if (view.failures > 0) parts.push(`${view.failures} of ${ROUTINE_FAILURE_PAUSE_AT} failures`)
  const secondary = parts.length > 0 ? parts.join(' · ') : undefined
  if (view.waiting) return { tone: 'waiting', primary: WAIT_COPY[view.waiting.reason], secondary }
  return { tone: 'active', primary: 'Active', secondary }
}

/** The last run, in words, or null when the routine has not run yet. */
export function lastOutcomeCopy(entry: HistoryEntry | undefined, _now: number): string | null {
  if (!entry) return null
  switch (entry.outcome) {
    case 'succeeded':
      return `Ran ${formatWhen(entry.at)}`
    case 'failed':
      return `Failed ${formatWhen(entry.at)}: ${ERROR_LABELS[entry.errorClass ?? 'internal']}`
    case 'cancelled':
      return 'Cancelled'
    case 'uncertain':
      return 'Result unclear. Check it before resuming'
    case 'coalesced':
      return `Caught up (${entry.count ?? 1} missed)`
    case 'waiting':
      return `Waited: ${WAIT_SHORT[entry.waitReason ?? 'network']}`
    case 'suppressed':
      return 'Held for quiet mode'
  }
}
