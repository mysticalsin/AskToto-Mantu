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
})
