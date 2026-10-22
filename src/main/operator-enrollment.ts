/**
 * Zero-config Operator enrolment glue (O07). Decides with the pure machine (operator-enrollment-machine.ts),
 * performs `POST /v1/enroll`, and applies the result through the licence service. All collaborators are
 * injected once at boot (operator-enrollment-runtime.ts) so tests never touch settings, auth or the network.
 *
 * The only network target is `${operatorBase}/v1/enroll`. Nothing here ever sends meeting content.
 */
import {
  OPERATOR_REPORTING_TIER,
  operatorManagedSeat,
  resolveOperatorBaseUrl,
  resolveOperatorCredential,
  resolveOperatorTelemetryCredential,
  type OperatorReportingStatus,
  type OperatorTransportSettings
} from '@shared/operator'
import { OPERATOR_ENROLL_HEADER, OPERATOR_LICENSE_HEADER } from '@shared/operator-hmac'
import {
  applyEnrollOutcome,
  classifyEnrollResponse,
  decideEnrollment,
  emptyEnrollMemory,
  type EnrollHttpResult,
  type EnrollMemory,
  type EnrollMethod,
  type EnrollOutcome,
  type EnrollOrigin,
  type EnrollState
} from './operator-enrollment-machine'
import { operatorHmacHeaders } from './operator-hmac-sign'
import type { OperatorHeartbeatOutcome } from './operator-ingest'
import { operatorReportingAllowed } from './operator-reporting-policy'

export interface EnrollSettings extends OperatorTransportSettings {
  operatorEnrollState?: EnrollState
  operatorEnrollCheckedAt?: number
  operatorReportingExpiresAt?: number | null
  operatorLicenseExpiresAt?: number | null
}

export interface EmbeddedEnrollToken {
  token: string
  /** The Operator URL the token was issued for. It is used only when it equals the resolved base URL. */
  operatorUrl: string
}

export interface EnrollmentDeps {
  getSettings: () => EnrollSettings
  now: () => number
  fetch: typeof fetch
  /** Hash of the durable device id, or null when it is not persisted yet. */
  deviceId: () => string | null
  /** Fresh Entra ID token for the signed-in session, or null. */
  idToken: () => Promise<{ idToken: string } | null>
  signedIn: () => boolean
  embeddedToken: () => EmbeddedEnrollToken | null
  currentLicense: () => { token: string; expiresAt: number | null } | null
  applyAutoLicense: (token: string, origin: 'sso' | 'token') => Promise<{ ok: boolean; error?: string }>
  promote: () => void
  demote: () => void
  drop: () => void
  revoke: () => void
  noteRevokedChecked: (now: number) => void
  appVersion: () => string
  os: () => string
  rand?: () => number
  audit?: (event: string, detail: Record<string, unknown>) => void
}

let deps: EnrollmentDeps | null = null
let memory: EnrollMemory = emptyEnrollMemory()

export function configureOperatorEnrollment(next: EnrollmentDeps | null): void {
  deps = next
  memory = emptyEnrollMemory()
}

export function enrollmentMemoryForTests(): EnrollMemory {
  return memory
}

function adminCredentialInUse(s: EnrollSettings): boolean {
  // The shipped credential resolver sees the admin slot, the legacy secret and the env secret, never the
  // reporting slot, so anything it finds that is not an auto-promoted licence belongs to an administrator.
  const cred = resolveOperatorCredential(s)
  if (!cred) return false
  const auto = s.operatorLicenseOrigin === 'sso' || s.operatorLicenseOrigin === 'token'
  return !(auto && s.operatorLicenseToken?.trim() && !s.operatorIngestSecret?.trim())
}

function embeddedFor(base: string): EmbeddedEnrollToken | null {
  const embedded = deps?.embeddedToken() ?? null
  if (!embedded?.token || !base) return null
  // Same anti-redirect rule as the env credential: the token belongs to its own endpoint only.
  return embedded.operatorUrl.replace(/\/$/, '') === base ? embedded : null
}

async function readResponse(res: Response): Promise<EnrollHttpResult> {
  const contentType = res.headers.get('content-type')
  let json: unknown = null
  if ((contentType ?? '').toLowerCase().includes('application/json')) {
    try {
      json = JSON.parse(await res.text())
    } catch {
      json = null
    }
  } else {
    await res.body?.cancel().catch(() => undefined)
  }
  return { status: res.status, contentType, location: res.headers.get('location'), json }
}

interface BuiltRequest {
  body: string
  headers: Record<string, string>
}

