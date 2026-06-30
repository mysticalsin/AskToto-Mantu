import { describe, it, expect } from 'vitest'
import { isQuestion } from './listen'

// Guards the auto-answer trigger. The live VAD endpoint is a snappy 0.6s (vad.ts), which can split a
// hesitated question across two transcription windows. isQuestion must NOT fire on the truncated first
// fragment (which would run the LLM on half a question and then get the complete one throttled out), but
// MUST fire once the coalesced 'them' turn (themRunRef in useListen joins the windows) reads as complete.
describe('isQuestion — auto-answer turn detection', () => {
  it('fires on a complete question (interrogative opener, ≥3 words)', () => {
    expect(isQuestion('What is the best way to deploy this')).toBe(true)
    expect(isQuestion('Can you explain the architecture')).toBe(true)
    expect(isQuestion('How do we handle retries')).toBe(true)
  })

  it('fires on any string with terminal "?" even when short', () => {
    expect(isQuestion('Ready?')).toBe(true)
    expect(isQuestion('You sure?')).toBe(true)
  })

  it('keeps stranded-preposition questions (they DO end real questions)', () => {
    expect(isQuestion('Where are you from')).toBe(true)
    expect(isQuestion('What are you looking at')).toBe(true)
  })

  it('does NOT fire on a fragment that dangles on a function word (cut mid-question)', () => {
    expect(isQuestion('What is the')).toBe(false) // the verifier's exact split case
    expect(isQuestion('Can you give me your')).toBe(false)
    expect(isQuestion('How do we deal with the')).toBe(false)
    expect(isQuestion('Why is this good and')).toBe(false)
  })

  it('resolves a split question once the coalesced run completes', () => {
    // themRunRef joins consecutive 'them' windows; isQuestion runs on the join.
    const fragment1 = 'What is the'
    const fragment2 = 'best way to deploy this'
    expect(isQuestion(fragment1)).toBe(false) // no premature fire on the truncated fragment
    expect(isQuestion(`${fragment1} ${fragment2}`)).toBe(true) // fires once, complete
  })

  it('does not fire on statements or non-interrogative speech', () => {
    expect(isQuestion('I think we should ship it')).toBe(false)
    expect(isQuestion('best way to deploy this')).toBe(false) // no interrogative opener
    expect(isQuestion('what is')).toBe(false) // under the 3-word floor, no "?"
    expect(isQuestion('')).toBe(false)
  })
})
