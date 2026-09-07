import { describe, expect, it } from 'vitest'
import {
  buildSeatMeta,
  OPERATOR_LICENSE_STATES,
  sanitizeSeatHostname,
  sanitizeSeatLastIndexAt,
  sanitizeSeatLicenseId,
  sanitizeSeatLicenseLast4,
  sanitizeSeatLicenseState,
  sanitizeSeatSsoEmail
} from './operator-seat'

describe('sanitizeSeatHostname', () => {
  it('trims and caps a real hostname', () => {
    expect(sanitizeSeatHostname('  Tonys-MacBook-Pro.local  ')).toBe('Tonys-MacBook-Pro.local')
    expect(sanitizeSeatHostname('a'.repeat(100))).toHaveLength(64)
  })
  it('rejects non-strings and blanks', () => {
    expect(sanitizeSeatHostname(undefined)).toBeUndefined()
    expect(sanitizeSeatHostname(null)).toBeUndefined()
    expect(sanitizeSeatHostname(42)).toBeUndefined()
    expect(sanitizeSeatHostname('   ')).toBeUndefined()
  })
  it('never ships a secret-looking string', () => {
    expect(sanitizeSeatHostname('sk-ant-api03-abcdefghijklmnop')).toBeUndefined()
    expect(sanitizeSeatHostname('METIS-OP-1.abcd1234.1.2.sig')).toBeUndefined()
    expect(sanitizeSeatHostname('my-api-key-box')).toBeUndefined()
    expect(sanitizeSeatHostname('bearer-token-host')).toBeUndefined()
    // A long opaque run with no dots/spaces reads as a token, not a hostname.
    expect(sanitizeSeatHostname('aB3dE9fG2hJ4kL6mN8pQ1rS5tU7vW0xYz9')).toBeUndefined()
  })
})

describe('sanitizeSeatSsoEmail', () => {
  it('lowercases a real address', () => {
    expect(sanitizeSeatSsoEmail('Tony.Walteur@Mantu.com')).toBe('tony.walteur@mantu.com')
  })
  it('rejects malformed or oversized input', () => {
    expect(sanitizeSeatSsoEmail('not-an-email')).toBeUndefined()
    expect(sanitizeSeatSsoEmail('a@b')).toBeUndefined()
    expect(sanitizeSeatSsoEmail(undefined)).toBeUndefined()
    expect(sanitizeSeatSsoEmail(`${'a'.repeat(250)}@b.com`)).toBeUndefined()
  })
})

describe('sanitizeSeatLicenseState', () => {
  it('accepts only the closed Worker vocabulary', () => {
    for (const s of OPERATOR_LICENSE_STATES) {
      expect(sanitizeSeatLicenseState(s)).toBe(s)
      expect(sanitizeSeatLicenseState(s.toUpperCase())).toBe(s)
    }
  })
  it('rejects anything outside the vocabulary, never a guess', () => {
    expect(sanitizeSeatLicenseState('approved')).toBeUndefined()
    expect(sanitizeSeatLicenseState('active')).toBeUndefined()
    expect(sanitizeSeatLicenseState('')).toBeUndefined()
    expect(sanitizeSeatLicenseState(undefined)).toBeUndefined()
  })
})

describe('sanitizeSeatLicenseLast4', () => {
  it('takes exactly the last 4 alphanumerics', () => {
    expect(sanitizeSeatLicenseLast4('ABCD-1234')).toBe('1234')
    expect(sanitizeSeatLicenseLast4('key_wxyz')).toBe('wxyz')
  })
  it('refuses a fragment shorter than 4, never pads or guesses', () => {
    expect(sanitizeSeatLicenseLast4('ab')).toBeUndefined()
    expect(sanitizeSeatLicenseLast4('--')).toBeUndefined()
    expect(sanitizeSeatLicenseLast4(undefined)).toBeUndefined()
  })
})

