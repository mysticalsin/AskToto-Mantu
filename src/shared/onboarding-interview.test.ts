import { describe, expect, it } from 'vitest'
import { AssistantDraftSchema } from './assistants'
import {
  INTERVIEW_QUESTIONS,
  InterviewAnswersSchema,
  InterviewSaveRequestSchema,
  InterviewViewSchema,
  cleanRoleOther,
  draftsFromAnswers,
  type InterviewAnswers
} from './onboarding-interview'
import { meterBucketFor } from './setup-metering'

describe('onboarding interview contract (G56)', () => {
  it('draftsFromAnswers is deterministic and returns three valid G48 drafts', () => {
    const answers: InterviewAnswers = {
      role: 'sales',
      meetings: ['client', 'internal'],
      outcome: 'actions',
      tone: 'brief'
    }
    const a = draftsFromAnswers(answers)
    expect(a).toEqual(draftsFromAnswers(answers))
    expect(a).toHaveLength(3)
    for (const draft of a) {
      const { include, ...rest } = draft
      expect(include).toBe(true)
      expect(AssistantDraftSchema.safeParse(rest).success).toBe(true)
    }
    expect(a[0]!.instructions).toContain('client calls and team meetings')
    expect(draftsFromAnswers({})).toHaveLength(3)
  })

  it('caps roleOther at 80 characters and keeps it on one line', () => {
    expect(InterviewAnswersSchema.safeParse({ role: 'other', roleOther: 'x'.repeat(81) }).success).toBe(false)
    expect(cleanRoleOther(` a\nb\t${'y'.repeat(100)}`)).toHaveLength(80)
    expect(cleanRoleOther('a\nb')).toBe('a b')
    const drafts = draftsFromAnswers({ role: 'other', roleOther: 'Product design' })
    expect(drafts[0]!.instructions).toContain('Product design')
    // roleOther only applies to "Something else"
    expect(draftsFromAnswers({ role: 'sales', roleOther: 'Product design' })[0]!.instructions).not.toContain(
      'Product design'
    )
  })

  it('schemas reject unknown keys and a renderer-chosen complete status', () => {
    expect(InterviewAnswersSchema.safeParse({ role: 'sales', ownerKey: 'a' }).success).toBe(false)
    expect(
      InterviewViewSchema.safeParse({ status: 'in-progress', step: 0, answers: {}, drafts: [], createdIds: [], x: 1 })
        .success
    ).toBe(false)
    expect(InterviewSaveRequestSchema.safeParse({ status: 'complete', step: 4, answers: {}, drafts: [] }).success).toBe(
      false
    )
    expect(InterviewAnswersSchema.safeParse({ meetings: ['client', 'internal', 'workshops'] }).success).toBe(false)
  })

  it('asks four questions with short titles', () => {
    expect(INTERVIEW_QUESTIONS.map((q) => q.key)).toEqual(['role', 'meetings', 'outcome', 'tone'])
    for (const q of INTERVIEW_QUESTIONS) expect(q.title.split(' ').length).toBeLessThanOrEqual(7)
  })

  it('setup origins go to the setup bucket; everything else is work', () => {
    expect(meterBucketFor('onboarding-interview')).toBe('setup')
    expect(meterBucketFor('onboarding-replay')).toBe('setup')
    expect(meterBucketFor('ask')).toBe('work')
    expect(meterBucketFor('')).toBe('work')
  })
})
