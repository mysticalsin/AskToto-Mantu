import { describe, expect, it } from 'vitest'
import { createOnboardingSkip, type OnboardingSkipDeps } from './onboarding-skip'

function deps(over: Partial<OnboardingSkipDeps> = {}): { calls: string[]; deps: OnboardingSkipDeps } {
  const calls: string[] = []
  return {
    calls,
    deps: {
      scene: 'interview',
      consent: true,
      abortMic: () => calls.push('abort-mic'),
      discardInterview: async () => {
        calls.push('discard-interview')
      },
      silenceAudio: () => calls.push('silence-audio'),
      complete: async () => {
        calls.push('save-then-exit')
      },
      ...over
    }
  }
}

describe('onboarding skip cleanup (G56, D-27)', () => {
  it('aborts the mic request, discards the half-done interview, silences audio, then saves and exits', async () => {
    const { calls, deps: d } = deps()
    await expect(createOnboardingSkip().run(d)).resolves.toBe('skipped')
    expect(calls).toEqual(['abort-mic', 'discard-interview', 'silence-audio', 'save-then-exit'])
  })

  it('refuses before the permissions step and without consent, touching nothing', async () => {
    for (const over of [{ scene: 'setup' as const }, { scene: 'hero' as const }, { consent: false }]) {
      const { calls, deps: d } = deps(over)
      await expect(createOnboardingSkip().run(d)).resolves.toBe('refused')
      expect(calls).toEqual([])
    }
  })

  it('a failed durable save reports failed and the skip can be retried', async () => {
    let fail = true
    const { calls, deps: d } = deps({
      complete: async () => {
        calls.push('save-then-exit')
        if (fail) throw new Error('not saved')
      }
    })
    const skip = createOnboardingSkip()
    await expect(skip.run(d)).resolves.toBe('failed')
    fail = false
    await expect(skip.run(d)).resolves.toBe('skipped')
    expect(calls.filter((c) => c === 'save-then-exit')).toHaveLength(2)
  })

  it('an interview discard that fails never blocks the skip', async () => {
    const { calls, deps: d } = deps({
      discardInterview: async () => {
        throw new Error('signed out')
      }
    })
    await expect(createOnboardingSkip().run(d)).resolves.toBe('skipped')
    expect(calls).toEqual(['abort-mic', 'silence-audio', 'save-then-exit'])
  })

  it('a double click runs the cleanup once', async () => {
    const { calls, deps: d } = deps()
    const skip = createOnboardingSkip()
    const [a, b] = await Promise.all([skip.run(d), skip.run(d)])
    expect([a, b].sort()).toEqual(['busy', 'skipped'])
    expect(calls.filter((c) => c === 'save-then-exit')).toHaveLength(1)
  })
})
