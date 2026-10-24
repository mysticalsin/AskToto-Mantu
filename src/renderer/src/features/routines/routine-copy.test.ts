import { describe, expect, it } from 'vitest'
import {
  COMPILE_REFUSALS,
  CONSENT_REFUSALS,
  LIST_REFUSALS,
  MUTATION_REFUSALS,
  ROUTINE_AVAILABILITY_COPY,
  ROUTINE_FAILURE_PAUSE_AT,
  type RoutineView
} from '@shared/routines'
import {
  COMPILE_REFUSAL_COPY,
  CONSENT_REFUSAL_COPY,
  LIST_REFUSAL_COPY,
  MUTATION_REFUSAL_COPY,
  availabilityLine,
  formatWhen,
  lastOutcomeCopy,
  routineStatus
} from './routine-copy'

const NOW = Date.UTC(2026, 9, 24, 12, 0)

function routineView(over: Partial<RoutineView> = {}): RoutineView {
  return {
    routineId: 'r_0123456789abcdef01234567',
    assistantId: 'a_0123456789abcdef01234567',
    title: 'Morning brief',
    purpose: 'reminder',
    consentKind: 'recurring',
    schedule: { kind: 'recurring', cadence: 'weekdays', time: '09:00', timeZone: 'America/Sao_Paulo' },
    copy: 'Every weekday 09:00',
    status: 'active',
    pauseReasons: [],
    waiting: null,
    failures: 0,
    lastErrorClass: null,
    nextDueAt: NOW + 3_600_000,
    quotaResetAt: null,
    history: [],
    availability: { runner: 'running', copy: ROUTINE_AVAILABILITY_COPY },
    ...over
  }
}

describe('routine copy (G69)', () => {
  it('availability line always present and adds Not running now when runner stopped', () => {
    expect(availabilityLine(routineView())).toBe('Runs while Métis is open')
    const stopped = routineView({ availability: { runner: 'not_running', copy: ROUTINE_AVAILABILITY_COPY } })
    expect(availabilityLine(stopped)).toBe('Runs while Métis is open · Not running now')
    expect(availabilityLine(stopped).toLowerCase()).not.toContain('always')
  })

  it('failure pause names the count and last error class', () => {
    const status = routineStatus(
      routineView({ pauseReasons: ['failure'], failures: ROUTINE_FAILURE_PAUSE_AT, lastErrorClass: 'timeout' }),
      NOW
    )
    expect(status.tone).toBe('paused')
    expect(status.primary).toBe(`Paused after ${ROUTINE_FAILURE_PAUSE_AT} failures · last error: Timed out`)
  })

  it('quota pause shows reset date and never revives copy when also user-paused', () => {
    const reset = NOW + 86_400_000
    const quota = routineStatus(routineView({ pauseReasons: ['quota'], quotaResetAt: reset }), NOW)
    expect(quota.primary).toBe(`Waiting for allowance reset ${formatWhen(reset)}`)
    expect(routineStatus(routineView({ pauseReasons: ['quota'] }), NOW).primary).toBe('Waiting for allowance reset')
    const both = routineStatus(routineView({ pauseReasons: ['user', 'quota'], quotaResetAt: reset }), NOW)
    expect(both.tone).toBe('paused')
    expect(both.primary).toBe(`Waiting for allowance reset ${formatWhen(reset)} · Paused`)
    expect(both.secondary ?? '').not.toContain('Next run')
  })

  it('waiting is neutral and never labelled failed', () => {
    const copies = (['network', 'quiet', 'owner_busy'] as const).map((reason) =>
      routineStatus(routineView({ waiting: { reason, since: NOW } }), NOW)
    )
    expect(copies.map((c) => c.primary)).toEqual(['Waiting: network', 'Waiting: quiet mode', "Waiting: you're busy"])
    for (const c of copies) {
      expect(c.tone).toBe('waiting')
      expect(`${c.primary} ${c.secondary ?? ''}`.toLowerCase()).not.toContain('fail')
    }
    expect(lastOutcomeCopy({ outcome: 'waiting', at: NOW, waitReason: 'network' }, NOW)).toBe('Waited: network')
  })

  it('coalesced outcome reads Caught up with count', () => {
    expect(lastOutcomeCopy({ outcome: 'coalesced', at: NOW, count: 4 }, NOW)).toBe('Caught up (4 missed)')
    expect(lastOutcomeCopy({ outcome: 'failed', at: NOW, errorClass: 'provider' }, NOW)).toBe(
      `Failed ${formatWhen(NOW)}: AI provider error`
    )
    expect(lastOutcomeCopy({ outcome: 'uncertain', at: NOW }, NOW)).toBe('Result unclear. Check it before resuming')
    expect(lastOutcomeCopy(undefined, NOW)).toBeNull()
  })

  it('active row shows next run and the failure count below the pause threshold', () => {
    const status = routineStatus(routineView({ failures: 1 }), NOW)
    expect(status.tone).toBe('active')
    expect(status.secondary).toBe(`Next run ${formatWhen(NOW + 3_600_000)} · 1 of ${ROUTINE_FAILURE_PAUSE_AT} failures`)
    expect(routineStatus(routineView({ status: 'completed' }), NOW)).toMatchObject({ tone: 'done', primary: 'Done' })
  })

  it('every refusal reason has copy', () => {
    const tables: Array<[readonly string[], Record<string, string>]> = [
      [LIST_REFUSALS, LIST_REFUSAL_COPY],
      [COMPILE_REFUSALS, COMPILE_REFUSAL_COPY],
      [CONSENT_REFUSALS, CONSENT_REFUSAL_COPY],
      [MUTATION_REFUSALS, MUTATION_REFUSAL_COPY]
    ]
    for (const [reasons, copy] of tables) {
      for (const reason of reasons) expect(copy[reason]?.length).toBeGreaterThan(0)
    }
    expect(LIST_REFUSAL_COPY['signed-out']).toBe('Sign in to use routines')
    expect(LIST_REFUSAL_COPY.unavailable).toBe('Routines are not available right now')
    expect(COMPILE_REFUSAL_COPY.assistant_archived).toBe('That assistant is archived')
    expect(COMPILE_REFUSAL_COPY.limit).toBe('You have reached the routine limit')
  })

  it('no em dash in any copy', () => {
    const all = [
      ...Object.values(LIST_REFUSAL_COPY),
      ...Object.values(COMPILE_REFUSAL_COPY),
      ...Object.values(CONSENT_REFUSAL_COPY),
      ...Object.values(MUTATION_REFUSAL_COPY),
      routineStatus(routineView({ pauseReasons: ['failure', 'archive', 'review', 'quota', 'user'] }), NOW).primary
    ]
    for (const text of all) expect(text).not.toContain(String.fromCharCode(0x2014))
  })
})
