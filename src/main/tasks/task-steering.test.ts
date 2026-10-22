import { describe, expect, it } from 'vitest'
import { TaskSteeringInbox } from './task-steering'

const steer = (steerId: string, revision: number, taskId = 't1') => ({
  steerId,
  taskId,
  revision,
  argumentsDigest: `digest-${revision}`
})

describe('TaskSteeringInbox (G32)', () => {
  it('holds a steer for its task until the safe boundary and hands it over exactly once', () => {
    const inbox = new TaskSteeringInbox()
    expect(inbox.defer(steer('s1', 2))).toEqual({ ok: true })
    expect(inbox.pendingFor('t1')?.steerId).toBe('s1')
    expect(inbox.take('t1')).toEqual(steer('s1', 2))
    expect(inbox.take('t1')).toBeUndefined()
  })

  it('refuses the same steer id again, even after it was delivered', () => {
    const inbox = new TaskSteeringInbox()
    inbox.defer(steer('s1', 2))
    expect(inbox.defer(steer('s1', 2))).toEqual({ ok: false, reason: 'duplicate_steer' })
    inbox.take('t1')
    expect(inbox.defer(steer('s1', 2))).toEqual({ ok: false, reason: 'duplicate_steer' })
  })

  it('keeps only the newest revision per task and refuses an older one', () => {
    const inbox = new TaskSteeringInbox()
    inbox.defer(steer('s1', 2))
    expect(inbox.defer(steer('s2', 3))).toEqual({ ok: true, superseded: 's1' })
    expect(inbox.defer(steer('s3', 3))).toEqual({ ok: false, reason: 'stale_steer' })
    expect(inbox.take('t1')?.steerId).toBe('s2')
  })

  it('never delivers a steer to a different task', () => {
    const inbox = new TaskSteeringInbox()
    inbox.defer(steer('s1', 2, 't1'))
    expect(inbox.take('t2')).toBeUndefined()
    expect(inbox.pendingFor('t1')?.steerId).toBe('s1')
  })

  it('drops a task’s pending steer and reports the ids dropped', () => {
    const inbox = new TaskSteeringInbox()
    inbox.defer(steer('s1', 2, 't1'))
    inbox.defer(steer('s2', 2, 't2'))
    expect(inbox.dropAll()).toEqual(['s1', 's2'])
    expect(inbox.take('t1')).toBeUndefined()
  })

  it('bounds pending tasks and remembered ids', () => {
    const inbox = new TaskSteeringInbox({ maxPendingTasks: 2, maxRememberedIds: 3 })
    expect(inbox.defer(steer('a', 2, 't1')).ok).toBe(true)
    expect(inbox.defer(steer('b', 2, 't2')).ok).toBe(true)
    expect(inbox.defer(steer('c', 2, 't3'))).toEqual({ ok: false, reason: 'steer_queue_full' })
    inbox.take('t1')
    inbox.take('t2')
    inbox.defer(steer('d', 2, 't4'))
    inbox.take('t4')
    inbox.defer(steer('e', 2, 't5'))
    // 'a' fell out of the bounded memory; a bounded set can only forget the oldest.
    expect(inbox.defer(steer('e', 2, 't5'))).toEqual({ ok: false, reason: 'duplicate_steer' })
  })

  it('rejects malformed steers', () => {
    const inbox = new TaskSteeringInbox()
    expect(inbox.defer({ ...steer('', 2) })).toEqual({ ok: false, reason: 'invalid_input' })
    expect(inbox.defer({ ...steer('s', 0) })).toEqual({ ok: false, reason: 'invalid_input' })
    expect(inbox.defer({ ...steer('s', 2), argumentsDigest: '' })).toEqual({ ok: false, reason: 'invalid_input' })
  })
})
