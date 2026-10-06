import { describe, it, expect, vi } from 'vitest'
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { isLeaseValidNow, rawToPublicKey, verifyLeaseToken, type LeasePayload } from './license-lease-verify'
import { devLeasePublicKeyForTests } from './license-lease-key'

// license-lease-key.ts imports ./logger, which imports 'electron' — mock it (the shared
// __mocks__/electron.ts auto-mock) so this pure-logic test never needs a real Electron runtime.
vi.mock('electron')

const DAY = 24 * 60 * 60 * 1000

// Test-only fixture — the PRIVATE half of the DEV_LEASE_PUBLIC_KEY bundled in license-lease-key.ts. Its
// only purpose is signing leases in tests to prove verifyLeaseToken accepts a genuinely-signed token
// AND rejects any tampering. It is not used by, and never imported into, any production code path.
const FIXTURE_PRIVATE_KEY_PEM = Buffer.from(
  'LS0tLS1CRUdJTiBQUklWQVRFIEtFWS0tLS0tCk1DNENBUUF3QlFZREsyVndCQ0lFSU5CMFVLNFVYU0xuNm1YSU9kaE45SWc1WW43QzFjVlpHMUpvdzJVcjYyeE0KLS0tLS1FTkQgUFJJVkFURSBLRVktLS0tLQo=',
  'base64'
).toString('utf8')

function signPayload(payload: unknown, privateKeyPem: string = FIXTURE_PRIVATE_KEY_PEM): string {
  const privateKey = createPrivateKey(privateKeyPem)
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  const signature = sign(null, Buffer.from(payloadB64, 'utf8'), privateKey)
  return `${payloadB64}.${signature.toString('base64url')}`
}

function makePayload(overrides: Partial<LeasePayload> = {}): LeasePayload {
  const now = Date.now()
  return {
    licenseKey: 'ATK-TEST1234',
    machineId: 'machine-1',
    companyName: 'Acme Corp',
    seatCap: 5,
    issuedAt: now,
    notAfter: now + 14 * DAY,
    ...overrides
  }
}

describe('MQA-282 — verifyLeaseToken (Ed25519 offline lease verification + tamper rejection)', () => {
  it('accepts a genuinely-signed lease against the matching bundled dev public key', () => {
    const payload = makePayload()
    const token = signPayload(payload)

    const result = verifyLeaseToken(token, devLeasePublicKeyForTests())

    expect(result).toEqual(payload)
  })

  it('rejects a lease signed by a DIFFERENT key pair, even with an identical payload', () => {
    const { privateKey: otherPrivate } = generateKeyPairSync('ed25519')
    const payload = makePayload()
    const token = signPayload(payload, otherPrivate.export({ type: 'pkcs8', format: 'pem' }) as string)

    expect(verifyLeaseToken(token, devLeasePublicKeyForTests())).toBeNull()
  })

  it('rejects a lease whose PAYLOAD was tampered with after signing (e.g. seatCap or notAfter edited)', () => {
    const payload = makePayload()
    const token = signPayload(payload)
    const [payloadB64, sigB64] = token.split('.')
    const tamperedPayload = Buffer.from(JSON.stringify({ ...payload, seatCap: 99999 }), 'utf8').toString(
      'base64url'
    )
    const tamperedToken = `${tamperedPayload}.${sigB64}`

    expect(verifyLeaseToken(tamperedToken, devLeasePublicKeyForTests())).toBeNull()
    // Sanity: the ORIGINAL, untampered token still verifies against the same key.
    expect(verifyLeaseToken(`${payloadB64}.${sigB64}`, devLeasePublicKeyForTests())).not.toBeNull()
  })

  it('rejects a lease whose SIGNATURE was tampered with (bit-flipped, or swapped for garbage)', () => {
    const token = signPayload(makePayload())
    const [payloadB64] = token.split('.')

    expect(verifyLeaseToken(`${payloadB64}.not-a-real-signature`, devLeasePublicKeyForTests())).toBeNull()
    expect(verifyLeaseToken(`${payloadB64}.${'A'.repeat(86)}`, devLeasePublicKeyForTests())).toBeNull()
  })

  it('never throws on structurally malformed input — always returns null', () => {
    expect(verifyLeaseToken('', devLeasePublicKeyForTests())).toBeNull()
    expect(verifyLeaseToken('no-dot-here', devLeasePublicKeyForTests())).toBeNull()
    expect(verifyLeaseToken('.sig', devLeasePublicKeyForTests())).toBeNull()
    expect(verifyLeaseToken('payload.', devLeasePublicKeyForTests())).toBeNull()
    expect(verifyLeaseToken('a.b.c', devLeasePublicKeyForTests())).toBeNull()
    // @ts-expect-error deliberately hostile input types
    expect(verifyLeaseToken(null, devLeasePublicKeyForTests())).toBeNull()
    // @ts-expect-error deliberately hostile input types
    expect(verifyLeaseToken(undefined, devLeasePublicKeyForTests())).toBeNull()
    expect(verifyLeaseToken('validlooking.token', '')).toBeNull()
  })

  it('rejects a well-signed payload that is missing required lease fields (wrong shape, right key)', () => {
    const weirdPayload = { hello: 'world' }
    const token = signPayload(weirdPayload)

    expect(verifyLeaseToken(token, devLeasePublicKeyForTests())).toBeNull()
  })

  it('rejects a signature valid for a totally different (non-JSON) payload string', () => {
    const { privateKey } = generateKeyPairSync('ed25519')
    const payloadB64 = Buffer.from('not json at all', 'utf8').toString('base64url')
    const signature = sign(null, Buffer.from(payloadB64, 'utf8'), privateKey)
    const publicKeyRaw = createPublicKeyRawFromPrivate(privateKey)

    expect(verifyLeaseToken(`${payloadB64}.${signature.toString('base64url')}`, publicKeyRaw)).toBeNull()
  })
})

describe('isLeaseValidNow', () => {
  it('is false for a null payload', () => {
    expect(isLeaseValidNow(null)).toBe(false)
  })

  it('is true strictly before notAfter, false strictly after', () => {
    const payload = makePayload({ notAfter: 1_000_000 })
    expect(isLeaseValidNow(payload, 999_999)).toBe(true)
    expect(isLeaseValidNow(payload, 1_000_000)).toBe(false)
    expect(isLeaseValidNow(payload, 1_000_001)).toBe(false)
  })

  it('is false for a non-finite notAfter (corrupt payload defense-in-depth)', () => {
    expect(isLeaseValidNow(makePayload({ notAfter: NaN }))).toBe(false)
  })
})

describe('rawToPublicKey', () => {
  it('reconstructs a usable KeyObject from the same raw form publicKeyToRaw would produce server-side', () => {
    const key = rawToPublicKey(devLeasePublicKeyForTests())
    expect(key.asymmetricKeyType).toBe('ed25519')
  })
})

function createPublicKeyRawFromPrivate(privateKey: KeyObject): string {
  return createPublicKey(privateKey).export({ format: 'jwk' }).x as string
}
