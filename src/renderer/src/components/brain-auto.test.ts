import { describe, it, expect } from 'vitest'
import { shouldAutoBackfill } from './brain-auto'

describe('automatic Mantu Intelligence backfill gate', () => {
  it('starts once when saved meetings are ahead of the ingested count', () => {
    expect(
      shouldAutoBackfill({ attempted: false, loading: false, running: false, savedMeetings: 3, ingestedMeetings: 1 })
    ).toBe(true)
  })

  it.each([
    { attempted: true, loading: false, running: false, savedMeetings: 3, ingestedMeetings: 1 },
    { attempted: false, loading: true, running: false, savedMeetings: 3, ingestedMeetings: 1 },
    { attempted: false, loading: false, running: true, savedMeetings: 3, ingestedMeetings: 1 },
    { attempted: false, loading: false, running: false, savedMeetings: 1, ingestedMeetings: 1 },
    { attempted: false, loading: false, running: false, savedMeetings: 0, ingestedMeetings: 0 }
  ])('does not start for an already handled, loading, running, or empty state: %#', (state) => {
    expect(shouldAutoBackfill(state)).toBe(false)
  })

  it('uses source filenames when an old indexed meeting makes totals match', () => {
    expect(
      shouldAutoBackfill({
        attempted: false,
        loading: false,
        running: false,
        savedMeetings: 2,
        ingestedMeetings: 2,
        savedMeetingFiles: ['old.md', 'new.md'],
        ingestedFiles: ['old.md']
      })
    ).toBe(true)
  })
})
