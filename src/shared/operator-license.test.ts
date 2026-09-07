import { describe, expect, it } from 'vitest'
import {
  generateOperatorLicense,
  isOperatorLicenseKey,
  OPERATOR_LICENSE_MAX,
  parseLicenseId,
  parseOperatorLicense,
  parseOperatorLicenseDays,
  verifyOperatorLicense
} from './operator-license'

const SECRET = 'operator-ingest-test-secret'

describe('operator license token', () => {
  it('generates a pasteable METIS-OP-1 token under 200 chars', async () => {
    const minted = await generateOperatorLicense(SECRET, { days: 30, now: 1_725_000_000_000, jti: 'aabbccddeeff0011' })
    expect(minted.token.length).toBeLessThanOrEqual(OPERATOR_LICENSE_MAX)
    expect(isOperatorLicenseKey(minted.token)).toBe(true)
    expect(parseOperatorLicense(minted.token)?.jti).toBe('aabbccddeeff0011')
    expect(minted.days).toBe(30)
    const ok = await verifyOperatorLicense(SECRET, minted.token, 1_725_000_000_000)
    expect(ok).toEqual({ ok: true, claims: minted.claims })
  })

  it('rejects expiry, wrong secret, and bad days', async () => {
    const minted = await generateOperatorLicense(SECRET, { days: 1, now: 1_725_000_000_000, jti: '1122334455667788' })
    expect(await verifyOperatorLicense(SECRET, minted.token, minted.claims.exp * 1000)).toEqual({
      ok: false,
      error: 'expired'
    })
    expect(await verifyOperatorLicense('other-secret', minted.token, 1_725_000_000_000)).toEqual({
      ok: false,
      error: 'invalid'
    })
    expect(parseOperatorLicenseDays(0)).toBeNull()
    expect(parseOperatorLicenseDays(366)).toBeNull()
    expect(parseLicenseId('aabbccddeeff0011')).toBe('aabbccddeeff0011')
    expect(parseLicenseId('not-a-jti')).toBeNull()
  })
})
