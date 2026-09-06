import { describe, expect, it } from 'vitest'
import { licenseMeta, OPERATOR_SEAT_NOT_APPROVED } from './operator-ingest'

describe('licenseMeta', () => {
  it('sends status and last4, never the raw key', () => {
    expect(licenseMeta({ licenseKey: 'ATK-TEST1234', licenseValid: true })).toEqual({
      license: 'licensed',
      licenseLast4: '1234'
    })
    expect(licenseMeta({ licenseValid: false, trialActive: true })).toEqual({ license: 'trial' })
    expect(JSON.stringify(licenseMeta({ licenseKey: 'secret-license-key-99', licenseValid: true }))).not.toContain(
      'secret-license-key-99'
    )
    expect(OPERATOR_SEAT_NOT_APPROVED).toMatch(/not approved/)
  })

  it('prefers an active Identity Operator license and sends jti, never the raw key', () => {
    const raw = 'METIS-OP-1.aabbccddeeff0011.1725000000.1727592000.secret-sig-value'
    expect(
      licenseMeta({ licenseValid: false }, { license: 'licensed', licenseLast4: 'alue', licenseId: 'aabbccddeeff0011' })
    ).toEqual({
      license: 'licensed',
      licenseLast4: 'alue',
      licenseId: 'aabbccddeeff0011'
    })
    expect(
      JSON.stringify(
        licenseMeta({ licenseKey: raw, licenseValid: false }, { license: 'licensed', licenseLast4: 'alue', licenseId: 'aabbccddeeff0011' })
      )
    ).not.toContain('secret-sig-value')
  })
})