async function buildRequest(method: EnrollMethod, d: EnrollmentDeps, deviceId: string): Promise<BuiltRequest | null> {
  const base = { method, appVersion: d.appVersion(), os: d.os() }
  const license = d.currentLicense()
  if (method === 'sso') {
    const id = await d.idToken()
    if (!id) return null
    const body = JSON.stringify({ ...base, idToken: id.idToken })
    const headers = operatorHmacHeaders(id.idToken, deviceId, body, d.now())
    // An upgrade from a token seat also proves the device by presenting the licence it already holds.
    if (license) headers[OPERATOR_LICENSE_HEADER] = license.token
    return { body, headers }
  }
  if (method === 'token') {
    const embedded = embeddedFor(resolveOperatorBaseUrl(d.getSettings()))
    if (!embedded) return null
    const body = JSON.stringify(base)
    return {
      body,
      headers: {
        ...operatorHmacHeaders(embedded.token, deviceId, body, d.now()),
        [OPERATOR_ENROLL_HEADER]: embedded.token
      }
    }
  }
  if (!license) return null
  const body = JSON.stringify(base)
  // The licence is both the credential and the HMAC key, so the shared signer adds the licence header itself.
  return { body, headers: operatorHmacHeaders(license.token, deviceId, body, d.now()) }
}

/** One enrolment attempt if the machine says one is due. Safe to call from any trigger; never throws. */
export async function enrollmentTick(reason: string = 'tick'): Promise<void> {
  const d = deps
  if (!d) return
  try {
    const s = d.getSettings()
    const base = resolveOperatorBaseUrl(s)
    const now = d.now()
    const license = d.currentLicense()
    const decision = decideEnrollment({
      now,
      policyAllowed: operatorReportingAllowed(),
      urlOk: !!base,
      adminCredential: adminCredentialInUse(s),
      state: s.operatorEnrollState ?? 'unenrolled',
      origin: (s.operatorLicenseOrigin ?? null) as EnrollOrigin,
      reportingExpiresAt: license?.expiresAt ?? s.operatorReportingExpiresAt ?? null,
      revokedCheckedAt: s.operatorEnrollCheckedAt ?? 0,
      ssoAvailable: d.signedIn(),
      tokenAvailable: !!embeddedFor(base),
      memory
    })
    if (decision.action !== 'attempt') return
    const deviceId = d.deviceId()
    if (!deviceId) return
    memory = { ...memory, inFlight: true }
    const method = decision.method
    let outcome: EnrollOutcome
    let status = 0
    try {
      const request = await buildRequest(method, d, deviceId)
      if (!request) {
        // No ID token (sign-in lapsed) or no token for this URL: wait for the next sign-in or update.
        outcome = { kind: method === 'sso' ? ('sso-stop' as const) : ('token-off' as const) }
      } else {
        const res = await d.fetch(`${base}/v1/enroll`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...request.headers },
          body: request.body,
          redirect: 'manual',
          signal: AbortSignal.timeout(15_000)
        })
        const read = await readResponse(res)
        status = read.status
        outcome = classifyEnrollResponse(read)
      }
    } catch {
      outcome = classifyEnrollResponse(null)
    }
    if (outcome.kind === 'ok') {
      const origin = method === 'renew' ? (s.operatorLicenseOrigin === 'token' ? 'token' : 'sso') : method
      const applied = await d.applyAutoLicense(outcome.license, origin)
      if (!applied.ok) outcome = { kind: 'retry' }
    } else if (outcome.kind === 'revoked') {
      d.revoke()
    } else if (method === 'renew' && status === 401) {
      // The licence we tried to renew is no longer valid: forget it so the next attempt enrols afresh.
      d.drop()
    }
    if ((s.operatorEnrollState ?? 'unenrolled') === 'revoked' && outcome.kind !== 'ok') d.noteRevokedChecked(d.now())
    memory = applyEnrollOutcome(memory, method, outcome, d.now(), d.rand)
    d.audit?.('operator.enroll.attempt', { method, reason, outcome: outcome.kind })
  } catch {
    memory = { ...memory, inFlight: false }
  }
}

/** Reconcile the seat's standing with what the heartbeat just confirmed or refused. */
export async function enrollmentAfterHeartbeat(beat: OperatorHeartbeatOutcome): Promise<void> {
  const d = deps
  if (!d) return
  const s = d.getSettings()
  const auto = s.operatorLicenseOrigin === 'sso' || s.operatorLicenseOrigin === 'token'
  if (!auto || adminCredentialInUse(s)) return
  if (beat.ok && beat.tier) {
    if (beat.tier === OPERATOR_REPORTING_TIER) d.demote()
    else d.promote()
    return
  }
  if (beat.denied) {
    const code = beat.denied.code ?? ''
    if (code === 'seat-revoked') d.revoke()
    else if (code === 'license-expired' || code === 'license-invalid' || code === 'license-revoked') d.drop()
  }
}

/** A successful SSO sign-in re-opens the SSO path and tries immediately. */
export function enrollmentOnSignedIn(): void {
  memory = { ...memory, ssoBlockedUntilSignIn: false, nextAttemptAt: 0 }
  void enrollmentTick('signed-in')
}

export function enrollmentOnResume(): void {
  void enrollmentTick('resume')
}

/** What Settings shows. `enrolled` covers any working credential, including an administrator's licence. */
export function operatorReportingStatusFor(s: EnrollSettings): OperatorReportingStatus {
  if (!operatorReportingAllowed()) return 'off-by-policy'
  if (operatorManagedSeat(s) || resolveOperatorTelemetryCredential(s)) return 'enrolled'
  return s.operatorEnrollState === 'revoked' ? 'revoked' : 'pending'
}
