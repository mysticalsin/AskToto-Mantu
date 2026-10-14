import { describe, expect, it } from 'vitest'
import { METIS_PACKAGE_PROFILE } from '@shared/package-profile'
import { ensureWhisperWorkerProfile } from './whisper-profile-admission'

describe('Whisper worker package admission', () => {
  it('refuses lean profiles rather than falling back to optional local inference', () => {
    expect(() => ensureWhisperWorkerProfile('lean')).toThrow(
      'The optional Whisper runtime is not configured for this package.'
    )
  })

  it('allows the full profile to keep its existing worker path', () => {
    expect(() => ensureWhisperWorkerProfile('full')).not.toThrow()
  })

  it('uses the compiled package profile when called by Listen without an override', () => {
    if (METIS_PACKAGE_PROFILE === 'lean') {
      expect(() => ensureWhisperWorkerProfile()).toThrow(
        'The optional Whisper runtime is not configured for this package.'
      )
    } else {
      expect(() => ensureWhisperWorkerProfile()).not.toThrow()
    }
  })
})
