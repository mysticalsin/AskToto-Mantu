import { describe, it, expect } from 'vitest'
import {
  canMarkOnboardingDone,
  canSkipOnboarding,
  SKIPPABLE_SCENES,
  sceneAfterAppearance,
  sceneAfterInterview,
  sceneAfterLicense,
  sceneAfterPersonalize,
  sceneAfterReveal,
  sceneAfterSetup
} from './onboarding-flow'

describe('MQA-283 — Ready stays the terminal act; appearance now sits after the demo', () => {
  it('reveal continues into appearance', () => {
    expect(sceneAfterReveal()).toBe('appearance')
  })

  it('appearance continues into setup', () => {
    expect(sceneAfterAppearance()).toBe('setup')
  })

  it('setup continues into personalize', () => {
    expect(sceneAfterSetup()).toBe('personalize')
  })

  it('personalize goes to Ready when the license gate is off', () => {
    expect(sceneAfterPersonalize(false)).toBe('ready')
    expect(sceneAfterPersonalize(undefined)).toBe('ready')
    expect(sceneAfterPersonalize(null)).toBe('ready')
  })

  it('personalize goes to license only when the gate is on, never appearance', () => {
    expect(sceneAfterPersonalize(true)).toBe('license')
    expect(sceneAfterPersonalize(true)).not.toBe('appearance')
    expect(sceneAfterPersonalize(false)).not.toBe('appearance')
  })

  it('license continues into Ready', () => {
    expect(sceneAfterLicense()).toBe('ready')
  })

  it('never routes to a legacy provider/API-key step', () => {
    expect(['hero', 'problem', 'reveal', 'appearance', 'setup', 'personalize', 'license', 'ready']).toContain(
      sceneAfterPersonalize(true)
    )
    expect(sceneAfterPersonalize(true)).not.toBe('provider')
  })
})

describe('canMarkOnboardingDone — Ready is the only finish', () => {
  it('rejects every scene except completed Ready', () => {
    expect(canMarkOnboardingDone({ scene: 'ready', asrReady: true, consent: true })).toBe(true)
    expect(canMarkOnboardingDone({ scene: 'hero', asrReady: true, consent: true })).toBe(false)
    expect(canMarkOnboardingDone({ scene: 'skip', asrReady: true, consent: true })).toBe(false)
    expect(canMarkOnboardingDone({ scene: 'ready', asrReady: false, consent: true })).toBe(true)
    expect(canMarkOnboardingDone({ scene: 'ready', asrReady: true, consent: false })).toBe(false)
  })
})

describe('G56 role interview and skip (D-27)', () => {
  it('personalize continues into the interview only when it is available', () => {
    expect(sceneAfterPersonalize(false, true)).toBe('interview')
    expect(sceneAfterPersonalize(true, true)).toBe('interview')
    expect(sceneAfterPersonalize(true, false)).toBe('license')
    expect(sceneAfterPersonalize(false, false)).toBe('ready')
    expect(sceneAfterPersonalize(undefined)).toBe('ready')
  })

  it('interview continues into license when the gate is on, else Ready', () => {
    expect(sceneAfterInterview(true)).toBe('license')
    expect(sceneAfterInterview(false)).toBe('ready')
    expect(sceneAfterInterview(null)).toBe('ready')
  })

  it('skip is offered only after the permissions step, and only with consent', () => {
    for (const scene of ['hero', 'problem', 'reveal', 'appearance', 'setup', 'ready'] as const) {
      expect(canSkipOnboarding({ scene, consent: true })).toBe(false)
    }
    for (const scene of ['personalize', 'interview', 'license'] as const) {
      expect(canSkipOnboarding({ scene, consent: false })).toBe(false)
      expect(canSkipOnboarding({ scene, consent: true })).toBe(true)
    }
    expect(SKIPPABLE_SCENES).toEqual(['personalize', 'interview', 'license'])
  })

  it('the interview never marks onboarding done; only Ready does', () => {
    expect(canMarkOnboardingDone({ scene: 'interview', asrReady: true, consent: true })).toBe(false)
  })
})
