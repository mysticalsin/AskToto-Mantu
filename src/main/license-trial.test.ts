import { describe, it, expect } from 'vitest'
import { TRIAL_DAYS, TRIAL_MS, isQualifyingTrialMode, shouldStartTrial, trialStatus } from './license-trial'

const DAY = 24 * 60 * 60 * 1000

describe('MQA-281 — isQualifyingTrialMode: only real suggest/summary/recap results start the clock', () => {
  it('is true for the moments Act 5\'s brief calls out ("first real suggestion/summary")', () => {
    expect(isQualifyingTrialMode('suggest')).toBe(true)
    expect(isQualifyingTrialMode('summary')).toBe(true)
    expect(isQualifyingTrialMode('recap')).toBe(true) // a saved meeting's summary under its other name
  })

  it('is false for a plain typed answer or a vision ask — not the core "it just worked" moment', () => {
    expect(isQualifyingTrialMode('answer')).toBe(false)
    expect(isQualifyingTrialMode('vision')).toBe(false)
  })

  it('is false for an unrecognized/garbage mode string, never throws', () => {
    expect(isQualifyingTrialMode('')).toBe(false)
    expect(isQualifyingTrialMode('not-a-real-mode')).toBe(false)
  })
})

describe('MQA-281 — shouldStartTrial: trial starts on FIRST qualifying use, never on install/launch', () => {
  it('starts on a qualifying mode when no trial has ever started', () => {
    expect(shouldStartTrial({ trialStartedAt: null, mode: 'suggest' })).toBe(true)
    expect(shouldStartTrial({ trialStartedAt: null, mode: 'summary' })).toBe(true)
  })

  it('does NOT start for a non-qualifying mode even with no trial yet — a plain answer/vision ask, or ' +
      'app launch itself (which never calls this at all), must never seed trialStartedAt', () => {
    expect(shouldStartTrial({ trialStartedAt: null, mode: 'answer' })).toBe(false)
    expect(shouldStartTrial({ trialStartedAt: null, mode: 'vision' })).toBe(false)
  })

  it('never restarts or extends an already-started trial, even on another qualifying use', () => {
    const startedAt = Date.now() - 5 * DAY
    expect(shouldStartTrial({ trialStartedAt: startedAt, mode: 'suggest' })).toBe(false)
    expect(shouldStartTrial({ trialStartedAt: startedAt, mode: 'summary' })).toBe(false)
  })

  it('is idempotent even for a trial that has already expired — expired means "spent", not "eligible again"', () => {
    const longAgo = Date.now() - 400 * DAY
    expect(shouldStartTrial({ trialStartedAt: longAgo, mode: 'suggest' })).toBe(false)
  })
})

describe('MQA-281 — trialStatus: pure derivation of trial state from a start timestamp + now', () => {
  it('is "none" with zero days remaining when never started', () => {
    expect(trialStatus(null)).toEqual({ state: 'none', daysRemaining: 0 })
  })

  it('is "active" with the full window right after starting', () => {
    const now = 1_000_000_000_000
    const r = trialStatus(now, now)
    expect(r.state).toBe('active')
    expect(r.daysRemaining).toBe(TRIAL_DAYS)
  })

  it('counts down days remaining as time passes, never negative', () => {
    const start = 1_000_000_000_000
    const r = trialStatus(start, start + 10 * DAY)
    expect(r.state).toBe('active')
    expect(r.daysRemaining).toBe(4) // 14 - 10
  })

  it('is "expired" exactly at and after TRIAL_MS elapsed, with zero days remaining', () => {
    const start = 1_000_000_000_000
    expect(trialStatus(start, start + TRIAL_MS)).toEqual({ state: 'expired', daysRemaining: 0 })
    expect(trialStatus(start, start + TRIAL_MS + 1)).toEqual({ state: 'expired', daysRemaining: 0 })
  })

  it('is "active" one ms before the exact expiry boundary', () => {
    const start = 1_000_000_000_000
    expect(trialStatus(start, start + TRIAL_MS - 1).state).toBe('active')
  })

  it('treats a trial-start timestamp in the FUTURE (rolled-back clock) as not-started, never extra days', () => {
    const now = 1_000_000_000_000
    expect(trialStatus(now + DAY, now)).toEqual({ state: 'none', daysRemaining: 0 })
  })

  it('treats a non-finite start timestamp as not-started (defense-in-depth against corrupt settings)', () => {
    expect(trialStatus(NaN as unknown as number)).toEqual({ state: 'none', daysRemaining: 0 })
  })
})

describe('TRIAL_MS mirrors the license server default trial length', () => {
  it('is exactly TRIAL_DAYS days in ms', () => {
    expect(TRIAL_MS).toBe(TRIAL_DAYS * DAY)
    expect(TRIAL_DAYS).toBe(14) // license-server/lib/app.mjs DEFAULT_TRIAL_DAYS
  })
})
