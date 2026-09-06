/**
 * Durable offline outbox for Operator ingest (PLAN.md section 3). Ask/CRM/rating sends that fail on
 * network error, a 5xx, or a 429 are appended here instead of dropped, and drained on the next
 * heartbeat tick with bounded backoff. Heartbeats themselves are never queued (they're periodic
 * anyway), and neither is `/v1/use` (a live proxy call, not a durable event).
 *
 * File I/O (loadQueueState/saveQueueState/enqueueOperatorItem/drainOperatorQueue) is impure and talks
 * to `<userDataDir>/operator-queue.json`. Every state transition (addItem, dueItems, markSucceeded,
 * markFailed, consumeDropped, backoffForAttempt) is a pure function over QueueState so the scheduling
 * logic is testable without touching disk.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { mainLog } from './logger'

export const OPERATOR_QUEUE_FILE = 'operator-queue.json'
export const OPERATOR_QUEUE_MAX_ITEMS = 500
/** Never queue these: heartbeats are periodic on their own, and /v1/use is a live proxy call. */
export const OPERATOR_QUEUE_BLOCKED_PATHS: ReadonlySet<string> = new Set(['/v1/heartbeat', '/v1/use'])

const BACKOFF_SCHEDULE_MS = [60_000, 5 * 60_000, 15 * 60_000] as const
const BACKOFF_CAP_MS = 60 * 60_000

export interface QueueItem {
  /** Internal queue id (never the ask id — an ask body keeps its own `id`/`ts` for Worker-side dedup). */
  id: string
  path: string
  body: Record<string, unknown>
  enqueuedAt: number
  attempts: number
  nextAttemptAt: number
}

export interface QueueState {
  items: QueueItem[]
  /** Items dropped for exceeding the cap since the last time a report consumed this counter. */
  droppedSinceReport: number
}

export interface QueueDrainReport {
  queued: number
  dropped: number
}

export type QueueSendResult = { ok: boolean; status?: number; retryAfterMs?: number }
export type QueueSender = (path: string, body: Record<string, unknown>) => Promise<QueueSendResult>

export function emptyQueueState(): QueueState {
  return { items: [], droppedSinceReport: 0 }
}

/** 1 min, 5 min, 15 min, then capped at 1 h. `attempts` is the count of PRIOR failed attempts. */
export function backoffForAttempt(attempts: number): number {
  if (attempts < 0) return BACKOFF_SCHEDULE_MS[0]
  if (attempts < BACKOFF_SCHEDULE_MS.length) return BACKOFF_SCHEDULE_MS[attempts]
  return BACKOFF_CAP_MS
}

/** Append one item, honouring an explicit Worker-supplied retryAfterMs for the first attempt. Caps the
 *  queue at OPERATOR_QUEUE_MAX_ITEMS by dropping the OLDEST item, counting each drop. */
export function addItem(
  state: QueueState,
  item: Pick<QueueItem, 'id' | 'path' | 'body' | 'enqueuedAt'>,
  now: number,
  opts?: { retryAfterMs?: number }
): QueueState {
  const nextAttemptAt = now + (opts?.retryAfterMs ?? backoffForAttempt(0))
  const items = [...state.items, { ...item, attempts: 0, nextAttemptAt }]
  let droppedSinceReport = state.droppedSinceReport
  while (items.length > OPERATOR_QUEUE_MAX_ITEMS) {
    items.shift()
    droppedSinceReport += 1
  }
  return { items, droppedSinceReport }
}

export function dueItems(state: QueueState, now: number): QueueItem[] {
  return state.items.filter((i) => i.nextAttemptAt <= now)
}

export function markSucceeded(state: QueueState, itemId: string): QueueState {
  return { ...state, items: state.items.filter((i) => i.id !== itemId) }
}

/** Failure reschedules with the backoff for the NEW attempt count, or the Worker's retryAfterMs (e.g.
 *  a 429) when one was given — a real server-declared window always outranks the local guess. */
