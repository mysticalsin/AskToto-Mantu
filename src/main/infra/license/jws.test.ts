import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { DEFAULT_GRACE_DAYS, LICENSE_ISSUER, LICENSE_KID } from '@shared/license-types'
import { signLicenseJws, verifyLicenseJws } from './jws'

function pair(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  }
}

function claims(over: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000)
  return {
    sub: 'a'.repeat(64),
    edition: 'pro' as const,
    seats: 3,
    exp: now + 3600,
    nbf: now - 10,
    iat: now,
    features: ['overlay'],
    kid: LICENSE_KID,
    graceDays: DEFAULT_GRACE_DAYS,
    ...over
  }
}

describe('Ed25519 license JWS', () => {
  it('verifies a valid compact JWS', () => {
    const { publicKey, privateKey } = pair()
    const jws = signLicenseJws(claims(), privateKey, LICENSE_KID)
    const r = verifyLicenseJws(jws, { keys: { [LICENSE_KID]: publicKey } })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.claims.iss).toBe(LICENSE_ISSUER)
      expect(r.claims.edition).toBe('pro')
      expect(r.claims.seats).toBe(3)
      expect(r.state).toBe('licensed')
    }
  })

  it('rejects a tampered payload', () => {
    const { publicKey, privateKey } = pair()
    const jws = signLicenseJws(claims(), privateKey, LICENSE_KID)
    const [h, p, s] = jws.split('.')
    const raw = Buffer.from(p, 'base64url').toString('utf8')
    const tampered = Buffer.from(raw.replace('"pro"', '"enterprise"')).toString('base64url')
    const r = verifyLicenseJws(`${h}.${tampered}.${s}`, { keys: { [LICENSE_KID]: publicKey } })
    expect(r).toEqual({ ok: false, error: 'tampered' })
  })

  it('rejects an unknown kid', () => {
    const { publicKey, privateKey } = pair()
    const jws = signLicenseJws(claims({ kid: 'other-kid' }), privateKey, 'other-kid')
    const r = verifyLicenseJws(jws, { keys: { [LICENSE_KID]: publicKey } })
    expect(r).toEqual({ ok: false, error: 'wrong_kid' })
  })

  it('honors the 14-day grace window and rejects past grace', () => {
    const { publicKey, privateKey } = pair()
    const now = Math.floor(Date.now() / 1000)
    const jws = signLicenseJws(claims({ exp: now - 3 * 24 * 60 * 60, graceDays: 14 }), privateKey, LICENSE_KID)
    const keys = { [LICENSE_KID]: publicKey }
    const inGrace = verifyLicenseJws(jws, { keys, nowMs: now * 1000 })
    expect(inGrace.ok).toBe(true)
    if (inGrace.ok) expect(inGrace.state).toBe('grace')

    const past = verifyLicenseJws(jws, { keys, nowMs: (now + 15 * 24 * 60 * 60) * 1000 })
    expect(past).toEqual({ ok: false, error: 'expired' })
  })

  it('rejects a JWS bound to a different device hash', () => {
    const { publicKey, privateKey } = pair()
    const jws = signLicenseJws(claims({ sub: 'b'.repeat(64) }), privateKey, LICENSE_KID)
    const r = verifyLicenseJws(jws, { keys: { [LICENSE_KID]: publicKey }, expectedSub: 'a'.repeat(64) })
    expect(r).toEqual({ ok: false, error: 'wrong_device' })
  })
})
