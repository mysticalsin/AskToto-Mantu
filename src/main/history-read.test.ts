import { describe, expect, it } from 'vitest'
import { compareMeetingRowsNewestFirst } from './history-read'

describe('History date ordering', () => {
  it('keeps the same newest-first order as the previous localeCompare comparator', () => {
    const rows = [
      { date: '2026-10-02T10:00:00.000Z' },
      { date: '' },
      { date: '2026-10-02T09:00:00.000Z' },
      { date: '2026-09-30T23:59:59.000Z' },
      { date: '2026-10-02' }
    ]
    const previous = rows.slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''))
    const next = rows.slice().sort(compareMeetingRowsNewestFirst)
    expect(next).toEqual(previous)
  })
})