export function markFailed(
  state: QueueState,
  itemId: string,
  now: number,
  opts?: { retryAfterMs?: number }
): QueueState {
  return {
    ...state,
    items: state.items.map((i) => {
      if (i.id !== itemId) return i
      const attempts = i.attempts + 1
      return { ...i, attempts, nextAttemptAt: now + (opts?.retryAfterMs ?? backoffForAttempt(attempts)) }
    })
  }
}

/** Read and reset the dropped counter in one step, so each heartbeat reports drops exactly once. */
export function consumeDropped(state: QueueState): { dropped: number; state: QueueState } {
  if (state.droppedSinceReport === 0) return { dropped: 0, state }
  return { dropped: state.droppedSinceReport, state: { ...state, droppedSinceReport: 0 } }
}

const QueueItemSchema = z.object({
  id: z.string().min(1),
  path: z.string().min(1),
  body: z.record(z.unknown()),
  enqueuedAt: z.number(),
  attempts: z.number().int().nonnegative(),
  nextAttemptAt: z.number()
})
const QueueStateSchema = z.object({
  items: z.array(QueueItemSchema),
  droppedSinceReport: z.number().int().nonnegative()
})

export function queueFilePath(userDataDir: string): string {
  return join(userDataDir, OPERATOR_QUEUE_FILE)
}

/** Corrupt or unreadable file: warn and start empty. Never throws. */
export function loadQueueState(userDataDir: string): QueueState {
  const p = queueFilePath(userDataDir)
  try {
    if (!existsSync(p)) return emptyQueueState()
    const parsed = QueueStateSchema.safeParse(JSON.parse(readFileSync(p, 'utf8')))
    if (!parsed.success) {
      mainLog.warn('[operator-queue] corrupt queue file, starting empty')
      return emptyQueueState()
    }
    return parsed.data
  } catch (e) {
    mainLog.warn('[operator-queue] failed to read queue file, starting empty:', e)
    return emptyQueueState()
  }
}

/** Atomic write: tmp file then rename, mirroring the tmp+rename pattern used elsewhere in main/store.ts.
 *  Best-effort: a write failure is logged, never thrown (a lost heartbeat tick must not crash the app). */
export function saveQueueState(userDataDir: string, state: QueueState): void {
  const p = queueFilePath(userDataDir)
  const tmp = `${p}.tmp`
  try {
    mkdirSync(userDataDir, { recursive: true })
    writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 })
    renameSync(tmp, p)
  } catch (e) {
    mainLog.warn('[operator-queue] failed to persist queue file:', e)
    try {
      if (existsSync(tmp)) rmSync(tmp)
    } catch {
      /* best-effort cleanup only */
    }
  }
}

/** Enqueue one failed send. Refuses heartbeat/use paths outright (belt-and-suspenders — callers should
 *  never offer them, but a durable outbox must not silently start accepting them from a future call site). */
export function enqueueOperatorItem(
  userDataDir: string,
  item: { path: string; body: Record<string, unknown> },
  opts?: { retryAfterMs?: number },
  now: number = Date.now()
): void {
  if (OPERATOR_QUEUE_BLOCKED_PATHS.has(item.path)) return
  const state = loadQueueState(userDataDir)
  const next = addItem(state, { id: randomUUID(), path: item.path, body: item.body, enqueuedAt: now }, now, opts)
  saveQueueState(userDataDir, next)
}

/** Send every due item in enqueue order via `send`, update backoff/removal per outcome, persist, and
 *  report the resulting queue depth plus items dropped for cap overflow since the last report. */
export async function drainOperatorQueue(
  userDataDir: string,
  now: number,
  send: QueueSender
): Promise<QueueDrainReport> {
  let state = loadQueueState(userDataDir)
  const due = dueItems(state, now).sort((a, b) => a.enqueuedAt - b.enqueuedAt)
  for (const item of due) {
    let result: QueueSendResult
    try {
      result = await send(item.path, item.body)
    } catch {
      result = { ok: false }
    }
    state = result.ok
      ? markSucceeded(state, item.id)
      : markFailed(state, item.id, now, { retryAfterMs: result.retryAfterMs })
  }
  const consumed = consumeDropped(state)
  saveQueueState(userDataDir, consumed.state)
  return { queued: consumed.state.items.length, dropped: consumed.dropped }
}
