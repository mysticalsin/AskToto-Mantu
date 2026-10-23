import { TASK_CARD_DONE_LINGER_MS, TASK_CARD_LIMIT, TASK_CARD_NOT_DONE_LINGER_MS } from '@shared/task-card'
import type { TaskCardPhase, TaskCardView } from '@shared/task-card'
import type { EffectOutcome } from './task-contract'
import type { SchedulerRejection } from './task-scheduler'

/** One card per scheduled desktop task. Lives in main only; the renderer gets TaskCardView. */
export interface CardRecord {
  readonly cardId: string
  /** The proposal id: also the scheduler key and the suffix of the task id. Never leaves main. */
  readonly key: string
  readonly owner: string
  readonly authSessionGeneration: number
  readonly actionId: string
  phase: TaskCardPhase
  reason?: 'stopped_before_start' | 'refused'
  finishedAt?: number
}

const LIVE_PHASES: readonly TaskCardPhase[] = ['queued', 'running', 'stopping']
/** Finished records kept in main beyond what is shown; the oldest go first. */
const CARD_RECORD_CAP = TASK_CARD_LIMIT * 2
const OWNER_RESET_REASONS: ReadonlySet<string> = new Set([
  'window_closed',
  'window_replaced',
  'renderer_replaced',
  'auth_session_cleared'
])

export interface TaskCardsDeps {
  now: () => number
  /** Opaque 32-hex ids, never derived from a task id. */
  newCardId: () => string
  warn?: (message: string, ...args: unknown[]) => void
  authSessionGeneration: () => number
  stopTask: (record: CardRecord, running: boolean) => void
}

/**
 * The card projection of the desktop task bridge (G33): records, phases, lingering and the owner-scoped views.
 * It knows nothing of tasks, grants or arguments; the bridge tells it what happened.
 */
export class TaskCards {
  private readonly records = new Map<string, CardRecord>()
  private readonly byKey = new Map<string, CardRecord>()
  private readonly listeners = new Set<() => void>()

  constructor(private readonly deps: TaskCardsDeps) {}

  /** The cards the owner may show, oldest first. A card id from another owner is simply absent. */
  list(owner: string): TaskCardView[] {
    const now = this.deps.now()
    const views: TaskCardView[] = []
    for (const record of this.records.values()) {
      if (
        record.owner !== owner ||
        record.authSessionGeneration !== this.deps.authSessionGeneration() ||
        this.expired(record, now)
      )
        continue
      views.push({
        cardId: record.cardId,
        actionId: record.actionId,
        phase: record.phase,
        ...(record.reason ? { reason: record.reason } : {}),
        stoppable: record.phase === 'queued' || record.phase === 'running',
        dismissible: record.phase === 'not_done' || record.phase === 'uncertain'
      })
    }
    return views.slice(-TASK_CARD_LIMIT)
  }

  onChanged(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** The record for this owner's card id, or undefined (unknown, another owner's, or already gone). */
  find(owner: string, cardId: string): CardRecord | undefined {
    const record = this.records.get(cardId)
    if (
      !record ||
      record.owner !== owner ||
      record.authSessionGeneration !== this.deps.authSessionGeneration() ||
      this.expired(record, this.deps.now())
    )
      return undefined
    return record
  }

  forKey(key: string): CardRecord | undefined {
    return this.byKey.get(key)
  }

  /** A card for a newly submitted job. Undefined when the key already has a live card (a duplicate submit). */
  open(key: string, owner: string, authSessionGeneration: number, actionId: string): CardRecord | undefined {
    const existing = this.byKey.get(key)
    if (existing && LIVE_PHASES.includes(existing.phase)) return undefined
    if (existing) this.drop(existing, false)
    const record: CardRecord = {
      cardId: this.deps.newCardId(),
      key,
      owner,
      authSessionGeneration,
      actionId,
      phase: 'queued'
    }
    this.records.set(record.cardId, record)
    this.byKey.set(key, record)
    this.trim()
    this.emit()
    return record
  }

