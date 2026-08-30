import { describe, it, expect } from 'vitest'
import { sceneAfterLicense, sceneAfterPersonalize, sceneAfterSetup } from './onboarding-flow'

describe('MQA-283 — Act 6 (Ready) tail re-point: setup always lands on personalize', () => {
  it('never routes to license from setup any more (that hop moved after personalize)', () => {
    expect(sceneAfterSetup()).toBe('personalize')
  })
})

describe('MQA-283 — personalize routes to license only when the gate is actually on', () => {
  it('goes to ready when licenseGateEnabled is off (the default)', () => {
    expect(sceneAfterPersonalize(false)).toBe('ready')
    expect(sceneAfterPersonalize(undefined)).toBe('ready')
    expect(sceneAfterPersonalize(null)).toBe('ready')
  })

  it('goes to license only when the gate is explicitly on', () => {
    expect(sceneAfterPersonalize(true)).toBe('license')
  })

  it('never routes to a legacy provider/API-key step — no such scene exists in this union', () => {
    // Type-level guard: sceneAfterPersonalize's return type is OnboardingScene, which has no 'provider'
    // member. This assertion exists so a future edit that widens the union gets caught by a green test
    // reading a red diff, not just by a type error someone could work around with an `as` cast.
    expect(['hero', 'problem', 'reveal', 'setup', 'personalize', 'license', 'ready']).toContain(
      sceneAfterPersonalize(true)
    )
    expect(sceneAfterPersonalize(true)).not.toBe('provider')
  })
})

describe('MQA-283 — license always finishes into ready, never back into personalize', () => {
  it('always returns ready', () => {
    expect(sceneAfterLicense()).toBe('ready')
  })
})
