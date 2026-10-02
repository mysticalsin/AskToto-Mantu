import { describe, expect, it } from 'vitest'
import { generateOperatorLicense } from '@shared/operator-license'
import { activateOperatorLicenseToken } from './operator-license-activate'

const SECRET = 'test-operator-secret'

describe('activateOperatorLicenseToken', () => {
  it('parses a well-formed, not-yet-expired token', async () => {
    const now = Date.now()
    const { token, claims, last4 } = await generateOperatorLicense(SECRET, { days: 30, now })
    const result = activateOperatorLicenseToken(token, now)
    expect(result).toEqual({ ok: true, jti: claims.jti, last4, expiresAt: claims.exp * 1000 })
  })

  it('trims surrounding whitespace from a pasted token', async () => {
    const now = Date.now()
    const { token, claims } = await generateOperatorLicense(SECRET, { days: 7, now })
    const result = activateOperatorLicenseToken(`  ${token}\n`, now)
    expect(result.ok).toBe(true)
    expect(result.jti).toBe(claims.jti)
  })

  it('refuses an empty string', () => {
    expect(activateOperatorLicenseToken('')).toEqual({ ok: false, error: 'Enter an Operator license.' })
    expect(activateOperatorLicenseToken('   ')).toEqual({ ok: false, error: 'Enter an Operator license.' })
  })

  it('refuses a non-string payload', () => {
    expect(activateOperatorLicenseToken(undefined).ok).toBe(false)
    expect(activateOperatorLicenseToken({ licenseKey: 'x' }).ok).toBe(false)
  })

  it('fails closed on a malformed token (wrong prefix, wrong part count, bad jti/sig shape)', () => {
    expect(activateOperatorLicenseToken('NOT-AN-OPERATOR-LICENSE').ok).toBe(false)
    expect(activateOperatorLicenseToken('METIS-OP-1.badjti.100.200.sig').ok).toBe(false)
  })

  it('refuses an already-expired token without needing the signing secret', async () => {
    const now = Date.now()
    const { token } = await generateOperatorLicense(SECRET, { days: 1, now: now - 2 * 24 * 60 * 60 * 1000 })
    const result = activateOperatorLicenseToken(token, now)
    expect(result).toEqual({ ok: false, error: 'This Operator license has expired.' })
  })

  it('does not require a signature check to reject an expired token (no secret passed at all)', async () => {
    // Regression guard: activation must work offline / before OPERATOR_INGEST_SECRET is even known to
    // this device — it only ever reads the plaintext exp claim, never verifies the signature.
    const now = Date.now()
    const { token } = await generateOperatorLicense(SECRET, { days: 1, now: now - 2 * 24 * 60 * 60 * 1000 })
    expect(() => activateOperatorLicenseToken(token, now)).not.toThrow()
  })
})
