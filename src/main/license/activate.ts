/**
 * Member-pass license API: activate, deactivate, status, verifyCached.
 * LICENSE_ACTIVATION_OPEN=false → the real LicenseClient returns
 * activation_unavailable. Cache is never written as licensed in that path.
 */
import { app } from 'electron'
import {
  LICENSE_ACTIVATION_OPEN,
  emptyLicenseStatus,
  type IdentitySnapshot,
  type MemberActivateResult,
  type MemberLicenseError,
  type MemberLicenseStatus
} from '@shared/license-types'
import { isOperatorLicenseKey, operatorLicenseLast4 } from '@shared/operator-license'
import { getLicenseClient } from './client'
import { formatSerialDisplay, hashDeviceId, resolveDeviceIdentity } from './device'
import { operatorLicenseStatus } from './operator-status'
import { verifyOperatorLicenseSync } from './operator-token'
import {
  assignMemberNumber,
  formatInstalledLabel,
  memberNumberLabel,
  readInstallIdentity
} from './install'
import { verifyLicenseJws } from './jws'
import {
  clearLicenseCache,
  readLicenseCache,
  writeLicenseCache,
  writeOperatorLicenseCache
} from './secret-store'
import { extractJwsFromLicenseFile, managedLicensePresent, parseLicenseMetis } from './airgap'
import { getSettings } from '../store'

function currentDevice() {
  const install = readInstallIdentity()
  return { install, device: resolveDeviceIdentity(install.installId) }
}

function deviceHash(): string {
  const { device } = currentDevice()
  return hashDeviceId(device.stableId, device.platform)
}

function ingestSecret(): string {
  return (getSettings().operatorIngestSecret || process.env.METIS_OPERATOR_INGEST_SECRET || '').trim()
}

function statusFromCache(): MemberLicenseStatus {
  const managed = managedLicensePresent()
  const operator = operatorLicenseStatus()
  if (operator) return { ...operator, managedFilePresent: managed }
  const cache = readLicenseCache()
  if (!cache) {
    return emptyLicenseStatus({ managedFilePresent: managed })
  }
  const verified = verifyLicenseJws(cache.jws, { expectedSub: deviceHash() })
  if (!verified.ok) {
    return emptyLicenseStatus({
      managedFilePresent: managed,
      source: 'none',
      error: verified.error === 'invalid' ? 'tampered' : verified.error
    })
  }
  return emptyLicenseStatus({
    state: verified.state,
    edition: verified.claims.edition,
    seats: verified.claims.seats,
    expiresAt: verified.claims.exp * 1000,
    features: verified.claims.features,
    orgId: verified.claims.orgId ?? null,
    source: cache.source,
    managedFilePresent: managed
  })
}

export function verifyCached(): MemberLicenseStatus {
  return statusFromCache()
}

export function status(): MemberLicenseStatus {
  return statusFromCache()
}

export function deactivate(): MemberLicenseStatus {
  clearLicenseCache()
  return emptyLicenseStatus({ managedFilePresent: managedLicensePresent() })
}

export async function activate(key: string): Promise<MemberActivateResult> {
  const licenseKey = key.trim()
  if (!licenseKey) {
    const s = status()
    return { ok: false, error: 'invalid', status: { ...s, error: 'invalid' } }
  }
  if (isOperatorLicenseKey(licenseKey)) {
    const secret = ingestSecret()
    const verified = verifyOperatorLicenseSync(secret, licenseKey)
    if (!verified.ok) {
      const s = status()
      return { ok: false, error: verified.error, status: { ...s, error: verified.error } }
    }
    writeOperatorLicenseCache({
      token: licenseKey,
      jti: verified.claims.jti,
      iat: verified.claims.iat,
      exp: verified.claims.exp,
      last4: operatorLicenseLast4(licenseKey),
      cachedAt: Date.now()
    })
    return { ok: true, status: status() }
  }
  const { device } = currentDevice()
  const client = getLicenseClient(getSettings().licenseServerUrl)
  const response = await client.activate({
    licenseKey,
    deviceIdHash: hashDeviceId(device.stableId, device.platform),
    appVersion: app.getVersion(),
    os: process.platform
  })
  if (!response.ok) {
    const err = response.error as MemberLicenseError
    const s = status()
    return { ok: false, error: err, status: { ...s, error: err } }
  }
  // Flag-open path: verify the returned JWS before caching. Closed path never reaches here.
  const verified = verifyLicenseJws(response.jws, { expectedSub: hashDeviceId(device.stableId, device.platform) })
  if (!verified.ok) {
    const s = status()
    return { ok: false, error: verified.error === 'invalid' ? 'tampered' : verified.error, status: { ...s, error: verified.error } }
  }
  writeLicenseCache({
    jws: response.jws,
    cachedAt: Date.now(),
    kid: verified.claims.kid,
    edition: verified.claims.edition,
    source: 'cache'
  })
  return { ok: true, status: status() }
}

export async function importLicenseMetis(raw: string, source: 'file' | 'mdm' = 'file'): Promise<MemberActivateResult> {
  if (!LICENSE_ACTIVATION_OPEN) {
    // Parser + verify still run. The result is honest: not open yet.
    parseLicenseMetis(raw, { expectedSub: deviceHash() })
    const s = status()
    return { ok: false, error: 'activation_unavailable', status: { ...s, error: 'activation_unavailable' } }
  }
  const verified = parseLicenseMetis(raw, { expectedSub: deviceHash() })
  if (!verified.ok) {
    const s = status()
    const err = verified.error === 'invalid' ? 'invalid' : verified.error
    return { ok: false, error: err, status: { ...s, error: err } }
  }
  const jws = extractJwsFromLicenseFile(raw)
  if (!jws) {
    const s = status()
    return { ok: false, error: 'invalid', status: { ...s, error: 'invalid' } }
  }
  writeLicenseCache({
    jws,
    cachedAt: Date.now(),
    kid: verified.claims.kid,
    edition: verified.claims.edition,
    source
  })
  return { ok: true, status: status() }
}

let registerAttempted = false

export function maybeRegisterInstall(): void {
  if (registerAttempted) return
  const install = readInstallIdentity()
  if (install.memberNumber != null) return
  registerAttempted = true
  const client = getLicenseClient(getSettings().licenseServerUrl)
  void client
    .registerInstall({
      installId: install.installId,
      appVersion: app.getVersion(),
      os: process.platform
    })
    .then((r) => {
      if (r.ok && Number.isInteger(r.memberNumber) && r.memberNumber > 0) {
        assignMemberNumber(r.memberNumber)
      }
    })
    .catch(() => {
      /* pending stays pending */
    })
}

/** Test hook: allow a suite to retry register-install. */
export function resetRegisterAttemptForTests(): void {
  registerAttempted = false
}

export function identitySnapshot(): IdentitySnapshot {
  maybeRegisterInstall()
  const install = readInstallIdentity()
  const device = resolveDeviceIdentity(install.installId)
  return {
    installId: install.installId,
    installedAt: install.installedAt,
    installedAtLabel: formatInstalledLabel(install.installedAt),
    memberNumber: install.memberNumber,
    memberNumberLabel: memberNumberLabel(install.memberNumber),
    deviceName: device.deviceName,
    serialKind: device.serialKind,
    serialDisplay: formatSerialDisplay(device.stableId, device.serialKind),
    license: status()
  }
}
