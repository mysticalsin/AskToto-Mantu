import { describe, expect, it } from 'vitest'
import { allowsAutomaticAsrSetup } from './product-speech-onboarding'

describe('product package onboarding speech setup', () => {
  it('keeps automatic ASR ensure in the legacy full flow only', () => {
    expect(allowsAutomaticAsrSetup('legacy', 'offered')).toBe(true)
    expect(allowsAutomaticAsrSetup('legacy', 'required')).toBe(true)
  })

  it('never starts optional model setup for lean, invalid, or unresolved package identity', () => {
    expect(allowsAutomaticAsrSetup('lean', 'offered')).toBe(false)
    expect(allowsAutomaticAsrSetup('invalid', 'offered')).toBe(false)
    expect(allowsAutomaticAsrSetup('pending', 'offered')).toBe(false)
    expect(allowsAutomaticAsrSetup('legacy', 'blocked')).toBe(false)
  })
})
