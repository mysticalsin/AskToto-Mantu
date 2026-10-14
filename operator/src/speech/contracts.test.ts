import { describe, expect, it } from 'vitest'
import { parseSpeechSessionRequest, SpeechSessionRequestSchema } from './contracts'

const valid = {
  operation: 'create-session',
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
    expect(parseSpeechSessionRequest(valid, 10_000)).toMatchObject({ ok: true })
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
    expect(
      parseSpeechSessionRequest(
        {
          ...valid,
          consent: { ...valid.consent, issuedAt: 1_000, expiresAt: 9_999 }
        },
        10_000
      )
    ).toMatchObject({ ok: false, code: 'CONSENT_EXPIRED' })
    expect(
      parseSpeechSessionRequest(
        {
          ...valid,
          consent: { ...valid.consent, issuedAt: 10_001, expiresAt: 20_000 }
        },
        10_000
      )
    ).toMatchObject({ ok: false, code: 'CONSENT_EXPIRED' })
    expect(
      parseSpeechSessionRequest(
        {
          ...valid,
          consent: { ...valid.consent, issuedAt: 1_000, expiresAt: 121_001 }
        },
        10_000
      )
    ).toMatchObject({ ok: false, code: 'CONSENT_EXPIRED' })
  })
})
