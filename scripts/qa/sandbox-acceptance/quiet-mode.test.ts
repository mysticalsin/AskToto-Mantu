import { describe, expect, it } from 'vitest'
import { readModuleSource } from '../../../src/test-helpers/module-source'
import { stepFromJudgment } from './judgment.mjs'
import {
  judgeDirectAnswered,
  judgePolicyDefault,
  judgeReleased,
  judgeUnsolicitedHeld,
  QUIET_CHANNELS,
  QUIET_MARKERS,
  QUIET_MODE_STEPS,
  QUIET_QUESTION
} from './quiet-mode.mjs'

const policyOf = (action: string) => Object.fromEntries(QUIET_CHANNELS.map((channel) => [channel, action]))
const HELD = {
  toast: 'defer',
  sound: 'drop',
  spokenReply: 'drop',
  proactiveSuggestion: 'defer',
  autoAnswerCard: 'defer'
}

describe('quiet-mode channels', () => {
  it('match the shared contract (drift guard)', () => {
    const source = readModuleSource(__dirname, '../../../src/shared/quiet-mode-settings').text
    for (const channel of QUIET_CHANNELS) expect(source).toContain(`'${channel}'`)
    expect(QUIET_MODE_STEPS).toContain('qm-released-after-stop')
  })

  it('the typed question carries the report marker, so a leak is detectable', () => {
    expect(QUIET_QUESTION.toLowerCase()).toContain(QUIET_MARKERS[0])
  })
})

describe('judgePolicyDefault', () => {
  it('PASS: a valid all-allow policy', () => expect(judgePolicyDefault(policyOf('allow')).outcome).toBe('PASS'))
  it('FAIL: a malformed policy', () => {
    const bad = { ...policyOf('allow'), toast: 'maybe' }
    expect(judgePolicyDefault(bad)).toMatchObject({ outcome: 'FAIL' })
    expect(judgePolicyDefault({ toast: 'allow' }).outcome).toBe('FAIL')
  })
  it('NOT_SUPPORTED: no bridge, or a host that is already quiet', () => {
    expect(judgePolicyDefault(null).outcome).toBe('NOT_SUPPORTED')
    expect(judgePolicyDefault(policyOf('defer')).outcome).toBe('NOT_SUPPORTED')
  })
})

describe('judgeUnsolicitedHeld', () => {
  it('PASS: every channel held and every offer answered as the policy says', () =>
    expect(judgeUnsolicitedHeld({ policy: HELD, offers: HELD }).outcome).toBe('PASS'))
  it('FAIL: an offer was allowed while the meeting was live', () => {
    const result = judgeUnsolicitedHeld({ policy: HELD, offers: { ...HELD, proactiveSuggestion: 'allow' } })
    expect(result.outcome).toBe('FAIL')
    expect(result.problems.join(' ')).toMatch(/proactiveSuggestion offer was allowed/)
  })
  it('FAIL: the policy still allows a channel, or an offer disagrees with it', () => {
    expect(judgeUnsolicitedHeld({ policy: { ...HELD, toast: 'allow' }, offers: HELD }).outcome).toBe('FAIL')
    expect(judgeUnsolicitedHeld({ policy: HELD, offers: { ...HELD, toast: 'drop' } }).outcome).toBe('FAIL')
  })
  it('NOT_SUPPORTED: no bridge', () =>
    expect(judgeUnsolicitedHeld({ policy: null, offers: null }).outcome).toBe('NOT_SUPPORTED'))
})

describe('judgeDirectAnswered', () => {
  const ok = { mockAvailable: true, askBoxFound: true, answerShown: true, mockRequests: 1 }
  it('PASS: answered with exactly one mock request', () => expect(judgeDirectAnswered(ok).outcome).toBe('PASS'))
  it('FAIL: not answered, or not exactly one request', () => {
    expect(judgeDirectAnswered({ ...ok, answerShown: false }).outcome).toBe('FAIL')
    expect(judgeDirectAnswered({ ...ok, mockRequests: 0 }).outcome).toBe('FAIL')
    expect(judgeDirectAnswered({ ...ok, mockRequests: 2 }).problems.join(' ')).toMatch(/exactly 1/)
  })
  it('NOT_SUPPORTED: no mock, or no ask box', () => {
    expect(judgeDirectAnswered({ ...ok, mockAvailable: false }).outcome).toBe('NOT_SUPPORTED')
    expect(judgeDirectAnswered({ ...ok, askBoxFound: false }).outcome).toBe('NOT_SUPPORTED')
  })
})

describe('judgeReleased', () => {
  const batch = { channels: ['toast', 'proactiveSuggestion', 'autoAnswerCard'], startedAtMs: 1, releasedAtMs: 2 }
  const deferred = ['toast', 'proactiveSuggestion', 'autoAnswerCard']
  it('PASS: one batch naming every deferred channel', () =>
    expect(judgeReleased({ deferredChannels: deferred, events: [batch], policyAfter: policyOf('allow') }).outcome).toBe(
      'PASS'
    ))
  it('FAIL: a deferred channel is missing from the release, or the batch was split', () => {
    expect(
      judgeReleased({
        deferredChannels: deferred,
        events: [{ ...batch, channels: ['toast'] }],
        policyAfter: policyOf('allow')
      }).outcome
    ).toBe('FAIL')
    expect(
      judgeReleased({ deferredChannels: deferred, events: [batch, batch], policyAfter: policyOf('allow') }).outcome
    ).toBe('FAIL')
  })
  it('FAIL: the quiet ended but nothing was released', () =>
    expect(judgeReleased({ deferredChannels: deferred, events: [], policyAfter: policyOf('allow') }).outcome).toBe(
      'FAIL'
    ))
  it('NOT_SUPPORTED: still quiet after Stop', () =>
    expect(judgeReleased({ deferredChannels: deferred, events: [], policyAfter: HELD }).outcome).toBe('NOT_SUPPORTED'))
  it('FAIL: nothing was deferred, so there is nothing to release', () =>
    expect(judgeReleased({ deferredChannels: [], events: [batch], policyAfter: policyOf('allow') }).outcome).toBe(
      'FAIL'
    ))
})

describe('stepFromJudgment', () => {
  it('throws on FAIL, returns the reason on NOT_SUPPORTED and the evidence on PASS', () => {
    expect(() => stepFromJudgment({ outcome: 'FAIL', problems: ['x'] }, { n: 1 })).toThrow(/x \(observed/)
    expect(stepFromJudgment({ outcome: 'NOT_SUPPORTED', reason: 'why', problems: [] }, { n: 1 })).toEqual({
      status: 'NOT_SUPPORTED',
      reason: 'why',
      evidence: { n: 1 }
    })
    expect(stepFromJudgment({ outcome: 'PASS', problems: [] }, { n: 1 })).toEqual({ evidence: { n: 1 } })
  })
})
