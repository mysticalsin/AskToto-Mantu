import { describe, expect, it } from 'vitest'
import { SpeechSessionRequestSchema } from './contracts'

const valid = {
  captureGeneration: 3,
  tracks: ['microphone', 'system'],
  consent: {
    accepted: true,
    captureGeneration: 3,
    tracks: ['microphone', 'system'],
    issuedAt: 1_000,
    expiresAt: 20_000
  }
}

describe('speech session request contract', () => {
  it('accepts a bounded exact-track consent attestation', () => {
    expect(SpeechSessionRequestSchema.safeParse(valid).success).toBe(true)
  })

  it.each([
    { ...valid, audio: 'meeting transcript' },
    { ...valid, tenant: 'attacker-selected' },
    { ...valid, accountId: '00000000000000000000000000000000' },
    { ...valid, privacyVerified: true },
    { ...valid, entitled: true },
    { ...valid, upstreamUrl: 'https://example.invalid' },
    { ...valid, tracks: ['microphone', 'microphone'] },
    { ...valid, consent: { ...valid.consent, tracks: ['microphone'] } },
    { ...valid, consent: { ...valid.consent, captureGeneration: 2 } },
    { ...valid, captureGeneration: 0 }
  ])('rejects unsafe or mismatched input', (request) => {
    expect(SpeechSessionRequestSchema.safeParse(request).success).toBe(false)
  })

  it('rejects expired, future, and overlong consent attestations', () => {
    expect(SpeechSessionRequestSchema.safeParse({
      ...valid,
      consent: { ...valid.consent, issuedAt: 0, expiresAt: 900 }
    }).success).toBe(false)
    expect(SpeechSessionRequestSchema.safeParse({
      ...valid,
      consent: { ...valid.consent, issuedAt: 5_000, expiresAt: 4_000 }
    }).success).toBe(false)
  })
})
