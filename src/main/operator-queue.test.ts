import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  addItem,
  backoffForAttempt,
  consumeDropped,
  drainOperatorQueue,
  dueItems,
  emptyQueueState,
  enqueueOperatorItem,
  loadQueueState,
  markFailed,
  markSucceeded,
  OPERATOR_QUEUE_MAX_ITEMS,
  queueFilePath,
  saveQueueState,
  type QueueState
} from './operator-queue'

describe('backoffForAttempt', () => {
  it('follows the 1/5/15 min schedule then caps at 1 h', () => {
    expect(backoffForAttempt(0)).toBe(60_000)
    expect(backoffForAttempt(1)).toBe(5 * 60_000)
    expect(backoffForAttempt(2)).toBe(15 * 60_000)
    expect(backoffForAttempt(3)).toBe(60 * 60_000)
    expect(backoffForAttempt(10)).toBe(60 * 60_000)
  })
})

describe('addItem / dueItems / markSucceeded / markFailed (pure)', () => {
  it('schedules the first attempt 1 minute out and appears due only once its time has come', () => {
    const now = 1_000_000
    let state = emptyQueueState()
    state = addItem(state, { id: 'a', path: '/v1/ingest', body: { id: 'ask-1', ts: 1 }, enqueuedAt: now }, now)
    expect(dueItems(state, now)).toHaveLength(0)
    expect(dueItems(state, now + 60_000)).toHaveLength(1)
  })

  it('a Worker retryAfterMs overrides the local backoff on both enqueue and retry', () => {
    const now = 1_000_000
    let state = emptyQueueState()
    state = addItem(state, { id: 'a', path: '/v1/ingest', body: {}, enqueuedAt: now }, now, { retryAfterMs: 2_000 })
    expect(dueItems(state, now + 1_999)).toHaveLength(0)
    expect(dueItems(state, now + 2_000)).toHaveLength(1)
    state = markFailed(state, 'a', now + 2_000, { retryAfterMs: 9_000 })
    expect(dueItems(state, now + 2_000 + 8_999)).toHaveLength(0)
    expect(dueItems(state, now + 2_000 + 9_000)).toHaveLength(1)
  })

  it('markFailed advances through the schedule as attempts accumulate', () => {
    const now = 0
    let state = emptyQueueState()
    state = addItem(state, { id: 'a', path: '/v1/ingest', body: {}, enqueuedAt: now }, now)
    state = markFailed(state, 'a', now) // attempts -> 1, backoff 5 min
    expect(state.items[0].attempts).toBe(1)
    expect(state.items[0].nextAttemptAt).toBe(5 * 60_000)
    state = markFailed(state, 'a', now) // attempts -> 2, backoff 15 min
    expect(state.items[0].nextAttemptAt).toBe(15 * 60_000)
    state = markFailed(state, 'a', now) // attempts -> 3, capped 1h
    expect(state.items[0].nextAttemptAt).toBe(60 * 60_000)
  })

  it('markSucceeded removes only the matching item', () => {
    const now = 0
    let state = emptyQueueState()
    state = addItem(state, { id: 'a', path: '/v1/ingest', body: {}, enqueuedAt: now }, now)
    state = addItem(state, { id: 'b', path: '/v1/ingest', body: {}, enqueuedAt: now }, now)
    state = markSucceeded(state, 'a')
    expect(state.items.map((i) => i.id)).toEqual(['b'])
  })

  it('caps at 500 items, dropping the oldest and counting the drop', () => {
    const now = 0
    let state: QueueState = emptyQueueState()
    for (let i = 0; i < OPERATOR_QUEUE_MAX_ITEMS; i++) {
      state = addItem(state, { id: `i${i}`, path: '/v1/ingest', body: {}, enqueuedAt: now + i }, now + i)
    }
    expect(state.items).toHaveLength(OPERATOR_QUEUE_MAX_ITEMS)
    expect(state.droppedSinceReport).toBe(0)
    state = addItem(state, { id: 'overflow', path: '/v1/ingest', body: {}, enqueuedAt: now + 999 }, now + 999)
    expect(state.items).toHaveLength(OPERATOR_QUEUE_MAX_ITEMS)
    expect(state.items[0].id).toBe('i1') // i0 was the oldest, now dropped
    expect(state.items.at(-1)?.id).toBe('overflow')
    expect(state.droppedSinceReport).toBe(1)
  })

  it('consumeDropped reports once then resets to zero', () => {
    let state: QueueState = { items: [], droppedSinceReport: 3 }
    const first = consumeDropped(state)
    expect(first.dropped).toBe(3)
    expect(first.state.droppedSinceReport).toBe(0)
    const second = consumeDropped(first.state)
    expect(second.dropped).toBe(0)
  })
})

