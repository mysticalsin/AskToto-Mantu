import { describe, expect, it } from 'vitest'
import {
  judgeIdempotent,
  judgeMemoryCorrect,
  judgeNoMarkerAtRest,
  judgePersisted,
  judgeProposeCard,
  judgeTombstone,
  MA_MARKERS,
  MEMORY_ASSISTANTS_STEPS
} from './memory-assistants.mjs'

describe('judgeProposeCard', () => {
  const base = {
    list: { ok: true },
    propose: { ok: true },
    cardMounted: true,
    confirmedViaIpc: false,
    countBefore: 0,
    countAfter: 1
  }
  it('PASS: a visible card, one click, one new assistant', () => expect(judgeProposeCard(base).outcome).toBe('PASS'))
  it('FAIL: confirmed through the IPC instead of the card', () => {
    const result = judgeProposeCard({ ...base, confirmedViaIpc: true })
    expect(result.outcome).toBe('FAIL')
    expect(result.problems.join(' ')).toMatch(/not the visible card/)
  })
  it('FAIL: the click did not create exactly one assistant', () =>
    expect(judgeProposeCard({ ...base, countAfter: 2 }).outcome).toBe('FAIL'))
  it('NOT_SUPPORTED: no card, owner-command refusal, no bridge or an unavailable list', () => {
    expect(judgeProposeCard({ ...base, cardMounted: false }).outcome).toBe('NOT_SUPPORTED')
    expect(judgeProposeCard({ ...base, propose: { ok: false, reason: 'not-owner-command' } }).reason).toMatch(
      /not-owner-command/
    )
    expect(judgeProposeCard({ ...base, list: null }).outcome).toBe('NOT_SUPPORTED')
    expect(judgeProposeCard({ ...base, list: { ok: false, reason: 'signed-out' } }).outcome).toBe('NOT_SUPPORTED')
  })
})

describe('judgeIdempotent', () => {
  it('PASS: the repeat creates nothing', () =>
    expect(judgeIdempotent({ countBefore: 0, countFirst: 1, countSecond: 1 }).outcome).toBe('PASS'))
  it('FAIL: a second assistant appeared', () =>
    expect(judgeIdempotent({ countBefore: 0, countFirst: 1, countSecond: 2 }).outcome).toBe('FAIL'))
})

describe('judgeMemoryCorrect', () => {
  const ok = {
    status: 'ok',
    count: 1,
    correctOk: true,
    revisionBefore: 1,
    revisionAfter: 2,
    textMatches: true,
    sameId: true
  }
  it('PASS: same id, higher revision, corrected text', () => expect(judgeMemoryCorrect(ok).outcome).toBe('PASS'))
  it('FAIL: refused, or the revision did not rise', () => {
    expect(judgeMemoryCorrect({ ...ok, correctOk: false }).outcome).toBe('FAIL')
    expect(judgeMemoryCorrect({ ...ok, revisionAfter: 1 }).outcome).toBe('FAIL')
  })
  it('NOT_SUPPORTED: nothing to correct, and the reason names the missing add route', () => {
    const empty = judgeMemoryCorrect({ status: 'ok', count: 0 })
    expect(empty.outcome).toBe('NOT_SUPPORTED')
    expect(empty.reason).toMatch(/no add call/)
    expect(judgeMemoryCorrect({ status: 'unavailable', count: 0 }).outcome).toBe('NOT_SUPPORTED')
  })
})

describe('judgeTombstone', () => {
  const before = { status: 'ok', count: 2, tombstones: 0 }
  it('PASS: one fewer, one more tombstone, id gone', () =>
    expect(
      judgeTombstone({ before, removeOk: true, after: { count: 1, tombstones: 1, idStillListed: false } }).outcome
    ).toBe('PASS'))
  it('FAIL: still listed, or no tombstone', () => {
    expect(
      judgeTombstone({ before, removeOk: true, after: { count: 1, tombstones: 1, idStillListed: true } }).outcome
    ).toBe('FAIL')
    expect(
      judgeTombstone({ before, removeOk: true, after: { count: 1, tombstones: 0, idStillListed: false } }).outcome
    ).toBe('FAIL')
  })
  it('NOT_SUPPORTED: nothing to delete', () =>
    expect(
      judgeTombstone({ before: { status: 'ok', count: 0, tombstones: 0 }, removeOk: false, after: {} }).outcome
    ).toBe('NOT_SUPPORTED'))
})

describe('judgePersisted', () => {
  it('PASS: exactly the assistants this profile created, and the deleted memory stayed deleted', () =>
    expect(judgePersisted({ expectedAssistants: 1, assistantsAfter: 1, deletedMemoryListed: false }).outcome).toBe(
      'PASS'
    ))
  it('FAIL: count differs (a foreign row) or a deleted memory came back', () => {
    expect(judgePersisted({ expectedAssistants: 1, assistantsAfter: 2, deletedMemoryListed: null }).outcome).toBe(
      'FAIL'
    )
    expect(judgePersisted({ expectedAssistants: null, assistantsAfter: 0, deletedMemoryListed: true }).outcome).toBe(
      'FAIL'
    )
  })
  it('NOT_SUPPORTED: nothing was created or deleted', () =>
    expect(judgePersisted({ expectedAssistants: null, assistantsAfter: 0, deletedMemoryListed: null }).outcome).toBe(
      'NOT_SUPPORTED'
    ))
})

describe('judgeNoMarkerAtRest', () => {
  const scan = (hits: number[], files = 10) => ({
    files,
    hits: Object.fromEntries(MA_MARKERS.map((m, i) => [m, hits[i] ?? 0]))
  })
  it('PASS: files scanned, no hits', () =>
    expect(judgeNoMarkerAtRest({ scan: scan([0, 0]), markersWritten: true }).outcome).toBe('PASS'))
  it('FAIL: a readable hit, or an empty scan', () => {
    expect(judgeNoMarkerAtRest({ scan: scan([1, 0]), markersWritten: true }).outcome).toBe('FAIL')
    expect(judgeNoMarkerAtRest({ scan: scan([0, 0], 0), markersWritten: true }).outcome).toBe('FAIL')
  })
  it('NOT_SUPPORTED: no marker was ever written', () =>
    expect(judgeNoMarkerAtRest({ scan: scan([0, 0]), markersWritten: false }).outcome).toBe('NOT_SUPPORTED'))
})

describe('steps', () => {
  it('quit before the at-rest scan, so nothing is read while the app still writes', () => {
    const steps = [...MEMORY_ASSISTANTS_STEPS]
    expect(steps.indexOf('final-quit')).toBeLessThan(steps.indexOf('ma-no-marker-at-rest'))
  })
})
