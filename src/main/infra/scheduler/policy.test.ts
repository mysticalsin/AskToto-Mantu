import { describe, expect, it } from 'vitest'
import {
  BOOT_QUIET_PERIOD_MS,
  MAX_INGEST_ATTEMPTS,
  admitSource,
  deferralFor,
  isDeliberateInput,
  retryStateAfterFailure,
  reviveExhausted,
  type AttemptRecord,
  type MaintenanceState,
  type WorkTrigger
} from './policy'

describe('admitSource', () => {
  const now = 1_000_000
  const sameSource = { version: '10:42', changedAtMs: 55 }

  const cases: Array<{
    name: string
    record: AttemptRecord | undefined
    source?: { version?: string; changedAtMs?: number }
    automatic: ReturnType<typeof admitSource>
    user: ReturnType<typeof admitSource>
  }> = [
    {
      name: 'no record',
      record: undefined,
      automatic: { action: 'queue' },
      user: { action: 'queue' }
    },
    {
      name: 'pending record',
      record: { attempts: 0 },
      automatic: { action: 'queue' },
      user: { action: 'queue' }
    },
    {
      name: 'backed-off same version',
      record: { sourceVersion: '10:42', attempts: 2, retryAfter: now + 60_000 },
      automatic: { action: 'hold', reason: 'backed-off' },
      user: { action: 'queue' }
    },
    {
      name: 'backed-off changed version',
      record: { sourceVersion: '9:42', attempts: 2, retryAfter: now + 60_000 },
      automatic: { action: 'queue' },
      user: { action: 'queue' }
    },
    {
      name: 'backoff elapsed',
      record: { sourceVersion: '10:42', attempts: 2, retryAfter: now - 1 },
      automatic: { action: 'queue' },
      user: { action: 'queue' }
    },
    {
      name: 'exhausted',
      record: { sourceVersion: '10:42', attempts: 6, exhausted: true, retryAfter: now - 1 },
      automatic: { action: 'hold', reason: 'exhausted' },
      user: { action: 'revive' }
    },
    {
      name: 'unreadable same ctime',
      record: { attempts: 1, unreadable: { changedAtMs: 55 } },
      automatic: { action: 'hold', reason: 'unreadable' },
      user: { action: 'queue' }
    },
    {
      name: 'unreadable ctime moved with unchanged version',
      record: { sourceVersion: '10:42', attempts: 1, unreadable: { changedAtMs: 54 } },
      automatic: { action: 'queue' },
      user: { action: 'queue' }
    },
    {
      name: 'unreadable with unknown ctime both times',
      record: { sourceVersion: '10:42', attempts: 1, unreadable: {} },
      source: { version: '10:42' },
      automatic: { action: 'hold', reason: 'unreadable' },
      user: { action: 'queue' }
    }
  ]

  it.each(cases)('$name for automatic and user triggers', ({ record, source, automatic, user }) => {
    expect(admitSource(record, source ?? sameSource, 'automatic', now)).toEqual(automatic)
    expect(admitSource(record, source ?? sameSource, 'user', now)).toEqual(user)
  })
})

describe('retryStateAfterFailure', () => {
  it('attempts 1..6 give delays 1, 2, 4, 8, 16, 30 min and exhaust at 6', () => {
    const now = 5_000
    const expectedDelays = [1, 2, 4, 8, 16, 30].map((minutes) => minutes * 60_000)
    let previous: AttemptRecord | undefined
    for (let i = 0; i < MAX_INGEST_ATTEMPTS; i++) {
      const next = retryStateAfterFailure(previous, { unreadable: false, source: { changedAtMs: 10 } }, now)
      expect(next.attempts).toBe(i + 1)
      expect(next.retryAfter).toBe(now + expectedDelays[i])
      expect(next.exhausted).toBe(i + 1 === MAX_INGEST_ATTEMPTS ? true : undefined)
      previous = next
    }
  })

  it('an unreadable failure keeps attempts and sets no retryAfter or exhausted', () => {
    expect(retryStateAfterFailure(
      { attempts: 3, retryAfter: 1, exhausted: true },
      { unreadable: true, source: { changedAtMs: 77 } },
      100
    )).toEqual({ attempts: 3, unreadable: { changedAtMs: 77 } })
  })

  it('a genuine failure after an unreadable one clears unreadable', () => {
    const next = retryStateAfterFailure({ attempts: 2, unreadable: { changedAtMs: 77 } }, { unreadable: false, source: { changedAtMs: 77 } }, 100)
    expect(next).toEqual({ attempts: 3, retryAfter: 100 + 4 * 60_000 })
    expect('unreadable' in next).toBe(false)
  })

  it('reviveExhausted keeps sourceVersion and removes only the retry budget fields', () => {
    const record: AttemptRecord & { marker?: string } = {
      sourceVersion: '10:42',
      attempts: 6,
      exhausted: true,
      retryAfter: 123,
      unreadable: { changedAtMs: 55 },
      marker: 'keep'
    }
    reviveExhausted(record)
    expect(record).toEqual({
      sourceVersion: '10:42',
      attempts: 0,
      unreadable: { changedAtMs: 55 },
      marker: 'keep'
    })
  })
})

describe('deferralFor', () => {
  const open: MaintenanceState = {
    uptimeMs: BOOT_QUIET_PERIOD_MS,
    priorExit: 'clean',
    interacted: false,
    holding: false,
    interactiveActive: false
  }

  it.each([
    ['boot_quiet_period', { ...open, uptimeMs: BOOT_QUIET_PERIOD_MS - 1 }],
    ['awaiting_first_interaction', { ...open, priorExit: 'unclean', interacted: false }],
    ['maintenance_running', { ...open, holding: true }],
    ['interactive_active', { ...open, interactiveActive: true }]
  ] as const)('returns %s', (reason, state) => {
    expect(deferralFor(state)).toBe(reason)
  })

  it('uses the documented priority order', () => {
    expect(deferralFor({
      uptimeMs: 0,
      priorExit: undefined,
      interacted: false,
      holding: true,
      interactiveActive: true
    })).toBe('boot_quiet_period')
    expect(deferralFor({
      uptimeMs: BOOT_QUIET_PERIOD_MS,
      priorExit: 'unclean',
      interacted: false,
      holding: true,
      interactiveActive: true
    })).toBe('awaiting_first_interaction')
    expect(deferralFor({
      uptimeMs: BOOT_QUIET_PERIOD_MS,
      priorExit: 'clean',
      interacted: true,
      holding: true,
      interactiveActive: true
    })).toBe('maintenance_running')
  })

  it('does not hold for an unknown prior exit', () => {
    expect(deferralFor({ ...open, priorExit: 'unknown', interacted: false })).toBeNull()
  })
})

describe('isDeliberateInput', () => {
  it.each(['mouseDown', 'rawKeyDown', 'keyDown', 'touchStart'])('counts %s as deliberate input', (type) => {
    expect(isDeliberateInput(type)).toBe(true)
  })

  it.each(['mouseMove', 'mouseWheel', 'mouseEnter', 'keyUp'])('does not count %s as deliberate input', (type) => {
    expect(isDeliberateInput(type)).toBe(false)
  })
})
