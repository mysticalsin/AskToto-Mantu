import { describe, it, expect } from 'vitest'
import {
  canMarkOnboardingDone,
  sceneAfterAppearance,
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
    expect(canMarkOnboardingDone({ scene: 'ready', asrReady: false, consent: true })).toBe(false)
    expect(canMarkOnboardingDone({ scene: 'ready', asrReady: true, consent: false })).toBe(false)
  })
})
