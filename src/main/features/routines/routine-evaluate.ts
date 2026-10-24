import { canonicalJson } from '../../action-guard'
import type { QuietAction } from '@shared/quiet-mode-settings'
import {
  addPause,
  applyAllowanceBack,
  pushHistory,
  type JournalEntry,
  type RoutineRecord,
  type WaitReason
} from './routine-model'
import type { RoutineScope } from './routine-store'
import { expiryOf, nextOccurrence, occurrencesBetween, type Occurrence } from './schedule'

/** Phases the routine engine audits. Phase, enum reason and counts only: never a title, a phrase, an id or content. */
export type RoutineAuditPhase =
  | 'compiled'
  | 'consented'
  | 'replayed'
  | 'claimed'
  | 'settled'
  | 'waiting'
  | 'coalesced'
  | 'paused'
  | 'resumed'
  | 'deleted'
  | 'withheld'
  | 'refused'
  | 'recovered'
  | 'already_recorded'
  | 'overlap_blocked'
  | 'quota_notice'
  | 'archived'

/** One claimed occurrence, ready to run once the claim has been committed. */
export interface Job {
  scope: RoutineScope
  routineId: string
  journalKey: string
  occurrenceKey: string
  expiresAt: number
  purpose: RoutineRecord['purpose']
  title: string
  tools: readonly string[]
  action?: RoutineRecord['action']
}

/** Everything a tick looks at outside the store, read once so every routine sees the same moment. */
export interface Gates {
  now: number
  archived: Set<string>
  online: boolean
  quiet: QuietAction
  idle: boolean
  allowance: { available: true } | { available: false; resetAt: number | null }
}

export interface EvaluateOut {
  jobs: Job[]
  notices: Array<number | null>
  scope: RoutineScope
}

export interface EvaluateHooks {
  audit(phase: RoutineAuditPhase, detail?: { reason?: string; count?: number }): void
  /** Allowance notices already shown (one per resetAt). */
  noticed: Set<number>
}

/** The run lease key: one per `(routineId, revision, occurrenceKey)`. */
export const leaseKey = (routineId: string, revision: number, occurrenceKey: string): string =>
  canonicalJson([routineId, revision, occurrenceKey])

/**
 * One routine, one tick. Pure over the store view: it returns the next record, appends a `running` lease to `journal` when
 * it claims an occurrence, and queues the job in `out`. Order of the gates: pause reasons, the assistant's archive state,
 * the allowance, then the waits (network, quiet, an open confirm card). A wait never touches `failures` and leaves the
 * occurrence claimable until it expires.
 */
export function evaluateRoutine(
  r: RoutineRecord,
  journal: JournalEntry[],
  gates: Gates,
  out: EvaluateOut,
  hooks: EvaluateHooks
): RoutineRecord {
  const { now } = gates
  const { audit, noticed } = hooks
  if (r.status !== 'active') return r
  let cur = r
  if (cur.pauseReasons.includes('quota') && gates.allowance.available) {
    // Only `quota` clears. What passed while the allowance was out is not owed.
    cur = { ...applyAllowanceBack(cur), lastEvaluatedAt: now }
  }
  if (gates.archived.has(cur.assistantId) && !cur.pauseReasons.includes('archive')) {
    cur = addPause(cur, 'archive')
    audit('archived')
  }
  if (!gates.allowance.available && !cur.pauseReasons.includes('quota')) {
    const resetAt = gates.allowance.resetAt
    cur = addPause(cur, 'quota')
    // The notice is shown once per resetAt, however many routines the allowance pauses.
    const shownFor = cur.quota?.noticeShownFor ?? null
    const marker = resetAt ?? 0
    cur = { ...cur, quota: { resetAt, noticeShownFor: marker } }
    if (shownFor !== marker && !noticed.has(marker)) out.notices.push(resetAt)
    noticed.add(marker)
  }
  if (cur.pauseReasons.length > 0) {
    // Resume moves the cursor to now, so what passes while paused is never replayed.
    const nextDueAt = nextOccurrence(cur.schedule, now)?.dueAt ?? null
    const { waiting: _waiting, ...rest } = cur
    void _waiting
    return cur === r && r.nextDueAt === nextDueAt && !r.waiting ? r : { ...rest, nextDueAt }
  }
  const due = occurrencesBetween(cur.schedule, cur.lastEvaluatedAt, now)
  const nextDueAt = nextOccurrence(cur.schedule, now)?.dueAt ?? null
  if (due.length === 0) return cur.nextDueAt === nextDueAt ? cur : { ...cur, nextDueAt }
  const live: Occurrence[] = due.filter((o) => expiryOf(cur.schedule, o) > now)
  const latest = live.at(-1)
  const skipped = due.length - (latest ? 1 : 0)
  if (!latest) {
    audit('coalesced', { count: due.length })
    const done = cur.consent.consentKind === 'once'
    return {
      ...pushHistory(cur, { outcome: 'coalesced', at: now, count: due.length, occurrenceKey: due.at(-1)!.key }),
      lastEvaluatedAt: now,
      waiting: undefined,
      nextDueAt: done ? null : nextDueAt,
      status: done ? 'completed' : 'active',
      updatedAt: now
    }
  }
  if (skipped > 0) {
    audit('coalesced', { count: skipped })
    // Recorded once; the cursor sits just before the occurrence being claimed so the same ones are not counted twice.
    cur = {
      ...pushHistory(cur, { outcome: 'coalesced', at: now, count: skipped, occurrenceKey: latest.key }),
      lastEvaluatedAt: latest.dueAt - 1
    }
  }
  const wait: WaitReason | null = !gates.online
    ? 'network'
    : gates.quiet === 'defer'
      ? 'quiet'
      : cur.purpose === 'scheduled_task' && !gates.idle
        ? 'owner_busy'
        : null
  if (wait) {
    if (cur.waiting?.reason === wait && cur.waiting.occurrenceKey === latest.key) return { ...cur, nextDueAt }
    audit('waiting', { reason: wait })
    return {
      ...pushHistory(cur, { outcome: 'waiting', at: now, waitReason: wait, occurrenceKey: latest.key }),
      waiting: { reason: wait, since: now, occurrenceKey: latest.key },
      nextDueAt,
      updatedAt: now
    }
  }
  const key = leaseKey(cur.routineId, cur.revision, latest.key)
  if (journal.some((e) => e.key === key)) {
    audit('already_recorded')
    return { ...cur, lastEvaluatedAt: latest.dueAt, waiting: undefined, nextDueAt }
  }
  if (journal.some((e) => e.routineId === cur.routineId && e.status === 'running')) {
    audit('overlap_blocked')
    return cur
  }
  const expiresAt = expiryOf(cur.schedule, latest)
  journal.push({
    key,
    routineId: cur.routineId,
    ownerKey: cur.ownerKey,
    tenantKey: cur.tenantKey,
    status: 'running',
    dueAt: latest.dueAt,
    expiresAt,
    startedAt: now
  })
  out.jobs.push({
    scope: out.scope,
    routineId: cur.routineId,
    journalKey: key,
    occurrenceKey: latest.key,
    expiresAt,
    purpose: cur.purpose,
    title: cur.title,
    tools: cur.tools,
    ...(cur.action ? { action: cur.action } : {})
  })
  audit('claimed')
  const done = cur.consent.consentKind === 'once'
  return {
    ...cur,
    lastEvaluatedAt: latest.dueAt,
    waiting: undefined,
    nextDueAt: done ? null : nextDueAt,
    status: done ? 'completed' : 'active',
    updatedAt: now
  }
}
