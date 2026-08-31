import { describe, expect, it } from 'vitest'
import { CONVERSATION_MODES } from './ipc'
import { MODE_RECAP_LAYOUTS, recapLayoutFor, recapLayoutHeadings, splitRecapSections } from './mode-recap'

describe('MODE_RECAP_LAYOUTS', () => {
  it('ships a layout for every built-in mode', () => {
    expect(Object.keys(MODE_RECAP_LAYOUTS).sort()).toEqual([...CONVERSATION_MODES].sort())
  })

  it('sales vs recruiting vs meeting have different heading sets', () => {
    const sales = recapLayoutHeadings('sales')
    const recruiting = recapLayoutHeadings('recruiting')
    const meeting = recapLayoutHeadings('meeting')
    expect(sales).toContain('## What the seller must know:')
    expect(sales).toContain('## Next steps:')
    expect(recruiting).toContain('## Ratings:')
    expect(meeting).toContain('## Decisions:')
    expect(sales.join()).not.toBe(recruiting.join())
    expect(sales.join()).not.toBe(meeting.join())
    expect(recruiting.join()).not.toBe(meeting.join())
  })

  it('unknown modes fall back to general, not sales', () => {
    expect(recapLayoutFor('custom-foo')).toBe(MODE_RECAP_LAYOUTS.general)
  })
})

describe('splitRecapSections', () => {
  it('splits sales markdown into seller-focused cards', () => {
    const parts = splitRecapSections('## What the seller must know:\nHold the 15th.\n\n## Next steps:\n- Write today')
    expect(parts.map((p) => p.heading)).toEqual(['What the seller must know', 'Next steps'])
    expect(parts[0].body).toMatch(/15th/)
  })
})
