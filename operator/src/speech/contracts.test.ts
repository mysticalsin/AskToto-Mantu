import { describe, expect, it } from 'vitest'
import {
  encodeSpeechTrackDescriptor,
  parseSpeechTrackDescriptor,
  parseSpeechSessionRequest,
  SpeechSessionRequestSchema
} from './contracts'

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

describe('speech track descriptor contract', () => {
  const descriptor = {
    operation: 'open-track',
    sessionId: '53f6eb5d-442e-4479-8382-07f340488e43',
    track: 'microphone',
    captureGeneration: 7,
    streamEpoch: 1,
    grantDigest: 'a'.repeat(64)
  } as const

  it('round trips one canonical signed descriptor', () => {
    const encoded = encodeSpeechTrackDescriptor(descriptor)
    expect(parseSpeechTrackDescriptor(encoded)).toEqual(descriptor)
  })

  it.each([
    { ...descriptor, operation: 'cancel-session' },
    { ...descriptor, sessionId: 'not-a-uuid' },
    { ...descriptor, track: 'other' },
    { ...descriptor, captureGeneration: Number.MAX_SAFE_INTEGER + 1 },
    { ...descriptor, streamEpoch: 0 },
    { ...descriptor, grantDigest: 'provider-token' },
    { ...descriptor, tenantId: 'client-selected' }
  ])('rejects an invalid signed descriptor: %o', (value) => {
    expect(() => encodeSpeechTrackDescriptor(value)).toThrow()
  })

  it('rejects non-canonical JSON and malformed descriptor headers', () => {
    const encoded = encodeSpeechTrackDescriptor(descriptor)
    expect(parseSpeechTrackDescriptor(` ${encoded}`)).toBeNull()
    expect(parseSpeechTrackDescriptor(`${encoded} `)).toBeNull()
    expect(parseSpeechTrackDescriptor('{"operation":"open-track","operation":"open-track"}')).toBeNull()
  })
})
