import { OPERATOR_LICENSE_HEADER } from '../../src/shared/operator-hmac'
import { operatorLicenseLast4, verifyOperatorLicense, type OperatorLicenseClaims } from '../../src/shared/operator-license'
import { sha256Hex } from './crypto'
import { timingSafeEqualHex, verifyIngestHmac, type HmacCheck, type HmacFail } from './hmac'
import type { IssuedLicenseRow, OperatorStore, SeatRow } from './store'

export type VerifiedDeviceLicense = { jti: string; last4: string }
type DeviceAuth = HmacCheck & { license?: VerifiedDeviceLicense }

function refused(code: string, error: string, status = 403): HmacFail {
  return { ok: false, status, error, code }
}

function issuedLicenseFailure(
  issued: IssuedLicenseRow | null,
  seat: SeatRow | null,
  claims: OperatorLicenseClaims,
  keyHash: string,
  deviceId: string,
  now: number
): HmacFail | null {
  if (!issued || !timingSafeEqualHex(issued.key_hash, keyHash)) {
    return refused('license-invalid', 'This Métis licence could not be verified.', 401)
  }
  if (issued.revoked) return refused('license-revoked', 'This Métis licence has been revoked.')
  if (issued.exp * 1000 <= now) return refused('license-expired', 'This Métis licence has expired.')
  if (issued.iat !== claims.iat || issued.exp !== claims.exp) {
    return refused('license-invalid', 'This Métis licence could not be verified.', 401)
  }
  if ((seat?.approval || '').trim().toLowerCase() === 'revoked') {
    return refused('seat-revoked', 'Access for this device has been revoked.')
  }
  if (issued.activated_device && issued.activated_device !== deviceId) {
    return refused('license-device', 'This Métis licence is already linked to another device.')
  }
  return null
}

/** A licence signs only its own device requests. The fleet-wide minting secret stays on the Worker.
 *  Header presence selects the protocol: a bad licence must never fall back to legacy fleet HMAC. */
export async function verifyDeviceRequest(
  request: Request,
  bodyText: string,
  serverSecret: string,
  store: OperatorStore,
  now: number
): Promise<DeviceAuth | HmacFail> {
  const licenseHeader = request.headers.get(OPERATOR_LICENSE_HEADER)
  if (licenseHeader === null) {
    return verifyIngestHmac(request, bodyText, serverSecret, now, (nonce) => store.takeNonce(nonce, now))
  }
  const token = licenseHeader.trim()
  const mintingSecret = serverSecret?.trim() || ''
  if (!mintingSecret) return refused('license-unavailable', 'Licence verification is temporarily unavailable.', 503)
  const verified = await verifyOperatorLicense(mintingSecret, token, now)
  if (!verified.ok) {
    return verified.error === 'expired'
      ? refused('license-expired', 'This Métis licence has expired.')
      : refused('license-invalid', 'This Métis licence could not be verified.', 401)
  }
  // No storage mutation until both the licence and this timestamp/device/body signature verify.
  const hmac = await verifyIngestHmac(request, bodyText, token, now)
  if (!hmac.ok) return hmac
  const keyHash = await sha256Hex(token)
  const [issued, seat] = await Promise.all([
    store.getIssuedLicense(verified.claims.jti),
    store.getSeat(hmac.deviceId)
  ])
  const failure = issuedLicenseFailure(issued, seat, verified.claims, keyHash, hmac.deviceId, now)
  if (failure) return failure
  // Only setup's heartbeat may select a different licence. All other calls must use the licence
  // currently assigned to this seat, so an older token cannot borrow a replacement's entitlements.
  if (new URL(request.url).pathname !== '/v1/heartbeat' && seat?.license_jti !== verified.claims.jti) {
    return refused('license-device', 'This Métis licence is not active on this device. Complete setup again.')
  }
  if (await store.takeNonce(hmac.nonce, now)) return { ok: false, status: 401, error: 'replay nonce' }

  // A conditional write closes the race between the read above, another device's activation, and an
  // administrator revoking the licence/seat. It never changes revoked or overwrites another device.
  if (!(await store.bindIssuedLicense(verified.claims.jti, keyHash, hmac.deviceId, now))) {
    const [currentLicense, currentSeat] = await Promise.all([
      store.getIssuedLicense(verified.claims.jti),
      store.getSeat(hmac.deviceId)
    ])
    return issuedLicenseFailure(currentLicense, currentSeat, verified.claims, keyHash, hmac.deviceId, now)
      ?? refused('license-device', 'This Métis licence could not be linked to this device.')
  }
  return { ...hmac, license: { jti: verified.claims.jti, last4: operatorLicenseLast4(token) } }
}

/** The body is device-controlled even after HMAC verification; licence identity comes from proof. */
export function withVerifiedLicense(
  body: Record<string, unknown>,
  license?: VerifiedDeviceLicense
): Record<string, unknown> {
  return license
    ? { ...body, license: 'licensed', licenseId: license.jti, licenseLast4: license.last4 }
    : body
}
