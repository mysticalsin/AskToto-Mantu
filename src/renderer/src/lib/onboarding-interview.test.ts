import { describe, expect, it } from 'vitest'
import { draftsFromAnswers } from '@shared/onboarding-interview'
import {
  INITIAL_INTERVIEW_STATE,
  includedCount,
  interviewReducer,
  saveRequestOf,
  type InterviewUiState
} from './onboarding-interview'

const run = (events: Parameters<typeof interviewReducer>[1][], from: InterviewUiState = INITIAL_INTERVIEW_STATE) =>
  events.reduce(interviewReducer, from)

describe('onboarding interview reducer (G56, R005)', () => {
  it('restore resumes at the saved step with the saved answers', () => {
    const s = run([
      {
        type: 'restore',
        view: {
          status: 'in-progress',
          step: 2,
          answers: { role: 'sales', meetings: ['client'] },
          drafts: [],
          createdIds: []
        }
      }
    ])
    expect(s).toMatchObject({ step: 2, answers: { role: 'sales', meetings: ['client'] }, restored: true })
  })

  it('answering advances; the proposal step builds three drafts; back keeps answers', () => {
    const s = run([
      { type: 'answer', patch: { role: 'consulting' } },
      { type: 'answer', patch: { meetings: ['client'] } },
      { type: 'answer', patch: { outcome: 'actions' } },
      { type: 'answer', patch: { tone: 'brief' } }
    ])
    expect(s.step).toBe(4)
    expect(s.drafts).toHaveLength(3)
    const back = run([{ type: 'back' }, { type: 'back' }], s)
    expect(back.step).toBe(2)
    expect(back.answers).toEqual({ role: 'consulting', meetings: ['client'], outcome: 'actions', tone: 'brief' })
  })

  it('an excluded draft is not counted for the proposal; an edit keeps the name', () => {
    const at4: InterviewUiState = { ...INITIAL_INTERVIEW_STATE, step: 4, drafts: draftsFromAnswers({ role: 'sales' }) }
    const s = run(
      [
        { type: 'edit', index: 1, patch: { include: false } },
        { type: 'edit', index: 0, patch: { name: 'My calls' } }
      ],
      at4
    )
    expect(includedCount(s)).toBe(2)
    expect(s.drafts[0]!.name).toBe('My calls')
    expect(saveRequestOf(s)).toMatchObject({ status: 'in-progress', step: 4 })
  })

  it('confirmed completes; decline is saved as declined', () => {
    expect(run([{ type: 'confirmed', createdIds: ['a_' + '0'.repeat(32)] }]).status).toBe('complete')
    const declined = run([{ type: 'decline' }])
    expect(declined.status).toBe('declined')
    expect(saveRequestOf(declined).status).toBe('declined')
  })

  it('a completed interview on replay shows the summary, not the questions', () => {
    const s = run([
      {
        type: 'restore',
        view: {
          status: 'complete',
          step: 4,
          answers: { role: 'sales' },
          drafts: [],
          createdIds: ['a_' + '1'.repeat(32)]
        }
      }
    ])
    expect(s.status).toBe('complete')
    expect(s.createdIds).toHaveLength(1)
    const over = run([{ type: 'start-over' }], s)
    expect(over).toMatchObject({ status: 'in-progress', step: 0, answers: {} })
  })
})