  setPhase(record: CardRecord, phase: TaskCardPhase): void {
    if (record.phase === phase) return
    record.phase = phase
    this.emit()
  }

  /** Lifecycle revocation forgets only the in-memory projection; durable task outcomes continue settling. */
  clearForLifecycle(reason?: string): boolean {
    if (!reason || !OWNER_RESET_REASONS.has(reason)) return false
    this.clear()
    return true
  }

  clear(): void {
    if (this.records.size === 0) return
    this.records.clear()
    this.byKey.clear()
    this.emit()
  }

  /** Stop-all: every running card shows "stopping" until its step settles. */
  stoppingAllRunning(): void {
    for (const record of this.records.values()) if (record.phase === 'running') record.phase = 'stopping'
    this.emit()
  }

  finishEffect(record: CardRecord, outcome: EffectOutcome): void {
    const phase = outcome === 'applied' ? 'done' : outcome === 'not-applied' ? 'not_done' : 'uncertain'
    this.finish(record, phase)
  }

  finish(record: CardRecord, phase: 'done' | 'not_done' | 'uncertain', reason?: CardRecord['reason']): void {
    record.phase = phase
    if (reason) record.reason = reason
    else delete record.reason
    record.finishedAt = this.deps.now()
    const linger =
      phase === 'done' ? TASK_CARD_DONE_LINGER_MS : phase === 'not_done' ? TASK_CARD_NOT_DONE_LINGER_MS : undefined
    if (linger !== undefined) {
      // Pushes the shrunken list once the linger passes. list() filters by the injected clock either way.
      const timer = setTimeout(() => {
        if (this.records.get(record.cardId) === record && this.expired(record, this.deps.now())) this.drop(record)
      }, linger + 1)
      timer.unref?.()
    }
    this.emit()
  }

  rejectQueued(record: CardRecord | undefined, reason: SchedulerRejection): void {
    if (!record) return
    if (reason === 'invalid_job') this.drop(record)
    else this.finish(record, 'not_done', reason === 'stopped' ? 'stopped_before_start' : 'refused')
  }

  /** Stop a live card; task cancellation stays in the bridge while its projection rules live here. */
  stopCard(owner: string, cardId: string): boolean {
    const record = this.find(owner, cardId)
    if (!record || (record.phase !== 'queued' && record.phase !== 'running')) return false
    const running = record.phase === 'running'
    if (running) this.setPhase(record, 'stopping')
    this.deps.stopTask(record, running)
    return true
  }

  /** Dismiss a card that needs no more decisions (not done, or uncertain and acknowledged). */
  dismiss(owner: string, cardId: string): boolean {
    const record = this.find(owner, cardId)
    if (!record || (record.phase !== 'not_done' && record.phase !== 'uncertain')) return false
    this.drop(record)
    return true
  }

  drop(record: CardRecord, emit = true): void {
    this.records.delete(record.cardId)
    if (this.byKey.get(record.key) === record) this.byKey.delete(record.key)
    if (emit) this.emit()
  }

  emit(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener()
      } catch (error) {
        this.deps.warn?.('[desktop-action-task] a task card listener threw:', error)
      }
    }
  }

  private expired(record: CardRecord, now: number): boolean {
    if (record.finishedAt === undefined) return false
    if (record.phase === 'done') return now - record.finishedAt >= TASK_CARD_DONE_LINGER_MS
    if (record.phase === 'not_done') return now - record.finishedAt >= TASK_CARD_NOT_DONE_LINGER_MS
    return false
  }

  /** Bounded memory: past the cap the oldest finished records go first. */
  private trim(): void {
    if (this.records.size <= CARD_RECORD_CAP) return
    for (const record of [...this.records.values()]) {
      if (this.records.size <= CARD_RECORD_CAP) break
      if (record.finishedAt !== undefined) this.drop(record, false)
    }
  }
}
