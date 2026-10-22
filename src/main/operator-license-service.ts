/**
 * Operator licence lifecycle in main (O07). One place applies, clears, promotes, demotes and revokes a seat's
 * credential so the IPC activation handler and zero-config enrolment cannot drift apart.
 *
 * Two storage slots, deliberately:
 *  - `operatorLicenseToken`: an admin or MDM licence, or an auto licence an administrator upgraded to a real
 *    tier. Everything that gates features reads this slot.
 *  - `operatorReportingToken`: the reporting-only licence from auto-enrolment. Only the telemetry transport reads
 *    it, so an auto seat looks exactly like an unconfigured install to every gate.
 */
import { resolveOperatorBaseUrl } from '@shared/operator'
import { OPERATOR_REPORTING_SETTINGS_DEFAULTS } from '@shared/operator-reporting-settings'
import { requireAuth } from './auth'
import { auditLog } from './logger'
import { acceptOperatorHeartbeat, confirmOperatorLicenseConnection } from './operator-ingest'
import { activateOperatorLicenseToken } from './operator-license-activate'
import { purgeOperatorQueue } from './operator-queue'
import { getSettings, setSettings } from './store'
import { app } from 'electron'

export interface OperatorLicenseServiceDeps {
  /** Restart the heartbeat runtime and the skills poll so they pick up the new credential. */
  restartRuntime: () => void
  notifyChanged: () => void
}

let deps: OperatorLicenseServiceDeps = { restartRuntime: () => {}, notifyChanged: () => {} }
let activationInFlight = false

export function configureOperatorLicenseService(next: OperatorLicenseServiceDeps): void {
  deps = next
}

const NO_GRANT = { operatorTier: null, operatorEntitlements: null, operatorEntitlementsAt: 0 } as const
const EMPTY_PROMOTED = {
  operatorLicenseToken: '',
  operatorLicenseJti: '',
  operatorLicenseLast4: '',
  operatorLicenseExpiresAt: null
} as const

function purge(): void {
  purgeOperatorQueue(app.getPath('userData'))
}

/** The IPC body for `operator:licenseActivate`: a licence pasted by a person, or an MDM licence. Origin `admin`. */
export async function activateOperatorLicenseFromIpc(
  payload: unknown
): Promise<{ ok: boolean; error?: string; jti?: string; last4?: string; expiresAt?: number }> {
  if (!requireAuth()) return { ok: false, error: 'Sign in with your Mantu account first.' }
  if (activationInFlight) return { ok: false, error: 'A licence check is already in progress.' }
  const raw =
    payload && typeof payload === 'object' && 'licenseKey' in (payload as object)
      ? (payload as { licenseKey: unknown }).licenseKey
      : payload
  const token = typeof raw === 'string' ? raw.trim() : ''
  activationInFlight = true
  try {
    if (token === '') {
      setSettings({ ...EMPTY_PROMOTED, ...OPERATOR_REPORTING_SETTINGS_DEFAULTS, ...NO_GRANT })
      purge()
      auditLog('operator.license.cleared', {})
      deps.restartRuntime()
      deps.notifyChanged()
      return { ok: true }
    }
    const result = activateOperatorLicenseToken(token)
    if (!result.ok) return result
    const candidate = {
      ...getSettings(),
      operatorLicenseToken: token,
      operatorLicenseJti: result.jti!,
      operatorLicenseLast4: result.last4!
    }
    const connection = await confirmOperatorLicenseConnection(candidate)
    if (!connection.ok) return { ok: false, error: connection.error }
    if (resolveOperatorBaseUrl(candidate) !== resolveOperatorBaseUrl(getSettings())) {
      return {
        ok: false,
        error: 'The Operator address changed during verification. Please activate your licence again.'
      }
    }
    setSettings({
      operatorLicenseToken: token,
      operatorLicenseJti: result.jti!,
      operatorLicenseLast4: result.last4!,
      operatorLicenseExpiresAt: result.expiresAt!,
      // An administrator's licence replaces any auto licence and is never touched by enrolment.
      ...OPERATOR_REPORTING_SETTINGS_DEFAULTS,
      operatorLicenseOrigin: 'admin',
      // Clear the previous grant before applying this licence's confirmed response.
      ...NO_GRANT
    })
    deps.restartRuntime()
    acceptOperatorHeartbeat(connection.confirmation)
    deps.notifyChanged()
    auditLog('operator.license.activated', { jti: result.jti })
    return result
  } catch {
    return {
      ok: false,
      error: 'Métis could not save your licence. Check that its data folder is writable and try again.'
    }
  } finally {
    activationInFlight = false
  }
}

/** True while an auto licence an administrator has upgraded sits in the managed slot. */
function promotedAuto(s: ReturnType<typeof getSettings>): boolean {
  return (s.operatorLicenseOrigin === 'sso' || s.operatorLicenseOrigin === 'token') && !!s.operatorLicenseToken
}

