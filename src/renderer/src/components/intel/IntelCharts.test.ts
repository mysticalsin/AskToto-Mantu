import { describe, it, expect } from 'vitest'
import { formatWeekLabel, meetingCountLabel } from './IntelCharts'

describe('Intelligence chart labels', () => {
  it('meetingCountLabel is a count, never a percentage', () => {
    expect(meetingCountLabel(0)).toBe('0 meetings')
    expect(meetingCountLabel(1)).toBe('1 meeting')
    expect(meetingCountLabel(4)).toBe('4 meetings')
    expect(meetingCountLabel(4)).not.toMatch(/%/)
  })

  it('formatWeekLabel is a short month-day, not a fabricated metric', () => {
    const label = formatWeekLabel(new Date(2026, 2, 2).getTime())
    expect(label).toMatch(/[A-Za-z]{3}/)
    expect(label).not.toMatch(/%/)
  })
})
