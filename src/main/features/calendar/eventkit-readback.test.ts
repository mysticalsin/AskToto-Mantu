import { describe, expect, it } from 'vitest'
import { matchesReadback } from './eventkit-readback'

const requested = { subject: 'Planning', startIso: '2026-10-25T10:00:00.000Z', endIso: '2026-10-25T10:30:00.000Z' }

describe('matchesReadback', () => {
  it('matches within 60s', () => {
    expect(
      matchesReadback(requested, {
        subject: '  Planning ',
        startIso: '2026-10-25T10:00:45.000Z',
        endIso: '2026-10-25T10:29:30.000Z'
      })
    ).toBe(true)
  })
  it('rejects shifted start', () => {
    expect(matchesReadback(requested, { ...requested, startIso: '2026-10-25T10:05:00.000Z' })).toBe(false)
  })
  it('rejects shifted end', () => {
    expect(matchesReadback(requested, { ...requested, endIso: '2026-10-25T11:30:00.000Z' })).toBe(false)
  })
  it('rejects other subject', () => {
    expect(matchesReadback(requested, { ...requested, subject: 'Other' })).toBe(false)
  })
  it('rejects cancelled', () => {
    expect(matchesReadback(requested, { ...requested, cancelled: true })).toBe(false)
  })
  it('rejects unparseable times', () => {
    expect(matchesReadback(requested, { ...requested, startIso: 'nope' })).toBe(false)
  })
})
