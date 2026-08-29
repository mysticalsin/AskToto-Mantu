import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../logger', () => ({
  mainLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  auditLog: vi.fn()
}))

import { createPushQueue } from './pushQueue'
import { auditLog } from '../logger'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mcp-push-queue-'))
  vi.clearAllMocks()
})

function makeQueue(opts: { now?: () => number; maxAttempts?: number } = {}) {
  return createPushQueue({ storePath: () => join(dir, 'mcp-push-queue.json'), ...opts })
}

const baseInput = {
  kind: 'clickup',
  action: 'create_task' as const,
  toolName: 'create_task',
  payload: { title: 'Follow up with Acme' }
}

describe('enqueue', () => {
  it('the same logical action enqueued twice collapses to one entry (idempotent)', () => {
    const q = makeQueue()
    const first = q.enqueue(baseInput)
    const second = q.enqueue(baseInput)
    expect(second.id).toBe(first.id)
    expect(q.pending()).toHaveLength(1)
  })

  it('a different payload gets its own queue entry', () => {
    const q = makeQueue()
    q.enqueue(baseInput)
    q.enqueue({ ...baseInput, payload: { title: 'Different task' } })
    expect(q.pending()).toHaveLength(2)
  })

  it('persists to storePath as durable JSON, surviving a fresh queue instance', () => {
    const q = makeQueue()
    q.enqueue(baseInput)
    const reopened = makeQueue()
    expect(reopened.pending()).toHaveLength(1)
    const onDisk = JSON.parse(readFileSync(join(dir, 'mcp-push-queue.json'), 'utf8'))
    expect(onDisk.actions).toHaveLength(1)
  })

  it('audits mcp.push.queued on enqueue', () => {
    const q = makeQueue()
    q.enqueue(baseInput)
    expect(auditLog).toHaveBeenCalledWith('mcp.push.queued', expect.objectContaining({ kind: 'clickup', action: 'create_task' }))
  })

  it('normalizes payload.confidential onto the action\u2019s own top-level flag', () => {
    const q = makeQueue()
    const action = q.enqueue({ ...baseInput, payload: { title: 'x', confidential: true } })
    expect(action.confidential).toBe(true)
  })
})

describe('processDue — confidential skip', () => {
  it('never calls pushFn for a confidential action, no matter how many ticks pass', async () => {
    const q = makeQueue()
    q.enqueue({ ...baseInput, confidential: true })
    const pushFn = vi.fn(async () => ({ ok: true }))
    const r1 = await q.processDue(pushFn)
    expect(pushFn).not.toHaveBeenCalled()
    expect(r1).toEqual({ processed: 0, succeeded: 0, deadLettered: 0, skippedConfidential: 1 })
    // Still there, still skipped, on a second tick — confidential is not a one-time drop.
    const r2 = await q.processDue(pushFn)
    expect(pushFn).not.toHaveBeenCalled()
    expect(r2.skippedConfidential).toBe(1)
    expect(q.pending()).toHaveLength(1)
  })

  it('a payload-level confidential flag (no top-level flag) is also honored', async () => {
    const q = makeQueue()
    q.enqueue({ ...baseInput, payload: { title: 'x', confidential: true } })
    const pushFn = vi.fn(async () => ({ ok: true }))
    await q.processDue(pushFn)
    expect(pushFn).not.toHaveBeenCalled()
  })
})

describe('processDue — success and retry', () => {
  it('removes the action once pushFn succeeds', async () => {
    const q = makeQueue()
    q.enqueue(baseInput)
    const r = await q.processDue(async () => ({ ok: true }))
    expect(r).toEqual({ processed: 1, succeeded: 1, deadLettered: 0, skippedConfidential: 0 })
    expect(q.pending()).toHaveLength(0)
  })

  it('a failure schedules the next attempt in the future instead of retrying immediately', async () => {
    let now = 1_000_000
    const q = makeQueue({ now: () => now })
    q.enqueue(baseInput)
    await q.processDue(async () => ({ ok: false, error: 'timeout' }))
    const [action] = q.pending()
    expect(action.attempts).toBe(1)
    expect(action.lastError).toBe('timeout')
    expect(action.nextAt).toBeGreaterThan(now)

    // Not due yet — a tick right now must not call pushFn again.
    const pushFn = vi.fn(async () => ({ ok: true }))
    await q.processDue(pushFn)
    expect(pushFn).not.toHaveBeenCalled()

    // Once the clock passes nextAt, the same action is retried.
    now = action.nextAt + 1
    await q.processDue(pushFn)
    expect(pushFn).toHaveBeenCalledTimes(1)
  })

  it('dead-letters after maxAttempts consecutive failures and stops retrying', async () => {
    let now = 0
    const q = makeQueue({ now: () => now, maxAttempts: 2 })
    q.enqueue(baseInput)
    const pushFn = vi.fn(async () => ({ ok: false, error: 'boom' }))

    await q.processDue(pushFn) // attempt 1
    now = q.pending()[0].nextAt + 1
    await q.processDue(pushFn) // attempt 2 → dead-letter

    expect(pushFn).toHaveBeenCalledTimes(2)
    const [action] = q.pending()
    expect(action.deadLetter).toBe(true)
    expect(auditLog).toHaveBeenCalledWith('mcp.push.dead_letter', expect.objectContaining({ attempts: 2 }))

    // A dead-lettered action never fires again, even once its nextAt (from before dead-lettering) is due.
    now += 10_000
    const r = await q.processDue(pushFn)
    expect(pushFn).toHaveBeenCalledTimes(2)
    expect(r.processed).toBe(0)
  })

  it('a pushFn rejection is treated the same as an { ok: false } result, not an uncaught throw', async () => {
    const q = makeQueue()
    q.enqueue(baseInput)
    await expect(q.processDue(async () => { throw new Error('network down') })).resolves.toEqual({
      processed: 1,
      succeeded: 0,
      deadLettered: 0,
      skippedConfidential: 0
    })
    expect(q.pending()[0].lastError).toBe('network down')
  })
})
