import { describe, expect, it } from 'vitest'
import { IDLE_WALKTHROUGH_VIEW, type WalkthroughView } from '@shared/walkthrough-view'
import { coachCopy, coachVisible } from './walkthrough-coach'

const view = (over: Partial<WalkthroughView>): WalkthroughView => ({ ...IDLE_WALKTHROUGH_VIEW, ...over })

describe('coachCopy (G45)', () => {
  it('draws nothing while idle', () => {
    expect(coachVisible(IDLE_WALKTHROUGH_VIEW)).toBe(false)
  })

  it('states the step, the instruction and only the controls that work now', () => {
    const copy = coachCopy(
      view({
        runId: 'r',
        phase: 'awaiting',
        step: 2,
        stepCount: 6,
        instruction: 'Open the File menu.',
        status: 'Tell Métis when you have done it.',
        canCheck: true,
        canPause: true,
        canStop: true
      })
    )
    expect(copy.heading).toBe('Step 2 of 6')
    expect(copy.instruction).toBe('Open the File menu.')
    expect(copy.controls.map((c) => [c.label, c.primary])).toEqual([
      ['I did it', true],
      ['Pause', false],
      ['Stop', false]
    ])
    expect(copy.budgetNote).toBeNull()
  })

  it('offers Resume instead of Pause when paused, and makes it primary when nothing can be checked', () => {
    const copy = coachCopy(
      view({ runId: 'r', phase: 'paused', step: 3, stepCount: 6, canResume: true, canPause: true, canStop: true })
    )
    expect(copy.tone).toBe('paused')
    expect(copy.controls.map((c) => [c.label, c.primary])).toEqual([
      ['Resume', true],
      ['Stop', false]
    ])
  })

  it('names the budget only on the last step Métis can guide', () => {
    expect(coachCopy(view({ phase: 'awaiting', step: 15, stepCount: 15 })).budgetNote).toBe(
      'This is the last step Métis can guide (15).'
    )
    expect(coachCopy(view({ phase: 'awaiting', step: 14, stepCount: 15 })).budgetNote).toBeNull()
  })

  it('an ended walkthrough drops the instruction and offers no control main did not allow', () => {
    const copy = coachCopy(view({ runId: 'r', phase: 'abandoned', status: 'Stopped. Nothing was changed.' }))
    expect(copy.heading).toBe('Walkthrough stopped')
    expect(copy.instruction).toBeNull()
    expect(copy.controls).toEqual([])
  })
})