describe('file I/O: atomic write + corrupt-file recovery (real temp dir)', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'operator-queue-test-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('loadQueueState on a missing file starts empty, with no tmp file left behind', () => {
    expect(loadQueueState(dir)).toEqual(emptyQueueState())
    expect(existsSync(`${queueFilePath(dir)}.tmp`)).toBe(false)
  })

  it('saveQueueState writes via tmp+rename, and the final file has no leftover tmp sibling', () => {
    const state: QueueState = {
      items: [{ id: 'a', path: '/v1/ingest', body: { id: 'ask-1' }, enqueuedAt: 1, attempts: 0, nextAttemptAt: 1 }],
      droppedSinceReport: 0
    }
    saveQueueState(dir, state)
    expect(existsSync(queueFilePath(dir))).toBe(true)
    expect(existsSync(`${queueFilePath(dir)}.tmp`)).toBe(false)
    expect(loadQueueState(dir)).toEqual(state)
  })

  it('a corrupt file is treated as empty, with a warning, not a throw', () => {
    writeFileSync(queueFilePath(dir), 'not json at all {{{', 'utf8')
    expect(() => loadQueueState(dir)).not.toThrow()
    expect(loadQueueState(dir)).toEqual(emptyQueueState())
  })

  it('a well-formed JSON file that fails the schema is also treated as empty', () => {
    writeFileSync(queueFilePath(dir), JSON.stringify({ items: 'not-an-array' }), 'utf8')
    expect(loadQueueState(dir)).toEqual(emptyQueueState())
  })

  it('enqueueOperatorItem persists durably across a fresh load', () => {
    enqueueOperatorItem(dir, { path: '/v1/ingest', body: { id: 'ask-9', ts: 42 } }, undefined, 1_000)
    const reloaded = loadQueueState(dir)
    expect(reloaded.items).toHaveLength(1)
    expect(reloaded.items[0].body).toEqual({ id: 'ask-9', ts: 42 })
  })

  it('never enqueues a heartbeat or /v1/use item', () => {
    enqueueOperatorItem(dir, { path: '/v1/heartbeat', body: { seatHash: 'x' } })
    enqueueOperatorItem(dir, { path: '/v1/use', body: { provider: 'anthropic' } })
    expect(loadQueueState(dir).items).toHaveLength(0)
  })

  it('drainOperatorQueue sends due items in enqueue order, removes successes, and reports queued/dropped', async () => {
    enqueueOperatorItem(dir, { path: '/v1/ingest', body: { id: 'first', ts: 1 } }, { retryAfterMs: 0 }, 0)
    enqueueOperatorItem(dir, { path: '/v1/ingest', body: { id: 'second', ts: 2 } }, { retryAfterMs: 0 }, 1)
    const sentOrder: string[] = []
    const report = await drainOperatorQueue(dir, 100, async (_path, body) => {
      sentOrder.push(String(body.id))
      return { ok: true }
    })
    expect(sentOrder).toEqual(['first', 'second'])
    expect(report).toEqual({ queued: 0, dropped: 0 })
    expect(loadQueueState(dir).items).toHaveLength(0)
  })

  it('drainOperatorQueue reschedules a failed item instead of dropping it, and reports it still queued', async () => {
    enqueueOperatorItem(dir, { path: '/v1/ingest', body: { id: 'flaky' } }, { retryAfterMs: 0 }, 0)
    const report = await drainOperatorQueue(dir, 100, async () => ({ ok: false, status: 503 }))
    expect(report.queued).toBe(1)
    const state = loadQueueState(dir)
    expect(state.items[0].attempts).toBe(1)
    expect(state.items[0].nextAttemptAt).toBe(100 + 5 * 60_000)
  })

  it('drainOperatorQueue reports drops that happened via enqueue overflow, then resets the counter', async () => {
    for (let i = 0; i <= OPERATOR_QUEUE_MAX_ITEMS; i++) {
      enqueueOperatorItem(dir, { path: '/v1/ingest', body: { id: `i${i}` } }, { retryAfterMs: 0 }, i)
    }
    const report = await drainOperatorQueue(dir, 0, async () => ({ ok: true }))
    expect(report.dropped).toBe(1)
    const again = await drainOperatorQueue(dir, 0, async () => ({ ok: true }))
    expect(again.dropped).toBe(0)
  })

  it('a thrown sender is treated as a failure, not a crash', async () => {
    enqueueOperatorItem(dir, { path: '/v1/ingest', body: { id: 'x' } }, { retryAfterMs: 0 }, 0)
    const report = await drainOperatorQueue(dir, 100, async () => {
      throw new Error('ECONNRESET')
    })
    expect(report.queued).toBe(1)
  })
})
