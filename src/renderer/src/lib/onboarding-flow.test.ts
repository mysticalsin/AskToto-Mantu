import { describe, it, expect } from 'vitest'
import {
  canMarkOnboardingDone,
  sceneAfterAppearance,
  sceneAfterLicense,
  sceneAfterPersonalize,
  sceneAfterSetup
} from './onboarding-flow'

describe('MQA-283 — Act 6 (Ready) tail re-point: setup always lands on personalize', () => {
  it('never routes to license from setup any more (that hop moved after personalize)', () => {
    expect(sceneAfterSetup()).toBe('personalize')
  })
})

describe('MQA-283 — personalize routes to license only when the gate is actually on', () => {
  it('goes to appearance when licenseGateEnabled is off (the default)', () => {
    expect(sceneAfterPersonalize(false)).toBe('appearance')
    expect(sceneAfterPersonalize(undefined)).toBe('appearance')
    expect(sceneAfterPersonalize(null)).toBe('appearance')
  })

  it('goes to license only when the gate is explicitly on', () => {
    expect(sceneAfterPersonalize(true)).toBe('license')
  })

  it('never routes to a legacy provider/API-key step — no such scene exists in this union', () => {
    expect(['hero', 'problem', 'reveal', 'setup', 'personalize', 'license', 'appearance', 'ready']).toContain(
      sceneAfterPersonalize(true)
    )
    expect(sceneAfterPersonalize(true)).not.toBe('provider')
  })
})

describe('appearance ask sits between personalize/license and Ready', () => {
  it('license continues into appearance', () => {
    expect(sceneAfterLicense()).toBe('appearance')
  })

  it('appearance continues into ready', () => {
    expect(sceneAfterAppearance()).toBe('ready')
  })
})

describe('canMarkOnboardingDone — Ready is the only finish', () => {
  it('rejects every scene except completed Ready', () => {
    expect(canMarkOnboardingDone({ scene: 'ready', asrReady: true, consent: true })).toBe(true)
    expect(canMarkOnboardingDone({ scene: 'hero', asrReady: true, consent: true })).toBe(false)
    expect(canMarkOnboardingDone({ scene: 'skip', asrReady: true, consent: true })).toBe(false)
    expect(canMarkOnboardingDone({ scene: 'ready', asrReady: false, consent: true })).toBe(false)
    expect(canMarkOnboardingDone({ scene: 'ready', asrReady: true, consent: false })).toBe(false)
  })
})
