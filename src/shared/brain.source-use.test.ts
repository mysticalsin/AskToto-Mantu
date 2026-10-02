import { describe, expect, it } from 'vitest'
import { MeetingExtractionSchema, classifyMeetingSourceUse } from './brain'

describe('meeting source provenance', () => {
  it('defaults legacy extractions to empty/unknown', () => {
    const parsed = MeetingExtractionSchema.parse({})
    expect(parsed.source_mode).toBe('')
    expect(parsed.source_use).toBe('unknown')
  })

  it('classifies only built-in modes and never content', () => {
    expect(classifyMeetingSourceUse('interview')).toBe('employment')
    for (const mode of ['general', 'meeting', 'sales', 'negotiation', 'presentation', 'support', 'cold-call']) {
      expect(classifyMeetingSourceUse(mode)).toBe('eligible')
    }
    expect(classifyMeetingSourceUse('custom-sales')).toBe('unknown')
    expect(classifyMeetingSourceUse('Interview')).toBe('unknown')
    expect(classifyMeetingSourceUse('interview-notes-about-sales')).toBe('unknown')
  })
})
