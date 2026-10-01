import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { DEFAULT_GRACE_DAYS, LICENSE_KID } from '@shared/license-types'
import { extractJwsFromLicenseFile, managedLicensePath, parseLicenseMetis } from './airgap'
import { signLicenseJws } from './jws'
import { LICENSE_PUBLIC_KEYS } from './public-keys'

function pair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  }
}

describe('air-gap license.metis', () => {
  it('parses compact JWS and { jws } wrappers', () => {
    const compact = 'aaa.bbb.ccc'
    expect(extractJwsFromLicenseFile(compact)).toBe(compact)
    expect(extractJwsFromLicenseFile(JSON.stringify({ jws: compact }))).toBe(compact)
    expect(extractJwsFromLicenseFile('not-a-license')).toBeNull()
  })

  it('verifies a signed license.metis and rejects tamper', () => {
    const { publicKey, privateKey } = pair()
    const now = Math.floor(Date.now() / 1000)
    const jws = signLicenseJws(
      {
        sub: 'a'.repeat(64),
        edition: 'enterprise',
        seats: 25,
        exp: now + 3600,
        features: ['overlay'],
        kid: LICENSE_KID,
        graceDays: DEFAULT_GRACE_DAYS,
        orgId: 'org_mantu'
      },
      privateKey,
      LICENSE_KID
    )
    const keys = { [LICENSE_KID]: publicKey }
    const ok = parseLicenseMetis(JSON.stringify({ jws }), { keys, expectedSub: 'a'.repeat(64) })
    expect(ok.ok).toBe(true)
    if (ok.ok) {
      expect(ok.claims.edition).toBe('enterprise')
      expect(ok.claims.orgId).toBe('org_mantu')
    }
    const [h, , s] = jws.split('.')
    const bad = `${h}.${Buffer.from('{"iss":"nope"}').toString('base64url')}.${s}`
    expect(parseLicenseMetis(bad, { keys }).ok).toBe(false)
  })

  it('documents the MDM path per OS and does not require the file', () => {
    expect(managedLicensePath('darwin')).toBe('/Library/Application Support/Métis/license.metis')
    expect(managedLicensePath('linux')).toBe('/etc/metis/license.metis')
    expect(managedLicensePath('win32')).toMatch(/Métis[/\\]license\.metis$/)
    expect(LICENSE_PUBLIC_KEYS[LICENSE_KID]).toMatch(/BEGIN PUBLIC KEY/)
  })
})
