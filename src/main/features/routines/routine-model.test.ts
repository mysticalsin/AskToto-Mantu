import { describe, expect, it } from 'vitest'
import {
  applyAllowanceBack,
  newRoutineRecord,
  pushHistory,
  resumeRoutine,
  settleRun,
  type RoutineRecord
} from './routine-model'

const KEY = 'a'.repeat(64)
const TENANT = '1'.repeat(64)

function base(over: Partial<RoutineRecord> = {}): RoutineRecord {
  return {
    ...newRoutineRecord({
      routineId: `r_${'0'.repeat(24)}`,
      assistantId: 'sys-sales',
      purpose: 'reminder',
      title: 'Stand up',
      consentKind: 'recurring',
      schedule: { kind: 'recurring', cadence: 'daily', time: '09:00', timeZone: 'UTC' },
      tools: [],
      ownerKey: KEY,
      tenantKey: TENANT,
      idempotencyKey: 'c'.repeat(64),
      previewHash: 'd'.repeat(64),
      now: 1000,
      nextDueAt: 5000
    }),
    ...over
  }
}

describe('routine model (G66, R080/R081)', () => {
  it('quota reset clears only quota', () => {
    const r = base({
      pauseReasons: ['archive', 'failure', 'quota', 'review', 'user'],
      quota: { resetAt: 10, noticeShownFor: 10 }
    })
    const next = applyAllowanceBack(r)
    expect(next.pauseReasons).toEqual(['archive', 'failure', 'review', 'user'])
    expect(applyAllowanceBack(base({ pauseReasons: ['user'] })).pauseReasons).toEqual(['user'])
  })

  it('resume never clears archive while assistant archived', () => {
    const r = base({ pauseReasons: ['archive', 'user', 'quota'] })
    expect(resumeRoutine(r, { assistantArchived: true, openJournal: false })).toEqual({
      ok: false,
      reason: 'assistant_archived'
    })
    const ok = resumeRoutine(r, { assistantArchived: false, openJournal: false })
    // Once the assistant is no longer archived, resume clears user and archive; quota is never touched by resume.
    expect(ok.ok && ok.record.pauseReasons).toEqual(['quota'])
  })

  it('resume clears archive only once the assistant is no longer archived', () => {
    const r = base({ pauseReasons: ['archive'] })
    const ok = resumeRoutine(r, { assistantArchived: false, openJournal: false })
    expect(ok.ok && ok.record.pauseReasons).toEqual([])
  })

  it('resume is refused with reconciliation_required while a run is open', () => {
    const r = base({ pauseReasons: ['review', 'user'] })
    expect(resumeRoutine(r, { assistantArchived: false, openJournal: true })).toEqual({
      ok: false,
      reason: 'reconciliation_required'
    })
    const ok = resumeRoutine(r, { assistantArchived: false, openJournal: false })
    expect(ok.ok && ok.record.pauseReasons).toEqual([])
  })

  it('third consecutive failure pauses with lastErrorClass', () => {
    let r = base()
    r = settleRun(r, { outcome: 'failed', errorClass: 'provider', at: 1 })
    r = settleRun(r, { outcome: 'failed', errorClass: 'provider', at: 2 })
    expect(r.failures).toBe(2)
    expect(r.pauseReasons).toEqual([])
    r = settleRun(r, { outcome: 'failed', errorClass: 'timeout', at: 3 })
    expect(r.failures).toBe(3)
    expect(r.pauseReasons).toEqual(['failure'])
    expect(r.lastErrorClass).toBe('timeout')
  })

  it('waiting does not count as failure', () => {
    let r = base({ failures: 2 })
    r = pushHistory(r, { outcome: 'waiting', at: 5, waitReason: 'network' })
    r = pushHistory(r, { outcome: 'waiting', at: 6, waitReason: 'quiet' })
    expect(r.failures).toBe(2)
    expect(r.pauseReasons).toEqual([])
  })

  it('succeeded resets failures', () => {
    let r = base({ failures: 2, lastErrorClass: 'provider' })
    r = settleRun(r, { outcome: 'succeeded', at: 9 })
    expect(r.failures).toBe(0)
    expect(r.lastErrorClass).toBeUndefined()
  })

  it('uncertain adds review and cancelled leaves counters alone', () => {
    const u = settleRun(base({ failures: 1 }), { outcome: 'uncertain', at: 1 })
    expect(u.pauseReasons).toEqual(['review'])
    expect(u.failures).toBe(1)
    const c = settleRun(base({ failures: 1 }), { outcome: 'cancelled', at: 1 })
    expect(c.failures).toBe(1)
    expect(c.pauseReasons).toEqual([])
  })

  it('history is a ring of 20', () => {
    let r = base()
    for (let i = 0; i < 30; i += 1) r = pushHistory(r, { outcome: 'succeeded', at: i, occurrenceKey: `k${i}` })
    expect(r.history).toHaveLength(20)
    expect(r.history[0]!.at).toBe(10)
  })
})
