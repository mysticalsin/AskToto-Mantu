import { describe, expect, it } from 'vitest'
import { commandResultCopy, recoveredUncertainCopy } from './command-copy'

const preview = { title: 'Create a note in Notes', argument: 'Groceries', confirmLabel: 'Create' }

describe('confirmation result copy (sentence case, specific, never "Error")', () => {
  it('says nothing special on success and never blames the person for an unverified result', () => {
    expect(commandResultCopy({ ok: true }, preview)).toBe('Done.')
    expect(commandResultCopy({ ok: false, reason: 'outcome_unverified' }, preview)).toBe(
      "Métis tried to create a note in Notes (“Groceries”) but couldn't confirm it worked. Check before trying again."
    )
  })

  it('maps each denial to a short, honest sentence', () => {
    expect(commandResultCopy({ ok: false, reason: 'policy_denied' }, preview)).toBe("Métis can't do this right now.")
    expect(commandResultCopy({ ok: false, reason: 'expired' }, preview)).toBe('Timed out. Nothing was done.')
    expect(commandResultCopy({ ok: false, reason: 'proposal_missing' }, preview)).toBe('Timed out. Nothing was done.')
    expect(commandResultCopy({ ok: false, reason: 'adapter_failed' }, preview)).toBe("Couldn't create a note in Notes.")
    expect(commandResultCopy({ ok: false, reason: 'args_mismatch' }, preview)).toBe(
      'That action is no longer available. Nothing was done.'
    )
  })

  it('stays silent where another surface already spoke or the press was ignored', () => {
    expect(commandResultCopy({ ok: false, reason: 'preflight_failed' }, preview)).toBeNull()
    expect(commandResultCopy({ ok: false, reason: 'too_soon' }, preview)).toBeNull()
  })

  it('never uses the word error', () => {
    for (const reason of ['policy_denied', 'expired', 'adapter_failed', 'outcome_unverified', 'args_mismatch']) {
      expect(commandResultCopy({ ok: false, reason }, preview)?.toLowerCase()).not.toContain('error')
    }
  })
})

describe('boot recovery copy', () => {
  it('names the action, never its arguments, and promises no retry', () => {
    expect(recoveredUncertainCopy('desktop.create_note')).toBe(
      "A voice action may not have finished: Create note. Métis won't retry it."
    )
    expect(recoveredUncertainCopy('desktop.unknown_thing')).toBe(
      "A voice action may not have finished. Métis won't retry it."
    )
  })
})