/** The licence enrolment currently holds, wherever it is stored. */
export function currentAutoLicense(): { token: string; expiresAt: number | null } | null {
  const s = getSettings()
  if (promotedAuto(s)) return { token: s.operatorLicenseToken, expiresAt: s.operatorLicenseExpiresAt }
  return s.operatorReportingToken ? { token: s.operatorReportingToken, expiresAt: s.operatorReportingExpiresAt } : null
}

/**
 * Save a freshly minted auto licence after the Worker confirms it with a signed heartbeat. Mirrors the admin
 * activation path (confirm, save, restart, accept) without the sign-in and in-flight guards.
 */
export async function applyAutoLicense(
  token: string,
  origin: 'sso' | 'token'
): Promise<{ ok: boolean; error?: string }> {
  const parsed = activateOperatorLicenseToken(token)
  if (!parsed.ok) return { ok: false, error: parsed.error }
  const cur = getSettings()
  if (cur.operatorLicenseOrigin === 'admin' || (cur.operatorLicenseToken && !promotedAuto(cur))) {
    return { ok: false, error: 'An administrator licence is active.' }
  }
  const promoted = promotedAuto(cur)
  const slot = promoted
    ? {
        operatorLicenseToken: token,
        operatorLicenseJti: parsed.jti!,
        operatorLicenseLast4: parsed.last4!,
        operatorLicenseExpiresAt: parsed.expiresAt!
      }
    : {
        operatorReportingToken: token,
        operatorReportingJti: parsed.jti!,
        operatorReportingLast4: parsed.last4!,
        operatorReportingExpiresAt: parsed.expiresAt!
      }
  const candidate = { ...cur, ...slot }
  const connection = await confirmOperatorLicenseConnection(candidate)
  if (!connection.ok) return { ok: false, error: connection.error }
  if (resolveOperatorBaseUrl(candidate) !== resolveOperatorBaseUrl(getSettings())) {
    return { ok: false, error: 'The Operator address changed during enrolment.' }
  }
  setSettings({
    ...slot,
    operatorLicenseOrigin: origin,
    operatorEnrollState: 'enrolled',
    operatorEnrollCheckedAt: 0,
    ...NO_GRANT
  })
  deps.restartRuntime()
  acceptOperatorHeartbeat(connection.confirmation)
  deps.notifyChanged()
  auditLog('operator.enroll.applied', { origin, jti: parsed.jti })
  return { ok: true }
}

/** An administrator upgraded the seat (heartbeat returned a real tier): the licence moves to the managed slot. */
export function promoteAutoLicense(): boolean {
  const s = getSettings()
  if (promotedAuto(s) || !s.operatorReportingToken) return false
  setSettings({
    operatorLicenseToken: s.operatorReportingToken,
    operatorLicenseJti: s.operatorReportingJti,
    operatorLicenseLast4: s.operatorReportingLast4,
    operatorLicenseExpiresAt: s.operatorReportingExpiresAt,
    operatorReportingToken: '',
    operatorReportingJti: '',
    operatorReportingLast4: '',
    operatorReportingExpiresAt: null
  })
  deps.restartRuntime()
  deps.notifyChanged()
  return true
}

/** The administrator removed the upgrade (tier is `reporting` again): back to the reporting-only slot. */
export function demoteAutoLicense(): boolean {
  const s = getSettings()
  if (!promotedAuto(s)) return false
  setSettings({
    operatorReportingToken: s.operatorLicenseToken,
    operatorReportingJti: s.operatorLicenseJti,
    operatorReportingLast4: s.operatorLicenseLast4,
    operatorReportingExpiresAt: s.operatorLicenseExpiresAt,
    ...EMPTY_PROMOTED,
    ...NO_GRANT
  })
  deps.restartRuntime()
  deps.notifyChanged()
  return true
}

/** The auto licence is gone (expired or invalid): forget it so enrolment starts again. Never touches admin. */
export function dropAutoLicense(): void {
  const s = getSettings()
  if (s.operatorLicenseOrigin === 'admin' || (s.operatorLicenseToken && !promotedAuto(s))) return
  setSettings({ ...EMPTY_PROMOTED, ...OPERATOR_REPORTING_SETTINGS_DEFAULTS, ...NO_GRANT })
  deps.restartRuntime()
  deps.notifyChanged()
}

/** The administrator removed this device: stop reporting, discard queued events, re-check once a day. */
export function revokeAutoSeat(now: number = Date.now()): void {
  const s = getSettings()
  if (s.operatorLicenseOrigin === 'admin' || (s.operatorLicenseToken && !promotedAuto(s))) return
  setSettings({
    ...EMPTY_PROMOTED,
    ...OPERATOR_REPORTING_SETTINGS_DEFAULTS,
    operatorEnrollState: 'revoked',
    operatorEnrollCheckedAt: now,
    ...NO_GRANT
  })
  purge()
  auditLog('operator.enroll.revoked', {})
  deps.restartRuntime()
  deps.notifyChanged()
}

/** Remember when a revoked device was last re-checked, so the daily re-check does not spin. */
export function noteRevokedChecked(now: number = Date.now()): void {
  setSettings({ operatorEnrollCheckedAt: now })
}
