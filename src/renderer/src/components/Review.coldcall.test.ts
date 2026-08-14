import { describe, it, expect } from 'vitest'
import { coldCallHasPeopleToFollowUp } from './Review'

// Cold Calling Mode's "Book meetings" action (Review.tsx) must never be offered against an empty or
// "None." People-to-invite section — coldCallHasPeopleToFollowUp is the pure gate behind that chip.
describe('coldCallHasPeopleToFollowUp', () => {
  it('is false when the coaching notes have no People section at all', () => {
    expect(coldCallHasPeopleToFollowUp('## What to improve\nBe more direct.\n')).toBe(false)
  })

  it('is false when the section explicitly says None.', () => {
    const notes = '## Next steps\nFollow up Friday.\n\n## People to invite or send to\nNone.\n'
    expect(coldCallHasPeopleToFollowUp(notes)).toBe(false)
  })

  it('is false when the section is present but blank', () => {
    const notes = '## People to invite or send to\n\n## Next steps\nNothing yet.\n'
    expect(coldCallHasPeopleToFollowUp(notes)).toBe(false)
  })

  it('is true when the section names at least one person', () => {
    const notes =
      '## What worked\nGood rapport.\n\n' +
      '## People to invite or send to\n- Maria Chen (VP Ops, Acme): asked for pricing, send the deck and invite to a demo.\n'
    expect(coldCallHasPeopleToFollowUp(notes)).toBe(true)
  })

  it('reads the section even when it is the last one in the document (no trailing heading)', () => {
    const notes = '## Next steps\nCall back Tuesday.\n\n## People to invite or send to\n- Jon Park: book a demo.'
    expect(coldCallHasPeopleToFollowUp(notes)).toBe(true)
  })

  it('is case-insensitive on the heading', () => {
    const notes = '## people to invite or send to\n- Ana Silva: send follow-up.'
    expect(coldCallHasPeopleToFollowUp(notes)).toBe(true)
  })
})