describe('sanitizeSeatLicenseId', () => {
  it('accepts a 16-hex jti only', () => {
    expect(sanitizeSeatLicenseId('AB12CD34EF56AB78')).toBe('ab12cd34ef56ab78')
  })
  it('rejects anything not exactly 16 hex chars', () => {
    expect(sanitizeSeatLicenseId('short')).toBeUndefined()
    expect(sanitizeSeatLicenseId('gh12cd34ef56ab78')).toBeUndefined() // 'g','h' not hex
    expect(sanitizeSeatLicenseId('ab12cd34ef56ab789')).toBeUndefined() // 17 chars
    expect(sanitizeSeatLicenseId(undefined)).toBeUndefined()
  })
})

describe('sanitizeSeatLastIndexAt', () => {
  it('accepts a finite positive epoch ms', () => {
    expect(sanitizeSeatLastIndexAt(1_700_000_000_000)).toBe(1_700_000_000_000)
  })
  it('rejects non-finite, zero, negative, or non-number', () => {
    expect(sanitizeSeatLastIndexAt(0)).toBeUndefined()
    expect(sanitizeSeatLastIndexAt(-5)).toBeUndefined()
    expect(sanitizeSeatLastIndexAt(NaN)).toBeUndefined()
    expect(sanitizeSeatLastIndexAt(Infinity)).toBeUndefined()
    expect(sanitizeSeatLastIndexAt('1700000000000')).toBeUndefined()
  })
})

describe('buildSeatMeta', () => {
  it('always carries the v1 fields and adds only valid v2 fields', () => {
    const meta = buildSeatMeta({
      seatHash: 'hash123',
      os: 'darwin',
      appVersion: '1.8.5',
      hostname: 'Tonys-Mac.local',
      ssoEmail: 'Tony@Mantu.com',
      license: 'LICENSED',
      licenseLast4: 'wxyz',
      licenseId: 'AB12CD34EF56AB78',
      lastIndexAt: 1_700_000_000_000
    })
    expect(meta).toEqual({
      seatHash: 'hash123',
      os: 'darwin',
      appVersion: '1.8.5',
      hostname: 'Tonys-Mac.local',
      ssoEmail: 'tony@mantu.com',
      license: 'licensed',
      licenseLast4: 'wxyz',
      licenseId: 'ab12cd34ef56ab78',
      lastIndexAt: 1_700_000_000_000
    })
  })

  it('omits every optional field rather than shipping a placeholder when nothing real is known', () => {
    const meta = buildSeatMeta({ seatHash: 'hash', os: 'darwin', appVersion: '1.8.5' })
    expect(meta).toEqual({ seatHash: 'hash', os: 'darwin', appVersion: '1.8.5' })
    expect('hostname' in meta).toBe(false)
    expect('ssoEmail' in meta).toBe(false)
    expect('license' in meta).toBe(false)
    expect('licenseLast4' in meta).toBe(false)
    expect('licenseId' in meta).toBe(false)
    expect('lastIndexAt' in meta).toBe(false)
  })

  it('drops a bad candidate for one field without touching the others', () => {
    const meta = buildSeatMeta({
      seatHash: 'hash',
      os: 'darwin',
      appVersion: '1.8.5',
      hostname: 'sk-ant-secret-host',
      ssoEmail: 'tony@mantu.com',
      license: 'not-a-real-state'
    })
    expect(meta.hostname).toBeUndefined()
    expect(meta.ssoEmail).toBe('tony@mantu.com')
    expect(meta.license).toBeUndefined()
  })

  it('never leaks a secret-looking value anywhere in the built payload', () => {
    const meta = buildSeatMeta({
      seatHash: 'hash',
      os: 'darwin',
      appVersion: '1.8.5',
      hostname: 'sk-ant-api03-verylongsecretkeyvalue',
      ssoEmail: 'not valid',
      license: 'METIS-OP-1.abcd.1.2.sig'
    })
    expect(JSON.stringify(meta)).not.toMatch(/sk-ant|METIS-OP-1/)
  })
})
