/**
 * Compact Ed25519 JWS (alg: EdDSA) for Métis offline-first licenses.
 * Verify only in the main process. Sign is exported for tests and the future
 * license-server minting path — the production renderer never imports this file.
 */
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import {
  DEFAULT_GRACE_DAYS,
  LICENSE_ISSUER,
  LicenseClaimsSchema,
  type LicenseClaims,
  type LicenseState
} from '@shared/license-types'
import { LICENSE_PUBLIC_KEYS } from './public-keys'

export type VerifyFail =
  | 'tampered'
  | 'wrong_kid'
  | 'wrong_device'
  | 'expired'
  | 'invalid'

export type VerifyResult =
  | { ok: true; claims: LicenseClaims; state: LicenseState }
  | { ok: false; error: VerifyFail }

function b64urlEncode(buf: Buffer | string): string {
  const b = typeof buf === 'string' ? Buffer.from(buf, 'utf8') : buf
  return b.toString('base64url')
}

function b64urlDecode(s: string): Buffer {
  return Buffer.from(s, 'base64url')
}

export function signLicenseJws(
  claims: Omit<LicenseClaims, 'iss'> & { iss?: string },
  privateKeyPem: string,
  kid: string
): string {
  const header = { alg: 'EdDSA', typ: 'JWT', kid }
  const payload = { iss: LICENSE_ISSUER, ...claims, kid }
  const signingInput = `${b64urlEncode(JSON.stringify(header))}.${b64urlEncode(JSON.stringify(payload))}`
  const key = createPrivateKey(privateKeyPem)
  const sig = sign(null, Buffer.from(signingInput, 'utf8'), key)
  return `${signingInput}.${b64urlEncode(sig)}`
}

export function verifyLicenseJws(
  jws: string,
  opts: {
    keys?: Record<string, string>
    nowMs?: number
    expectedSub?: string
  } = {}
): VerifyResult {
  const keys = opts.keys ?? LICENSE_PUBLIC_KEYS
  const nowMs = opts.nowMs ?? Date.now()
  const parts = jws.trim().split('.')
  if (parts.length !== 3 || parts.some((p) => !p)) return { ok: false, error: 'invalid' }

  const [hB64, pB64, sB64] = parts
  let header: { alg?: string; kid?: string }
  try {
    header = JSON.parse(b64urlDecode(hB64).toString('utf8')) as { alg?: string; kid?: string }
  } catch {
    return { ok: false, error: 'invalid' }
  }
  if (header.alg !== 'EdDSA') return { ok: false, error: 'invalid' }
  const kid = header.kid
  if (!kid || !keys[kid]) return { ok: false, error: 'wrong_kid' }

  let pub: ReturnType<typeof createPublicKey>
  try {
    pub = createPublicKey(keys[kid])
  } catch {
    return { ok: false, error: 'wrong_kid' }
  }

  let sig: Buffer
  try {
    sig = b64urlDecode(sB64)
  } catch {
    return { ok: false, error: 'invalid' }
  }
  const signingInput = `${hB64}.${pB64}`
  let intact = false
  try {
    intact = verify(null, Buffer.from(signingInput, 'utf8'), pub, sig)
  } catch {
    return { ok: false, error: 'tampered' }
  }
  if (!intact) return { ok: false, error: 'tampered' }

  let raw: unknown
  try {
    raw = JSON.parse(b64urlDecode(pB64).toString('utf8'))
  } catch {
    return { ok: false, error: 'invalid' }
  }
  const parsed = LicenseClaimsSchema.safeParse(raw)
  if (!parsed.success) return { ok: false, error: 'invalid' }
  const claims = parsed.data
  if (claims.kid !== kid) return { ok: false, error: 'wrong_kid' }
  if (opts.expectedSub && claims.sub !== opts.expectedSub && claims.sub !== '*') {
    return { ok: false, error: 'wrong_device' }
  }

  const nowSec = Math.floor(nowMs / 1000)
  if (claims.nbf != null && nowSec < claims.nbf) return { ok: false, error: 'invalid' }
  const graceDays = claims.graceDays ?? DEFAULT_GRACE_DAYS
  const graceEnd = claims.exp + graceDays * 24 * 60 * 60
  if (nowSec > graceEnd) return { ok: false, error: 'expired' }
  const state: LicenseState = nowSec > claims.exp ? 'grace' : 'licensed'
  return { ok: true, claims, state }
}
