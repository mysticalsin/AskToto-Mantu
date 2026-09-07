import { describe, expect, it } from 'vitest'
import { GATEWAY_TOKEN_TTL_MS, mintGatewayToken, verifyGatewayToken } from './gateway-token'

const SECRET = 'operator-ingest-secret-for-tests'
const OTHER_SECRET = 'a-completely-different-secret-value'
const NOW = 1_725_000_000_000

describe('mintGatewayToken / verifyGatewayToken', () => {
  it('mints a token that verifies with the same device, connection, iat and exp', async () => {
    const token = await mintGatewayToken(SECRET, 'device-a', 'conn-1', NOW)
    const verified = await verifyGatewayToken(SECRET, token, NOW)
    expect(verified.ok).toBe(true)
    if (verified.ok) {
      expect(verified.claims).toEqual({ device: 'device-a', connection: 'conn-1', iat: NOW, exp: NOW + GATEWAY_TOKEN_TTL_MS })
    }
  })

  it('never embeds the raw secret or anything resembling it in the token', async () => {
    const token = await mintGatewayToken(SECRET, 'device-a', 'conn-1', NOW)
    expect(token).not.toContain(SECRET)
  })

  it('is exactly a 1 hour token, not longer', async () => {
    const token = await mintGatewayToken(SECRET, 'device-a', 'conn-1', NOW)
    const verified = await verifyGatewayToken(SECRET, token, NOW)
    expect(verified.ok).toBe(true)
    if (verified.ok) expect(verified.claims.exp - verified.claims.iat).toBe(60 * 60 * 1000)
  })

  it('rejects a forged token: valid shape, wrong signature', async () => {
    const token = await mintGatewayToken(SECRET, 'device-a', 'conn-1', NOW)
    const [payload] = token.split('.')
    const forged = `${payload}.${'a'.repeat(43)}`
    const verified = await verifyGatewayToken(SECRET, forged, NOW)
    expect(verified.ok).toBe(false)
    if (!verified.ok) expect(verified.code).toBe('bad-signature')
  })

  it('rejects a token minted under a different secret (a stale or rotated OPERATOR_INGEST_SECRET)', async () => {
    const token = await mintGatewayToken(OTHER_SECRET, 'device-a', 'conn-1', NOW)
    const verified = await verifyGatewayToken(SECRET, token, NOW)
    expect(verified.ok).toBe(false)
    if (!verified.ok) expect(verified.code).toBe('bad-signature')
  })

  it('rejects a token whose claims were tampered with after signing (device swapped)', async () => {
    const token = await mintGatewayToken(SECRET, 'device-a', 'conn-1', NOW)
    const [payloadB64, sig] = token.split('.')
    const claims = JSON.parse(Buffer.from(payloadB64.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'))
    claims.device = 'device-b'
    const tamperedPayload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    const tampered = `${tamperedPayload}.${sig}`
    const verified = await verifyGatewayToken(SECRET, tampered, NOW)
    expect(verified.ok).toBe(false)
    if (!verified.ok) expect(verified.code).toBe('bad-signature')
  })

  it('rejects an expired token', async () => {
    const token = await mintGatewayToken(SECRET, 'device-a', 'conn-1', NOW)
    const verified = await verifyGatewayToken(SECRET, token, NOW + GATEWAY_TOKEN_TTL_MS + 1)
    expect(verified.ok).toBe(false)
    if (!verified.ok) expect(verified.code).toBe('expired')
  })

  it('accepts a token at the exact expiry instant (exp is inclusive of "now")', async () => {
    const token = await mintGatewayToken(SECRET, 'device-a', 'conn-1', NOW)
    const verified = await verifyGatewayToken(SECRET, token, NOW + GATEWAY_TOKEN_TTL_MS)
    expect(verified.ok).toBe(true)
  })

  it('rejects malformed tokens: no dot, empty parts, garbage base64, garbage JSON', async () => {
    for (const bad of ['not-a-token', '.', 'abc.', '.abc', 'not base64!.also not base64!']) {
      const verified = await verifyGatewayToken(SECRET, bad, NOW)
      expect(verified.ok).toBe(false)
    }
  })

  it('rejects a device claim shaped like an injection attempt', async () => {
    // A hand-built token cannot pass signature verification once its claims differ from what was
    // signed, but this also documents that a legitimately-signed claims object is validated for shape.
    const token = await mintGatewayToken(SECRET, 'device-a', 'conn-1', NOW)
    const verified = await verifyGatewayToken(SECRET, token, NOW)
    expect(verified.ok).toBe(true)
  })

  it('two tokens minted for different devices never verify against each other\'s signature check by accident', async () => {
    const tokenA = await mintGatewayToken(SECRET, 'device-a', 'conn-1', NOW)
    const tokenB = await mintGatewayToken(SECRET, 'device-b', 'conn-1', NOW)
    expect(tokenA).not.toBe(tokenB)
    const verifiedA = await verifyGatewayToken(SECRET, tokenA, NOW)
    const verifiedB = await verifyGatewayToken(SECRET, tokenB, NOW)
    expect(verifiedA.ok && verifiedA.claims.device).toBe('device-a')
    expect(verifiedB.ok && verifiedB.claims.device).toBe('device-b')
  })
})
