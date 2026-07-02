import { describe, it, expect } from 'vitest'
import type { TranscriptLine } from './ipc'
import { detectNoDecisionEnding, hasOwnedNextStep } from './wrapup'

const START = new Date('2026-07-02T10:00:00Z').getTime()
const MIN = 60_000
const line = (speaker: 'you' | 'them', text: string, t = START): TranscriptLine => ({ speaker, text, t })

/** A meandering 20-minute meeting body with no commitments — the honk's target shape. */
const aimlessBody = (): TranscriptLine[] => [
  line('them', 'So overall the platform direction feels right to us.'),
  line('you', 'Glad to hear it, the team put a lot into the discovery phase.'),
  line('them', 'The integration questions are still open on our side.'),
  line('you', 'Understood, those depend on the architecture review.'),
  line('them', 'Budget cycles are also a bit uncertain this quarter.'),
  line('you', 'That makes sense given the reorg you mentioned.'),
  line('them', 'The security team had thoughts as well.'),
  line('you', 'Happy to walk through the compliance documentation.'),
  line('them', 'And the timeline is something we keep debating internally.'),
  line('you', 'There is some flexibility on our side there.')
]

describe('detectNoDecisionEnding', () => {
  it('honks when the meeting is wrapping with no owned next step', () => {
    const lines = [...aimlessBody(), line('them', "Alright, thanks everyone — let's wrap up here.")]
    const v = detectNoDecisionEnding(lines, START, START + 20 * MIN)
    expect(v.honk).toBe(true)
    expect(v.cue).toContain('wrap')
  })

  it('stays silent when someone owned a concrete next step', () => {
    const lines = [
      ...aimlessBody(),
      line('you', "I'll send over the compliance documentation by Friday."),
      line('them', 'Perfect. Thanks everyone, great talking to you.')
    ]
    expect(detectNoDecisionEnding(lines, START, START + 20 * MIN).honk).toBe(false)
  })

  it('a hard calendar gate anywhere in the meeting disarms the honk', () => {
    const lines = [
      line('them', "Let's schedule a call for the architecture review."),
      ...aimlessBody(),
      line('them', 'Have a great weekend, bye!')
    ]
    expect(detectNoDecisionEnding(lines, START, START + 30 * MIN).honk).toBe(false)
  })

  it('never honks on short meetings, even aimless ones that end explicitly', () => {
    const lines = [...aimlessBody(), line('them', "Gotta run — let's wrap up.")]
    expect(detectNoDecisionEnding(lines, START, START + 5 * MIN).honk).toBe(false)
  })

  it('an ending phrase early in the meeting does not count — only the recent window', () => {
    const lines = [
      line('them', 'Sorry, almost said goodbye there, wrong window!'),
      ...aimlessBody(),
      ...aimlessBody() // push the early line far outside the recent window
    ]
    expect(detectNoDecisionEnding(lines, START, START + 20 * MIN).honk).toBe(false)
  })

  it('no honk without any ending cue, however long and aimless', () => {
    const lines = [...aimlessBody(), ...aimlessBody()]
    expect(detectNoDecisionEnding(lines, START, START + 45 * MIN).honk).toBe(false)
  })

  it('barely-started transcripts never honk', () => {
    const lines = [line('them', 'thanks everyone, bye')]
    expect(detectNoDecisionEnding(lines, START, START + 15 * MIN).honk).toBe(false)
  })
})

describe('hasOwnedNextStep', () => {
  it.each([
    "I'll send the deck tomorrow morning",
    'let me set up a follow-up with the CFO',
    "you'll have the numbers by end of week",
    'next step is: legal review on both sides',
    "we agreed on the phased rollout",
    "let's book a workshop with the data team"
  ])('recognizes ownership: %s', (text) => {
    expect(hasOwnedNextStep([line('you', text)])).toBe(true)
  })

  it.each([
    'we should probably think about next steps at some point',
    'someone ought to look into that',
    'it would be good to reconnect eventually'
  ])('rejects vague intent: %s', (text) => {
    expect(hasOwnedNextStep([line('them', text)])).toBe(false)
  })
})
