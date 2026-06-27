import { describe, it, expect } from 'vitest'
import { REMINDER_TTL_MS, shouldShowConsentReminder } from './consent'

describe('shouldShowConsentReminder', () => {
  it('shows when no reminder has ever been acknowledged', () => {
    expect(shouldShowConsentReminder(Date.now(), 0, false)).toBe(true)
  })

  it('shows when the last reminder is older than 24 hours', () => {
    const now = 1_700_000_000_000
    const stale = now - REMINDER_TTL_MS - 1
    expect(shouldShowConsentReminder(now, stale, false)).toBe(true)
  })

  it('does not show when the last reminder is within 24 hours', () => {
    const now = 1_700_000_000_000
    const recent = now - REMINDER_TTL_MS + 1
    expect(shouldShowConsentReminder(now, recent, false)).toBe(false)
  })

  it('always shows when enterprise requireIndicator is true', () => {
    const now = 1_700_000_000_000
    expect(shouldShowConsentReminder(now, now, true)).toBe(true)
    expect(shouldShowConsentReminder(now, 0, true)).toBe(true)
  })
})
