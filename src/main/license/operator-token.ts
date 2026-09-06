import { createHmac } from 'node:crypto'
import {
  operatorLicenseCanonical,
  parseOperatorLicense,
  timingSafeEqualStr,
  type OperatorLicenseFail,
  type OperatorLicenseOk
} from '@shared/operator-license'

export function hmacSha256B64urlSync(secret: string, message: string): string {
  return createHmac('sha256', secret).update(message).digest('base64url')
}

export function verifyOperatorLicenseSync(
  secret: string,
  token: string,
  now = Date.now()
): OperatorLicenseOk | OperatorLicenseFail {
  const parsed = parseOperatorLicense(token)
  if (!parsed || !secret.trim()) return { ok: false, error: 'invalid' }
  const expected = hmacSha256B64urlSync(secret, operatorLicenseCanonical(parsed.jti, parsed.iat, parsed.exp))
  if (!timingSafeEqualStr(expected, parsed.sig)) return { ok: false, error: 'invalid' }
  if (parsed.exp * 1000 <= now) return { ok: false, error: 'expired' }
  return { ok: true, claims: { jti: parsed.jti, iat: parsed.iat, exp: parsed.exp } }
}
