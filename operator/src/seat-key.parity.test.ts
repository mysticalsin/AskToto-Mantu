/**
 * The licence-as-credential scheme rests on one property: the desktop and the Worker must derive
 * byte-identical keys from the same licence, using different crypto stacks (node:crypto there,
 * WebCrypto here) and starting from different material -- the desktop holds the token, the Worker
 * holds only the claims it stored and rebuilds the token from them.
 *
 * If those two ever diverge, every licensed seat silently fails to authenticate, which is exactly
 * the class of failure that is hardest to attribute from either side. So it is asserted directly.
 */
import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { sha256Hex } from './crypto'
import {
  generateOperatorLicense,
  OPERATOR_SEAT_KEY_INFO,
  operatorSeatKeyFromLicense,
  parseOperatorLicense,
  rebuildOperatorLicenseToken
} from '../../src/shared/operator-license'
import { seatKeyForLicense } from './licenses/seat-key'
import { memoryStore } from './store'
import { TEST_INGEST_SECRET } from './test-fixtures'

const NOW = 1_725_000_000_000

/** Byte-for-byte what src/main/operator-hmac-sign.ts's seatKeyFromLicense computes. */
function desktopSeatKey(token: string): string {
  return createHmac('sha256', token).update(OPERATOR_SEAT_KEY_INFO, 'utf8').digest('hex')
}

async function mintInto(store: ReturnType<typeof memoryStore>, days = 30, now = NOW) {
  const minted = await generateOperatorLicense(TEST_INGEST_SECRET, { days, now })
  await store.putIssuedLicense({
    jti: minted.claims.jti,
    last4: minted.last4,
    key_hash: await sha256Hex(minted.token),
    days,
    iat: minted.claims.iat,
    exp: minted.claims.exp,
    revoked: 0,
    created_at: now,
    created_by: 'tony.walteur@gmail.com',
    group_id: null,
    tier: null,
    member: null
  })
  return minted
}

describe('seat key parity between the desktop and the Worker', () => {
  it('node:crypto and WebCrypto derive the same key from the same token', async () => {
    const minted = await generateOperatorLicense(TEST_INGEST_SECRET, { days: 30, now: NOW })
    const fromWorker = await operatorSeatKeyFromLicense(minted.token)
    expect(fromWorker).toBe(desktopSeatKey(minted.token))
    expect(fromWorker).toMatch(/^[a-f0-9]{64}$/)
  })

  it('the Worker rebuilds the exact token it handed out, from stored claims alone', async () => {
    const minted = await generateOperatorLicense(TEST_INGEST_SECRET, { days: 7, now: NOW })
    const parsed = parseOperatorLicense(minted.token)!
    const rebuilt = await rebuildOperatorLicenseToken(TEST_INGEST_SECRET, {
      jti: parsed.jti,
      iat: parsed.iat,
      exp: parsed.exp
    })
    expect(rebuilt).toBe(minted.token)
  })

  it('end to end: the key the seat signs with is the key the Worker resolves', async () => {
    const store = memoryStore()
    const minted = await mintInto(store)
    const resolved = await seatKeyForLicense(store, TEST_INGEST_SECRET, minted.claims.jti, NOW)
    expect(resolved.key).toBe(desktopSeatKey(minted.token))
  })

  it('a different licence yields a different key, so one seat cannot sign as another', async () => {
    const store = memoryStore()
    const a = await mintInto(store)
    const b = await mintInto(store)
    expect(a.token).not.toBe(b.token)
    const keyA = await seatKeyForLicense(store, TEST_INGEST_SECRET, a.claims.jti, NOW)
    const keyB = await seatKeyForLicense(store, TEST_INGEST_SECRET, b.claims.jti, NOW)
    expect(keyA.key).not.toBe(keyB.key)
  })

  it('refuses a jti it never issued, without inventing a key', async () => {
    const store = memoryStore()
    const resolved = await seatKeyForLicense(store, TEST_INGEST_SECRET, 'ffffffffffffffff', NOW)
    expect(resolved).toEqual({ key: null, reason: 'unknown' })
  })

  it('a revoked licence stops being able to sign, so revocation actually cuts the seat off', async () => {
    const store = memoryStore()
    const minted = await mintInto(store)
    await store.revokeIssuedLicense(minted.claims.jti, NOW)
    const resolved = await seatKeyForLicense(store, TEST_INGEST_SECRET, minted.claims.jti, NOW + 1000)
    expect(resolved).toEqual({ key: null, reason: 'inactive' })
  })

  it('an expired licence stops being able to sign', async () => {
    const store = memoryStore()
    const minted = await mintInto(store, 1)
    const afterExpiry = minted.claims.exp * 1000 + 1000
    const resolved = await seatKeyForLicense(store, TEST_INGEST_SECRET, minted.claims.jti, afterExpiry)
    expect(resolved).toEqual({ key: null, reason: 'inactive' })
  })

  it('refuses when the stored hash does not match the rebuild, rather than handing back a wrong key', async () => {
    const store = memoryStore()
    const minted = await mintInto(store)
    // What a row minted under a since-rotated ingest secret looks like from here.
    await store.updateIssuedLicense(minted.claims.jti, { key_hash: await sha256Hex('some other token') })
    const resolved = await seatKeyForLicense(store, TEST_INGEST_SECRET, minted.claims.jti, NOW)
    expect(resolved).toEqual({ key: null, reason: 'mismatch' })
  })

  it('refuses when the Worker has no ingest secret to rebuild with', async () => {
    const store = memoryStore()
    const minted = await mintInto(store)
    expect(await seatKeyForLicense(store, '', minted.claims.jti, NOW)).toEqual({ key: null, reason: 'unknown' })
  })
})
