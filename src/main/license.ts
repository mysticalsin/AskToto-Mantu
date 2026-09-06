/**
 * Phone-home license activation against a self-hosted license server (server side lives in
 * license-server/, built separately — this file only ever speaks its fixed JSON contract).
 *
 * MQA-068 — enforcement is COMPILED OFF in the shipped app, and no setting turns it on. The wiring is
 * all present (main/index.ts's license:gate IPC handler calls checkLicenseGrace() for the renderer's
 * boot gate, and a 12h interval re-validates via heartbeat() whenever licenseGateEnabled &&
 * licenseValid) but two renderer constants sit above it: App.tsx's LICENSE_ENFORCEMENT, which stops the
 * gate ever being consulted, and Settings.tsx's LICENSE_UI_ENABLED, which hides the only activation
 * form in the app. So licenseValid can never become true, so the heartbeat can never run, so nothing
 * here executes on a shipped build no matter what licenseGateEnabled says — including a machine-wide
 * managed-config that sets and locks it. This header used to claim the subsystem was live whenever that
 * setting was on, which is the drift the ledger row is about: do not restore that phrasing without
 * flipping BOTH constants and re-verifying activation end to end.
 *
 * MQA-281/282 (Act 5 — License/trial) added three things, all still behind the same off-by-default
 * switches above:
 *   1. `verifyLease` — Ed25519 verification of the server's signed offline "lease" (license-server's
 *      lib/lease.mjs), delegated to the pure, Electron-free `license-lease-verify.ts` so it's trivially
 *      testable and tamper-proof. `checkLicenseGrace()` now prefers a valid lease over the wall-clock
 *      grace below whenever one is present — a stronger, tamper-resistant proof, never a weaker one.
 *   2. `noteQualifyingUse` / the local trial fallback (`license-trial.ts`) — someone who never gets (or
 *      never wants) a real license key still gets a bounded, HONEST trial window, but the clock starts
 *      on the first REAL suggestion/summary Métis actually delivers, never on install or first launch.
 *   3. `fetchLicenseConfig` — reads the server's `GET /license/config` declaration (license-server's
 *      lib/license-gate.mjs) for the onboarding ActLicense scene to show, informational only.
 * No price, no checkout, anywhere in this file: keys are minted and handed out by an operator, or a
 * device runs on the local trial above. See license-server/README.md's "no purchase, no price" note.
 */
import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { isDemoTagged } from '@shared/demo-guard'
import { getSettings, setSettings } from './store'
import type { AskMode, LicenseActivateResult, LicenseConfigResult } from '@shared/ipc'
import { getLicenseLeasePublicKeyRaw } from './license-lease-key'
import { isLeaseValidNow, verifyLeaseToken, type LeasePayload } from './license-lease-verify'
import { shouldStartTrial, trialStatus } from './license-trial'

const ACTIVATE_TIMEOUT_MS = 10_000
const CONFIG_FETCH_TIMEOUT_MS = 8_000
// Soft grace: while licenseValid and inside this window, a launch never touches the network at all.
const GRACE_MS = 7 * 24 * 60 * 60 * 1000
// Hard cap: even with zero connectivity, a license keeps working for this long past its last successful
// validation before the app blocks — an offline user gets a month of runway, not an indefinite bypass.
const HARD_CAP_MS = 30 * 24 * 60 * 60 * 1000

function machineIdPath(): string {
  return join(app.getPath('userData'), 'machine-id.txt')
}

/** Stable per-install id, generated once and persisted to disk. Deliberately NOT derived from hostname
 *  or OS username — both can change (a renamed machine, a different login) and would make a real device
 *  look like a brand-new activation to the license server, silently burning a seat every time. */
export function getMachineId(): string {
  try {
    const existing = readFileSync(machineIdPath(), 'utf8').trim()
    if (existing) return existing
  } catch {
    /* no file yet */
  }
  const id = randomUUID()
  try {
    writeFileSync(machineIdPath(), id, { mode: 0o600 })
  } catch {
    /* best-effort — an unwritable userData dir just means this id won't survive a restart */
  }
  return id
}

const ServerOkSchema = z.object({
  ok: z.literal(true),
  companyName: z.string(),
  seatCap: z.number(),
  seatsUsed: z.number(),
  expiresAt: z.number().nullable(),
  // Additive-only (license-server README's "Offline leases" contract): absent entirely on a server
  // that never set LICENSE_LEASE_PRIVATE_KEY, so an older/lease-unaware deployment is unaffected.
  lease: z.string().optional()
})
const ServerErrSchema = z.object({
  ok: z.literal(false),
  error: z.enum(['invalid', 'revoked', 'expired', 'seat_limit_reached', 'not_activated'])
})
const ServerResponseSchema = z.union([ServerOkSchema, ServerErrSchema])

/** POST to the license server and normalize every failure mode (unreachable, timeout, non-JSON, a shape
 *  that doesn't match the contract) into the same { ok:false, error:'network' } the callers below treat
 *  identically to "couldn't verify right now" — never as a revoke. */
async function postJson(url: string, body: unknown): Promise<LicenseActivateResult> {
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(ACTIVATE_TIMEOUT_MS)
    })
  } catch {
    return { ok: false, error: 'network' }
  }
  try {
    const parsed = ServerResponseSchema.safeParse(await res.json())
    if (!parsed.success) return { ok: false, error: 'network' }
    if (!parsed.data.ok) return { ok: false, error: parsed.data.error }
    return {
      ok: true,
      companyName: parsed.data.companyName,
      seatCap: parsed.data.seatCap,
      expiresAt: parsed.data.expiresAt,
      lease: parsed.data.lease
    }
  } catch {
    return { ok: false, error: 'network' }
  }
}

/** Activate this machine against `serverUrl`. On success, persists the activation to settings. On any
 *  failure (rejected by the server, or unreachable) settings are left completely untouched — a failed
 *  re-activation attempt (typo'd key, server hiccup) must never un-license a device that already works. */
export async function activateLicense(serverUrl: string, licenseKey: string): Promise<LicenseActivateResult> {
  const url = normalizeServerUrl(serverUrl)
  const r = await postJson(`${url}/activate`, {
    licenseKey: licenseKey.trim(),
    machineId: getMachineId(),
    machineName: hostname()
  })
  if (r.ok) {
    setSettings({
      licenseServerUrl: url,
      licenseKey: licenseKey.trim(),
      licenseCompanyName: r.companyName ?? '',
      licenseSeatCap: r.seatCap ?? 0,
      licenseExpiresAt: r.expiresAt ?? null,
      licenseValid: true,
      licenseLastValidatedAt: Date.now(),
      // Only overwritten when THIS response carried one (additive-only server contract — see
      // ServerOkSchema above). A server that has leases configured always includes a fresh one on
      // every successful activate/heartbeat, so an absent field here means "this deployment doesn't
      // sign leases", not "the lease was revoked" — leave whatever was persisted before untouched.
      ...(r.lease !== undefined ? { licenseLease: r.lease } : {})
    })
  }
  return r
}

/** Accept whatever a human types for the server address and turn it into a URL fetch() won't reject.
 *  A bare `127.0.0.1:8420`, `localhost:8420`, or `licenses.acme.com` has no scheme, so fetch throws
 *  "Invalid URL" and the activation silently reads as a network failure — the #1 reason a good key
 *  looks broken. Default to http:// when no scheme is given (plain-LAN/dev is the common no-scheme
 *  case; a real deployment uses an https:// URL explicitly), and strip trailing slashes. */
export function normalizeServerUrl(raw: string): string {
  let u = raw.trim().replace(/\/+$/, '')
  if (u && !/^https?:\/\//i.test(u)) u = `http://${u}`
  return u
}

/** Re-validate the already-saved activation. Called by checkLicenseGrace() in the background once the
 *  7-day soft grace has passed, never awaited by it (a launch must never block on this network call). */
export async function heartbeat(): Promise<LicenseActivateResult> {
  const s = getSettings()
  if (!s.licenseServerUrl || !s.licenseKey) return { ok: false, error: 'not_activated' }
  const r = await postJson(`${normalizeServerUrl(s.licenseServerUrl)}/heartbeat`, {
    licenseKey: s.licenseKey,
    machineId: getMachineId()
  })
  if (r.ok) {
    setSettings({
      licenseCompanyName: r.companyName ?? s.licenseCompanyName,
      licenseSeatCap: r.seatCap ?? s.licenseSeatCap,
      licenseExpiresAt: r.expiresAt ?? s.licenseExpiresAt,
      licenseValid: true,
      licenseLastValidatedAt: Date.now(),
      ...(r.lease !== undefined ? { licenseLease: r.lease } : {})
    })
  } else if (r.error === 'revoked' || r.error === 'expired' || r.error === 'not_activated' || r.error === 'invalid') {
    // Any explicit verdict from the server ABOUT THIS MACHINE un-licenses the device: revoked/expired
    // (license-wide), not_activated (an admin freed this seat in the dashboard), or invalid (the license
    // was deleted). Only genuine connectivity noise — 'network', timeout, malformed response — leaves
    // licenseValid untouched, so a flaky connection alone can't brick a working install.
    setSettings({ licenseValid: false })
  }
  return r
}

export interface LicenseGraceResult {
  allowed: boolean
  reason?: 'not_activated' | 'expired_grace' | 'trial_expired'
  /** Present, and the sole reason `allowed` is true, when a verified signed lease (not the wall-clock
   *  grace below, not the local trial) is what let this device through — Settings/LicenseGate's
   *  "Continue on your offline lease (expires …)" copy reads this. */
  leaseExpiresAt?: number
  /** Present whenever the local trial fallback (never a server key) is what let this device through. */
  trialActive?: boolean
  /** Days left on the trial — 0 whenever trialActive is not true (never started, expired, or
   *  superseded by a real activation/lease). */
  trialDaysRemaining?: number
}

/** Verify a compact offline lease token against this build's bundled Ed25519 public key
 *  (license-lease-key.ts). Pure delegation to license-lease-verify.ts's verifyLeaseToken — kept as its
 *  own named export here because it's the one call site every caller in this app should use (always
 *  the bundled key, never a caller-supplied one), matching the task's "license.ts adds verifyLease()"
 *  shape. Returns null on ANY failure (empty/missing token, wrong key, tampered payload or signature,
 *  malformed shape) — never throws. */
export function verifyLease(lease: string | null | undefined): LeasePayload | null {
  if (!lease) return null
  return verifyLeaseToken(lease, getLicenseLeasePublicKeyRaw())
}

/** Called by the license:gate IPC handler (main/index.ts), which backs the renderer's boot gate
 *  (App.tsx's <LicenseGate/>). Offline-first: a valid, recently-checked license never touches the network.
 *
 * Priority order (MQA-282): a valid SIGNED LEASE outranks everything else below it — it is a strictly
 * stronger, tamper-resistant proof (the server's private key signed a specific notAfter; rolling the
 * local clock backwards cannot extend it, unlike the wall-clock grace this sits above). Only when there
 * is no valid lease does this fall back to: the existing wall-clock activation grace (unchanged
 * behavior for every install that predates Act 5), and finally — for a device that has NEVER activated
 * anything — the local trial fallback (license-trial.ts), which starts on first qualifying use, not
 * here and not on install (see noteQualifyingUse below). */
export function checkLicenseGrace(): LicenseGraceResult {
  const s = getSettings()
  if (!s.licenseGateEnabled) return { allowed: true }

  const lease = verifyLease(s.licenseLease)
  if (isLeaseValidNow(lease)) {
    return { allowed: true, leaseExpiresAt: (lease as LeasePayload).notAfter }
  }

  if (!s.licenseValid) {
    const trial = trialStatus(s.trialStartedAt)
    if (trial.state === 'active') {
      return { allowed: true, trialActive: true, trialDaysRemaining: trial.daysRemaining }
    }
    if (trial.state === 'expired') {
      return { allowed: false, reason: 'trial_expired', trialDaysRemaining: 0 }
    }
    return { allowed: false, reason: 'not_activated' }
  }

  const age = Date.now() - s.licenseLastValidatedAt

  // A negative age means the last validation is stamped in the FUTURE — the system clock was set
  // backwards (or the stored timestamp is corrupt). Local time can't be trusted to bound the offline
  // grace, so don't grant it: fire a background re-check and require a real server verdict. An online
  // machine self-heals on the next tick/retry (heartbeat restamps lastValidatedAt to a sane now); an
  // offline clock-manipulator is blocked instead of getting an indefinite bypass. (The separate 12h
  // heartbeat interval in index.ts is unaffected by clock skew and still catches revokes independently.)
  if (age < 0) {
    void heartbeat()
    return { allowed: false, reason: 'expired_grace' }
  }
  if (age < GRACE_MS) return { allowed: true } // soft grace — no network call, so launch never waits on connectivity

  if (age < HARD_CAP_MS) {
    void heartbeat() // background re-check only; the launch itself never waits on it
    return { allowed: true }
  }

  return { allowed: false, reason: 'expired_grace' }
}

/**
 * The Act-5 trial hook. Call this from the ONE seam that delivers a real result to the user — the
 * successful completion of a real ask (main/index.ts's streamDone sends, gated on `gotToken`) — never
 * from anywhere near app startup/install. Idempotent and cheap: once `trialStartedAt` is set it can
 * never be pushed forward, and this is a complete no-op for the overwhelming common case (licensing
 * off, or a device that already activated/started its trial) — a single settings read, no network call.
 *
 * `taggedFields` is the belt-and-suspenders half of the MQA-278 demo guard: Act 2's onboarding demo is
 * structurally incapable of reaching this call at all (it never touches window.toto / the ask pipeline —
 * see onboarding-demo.ts's own IPC-free contract test), but callers pass the ask's own prompt/transcript
 * through anyway so a demo-tagged payload (@shared/demo-guard's reserved prefix) is refused even if some
 * future wiring mistake ever let a demo-originated call reach here. */
export function noteQualifyingUse(mode: AskMode | string, ...taggedFields: Array<string | null | undefined>): void {
  if (isDemoTagged(...taggedFields)) return
  const s = getSettings()
  if (!shouldStartTrial({ trialStartedAt: s.trialStartedAt, mode })) return
  setSettings({ trialStartedAt: Date.now() })
}

/** Live status for display (Settings' LicenseSection, and the boot-gate LicenseGate.tsx's copy) —
 *  independent of whether the gate is currently enforcing anything, so a device can see "you're covered
 *  by a lease until …" or "N days left in your trial" even while `licenseGateEnabled` is off. Trial
 *  status is deliberately reported as inactive once a real activation exists (`licenseValid`) — the
 *  trial is a fallback for someone with no key, not a second clock running alongside a real one. */
export interface LicenseDisplayStatus {
  leaseExpiresAt: number | null
  trialActive: boolean
  trialDaysRemaining: number
}
export function licenseDisplayStatus(): LicenseDisplayStatus {
  const s = getSettings()
  const lease = verifyLease(s.licenseLease)
  const leaseExpiresAt = isLeaseValidNow(lease) ? (lease as LeasePayload).notAfter : null
  const trial = s.licenseValid ? { state: 'none' as const, daysRemaining: 0 } : trialStatus(s.trialStartedAt)
  return {
    leaseExpiresAt,
    trialActive: trial.state === 'active',
    trialDaysRemaining: trial.daysRemaining
  }
}

const LicenseConfigResponseSchema = z.object({
  ok: z.literal(true),
  licenseEnforcement: z.boolean(),
  licenseUiEnabled: z.boolean(),
  drift: z.boolean()
})

/** Reads the server's declared intent (`GET /license/config`, license-server's lib/license-gate.mjs) —
 *  purely informational, never itself a gate (see that module's own header: "does not itself gate
 *  anything on this server"). Used by the ActLicense onboarding scene to show, e.g., "your organization
 *  has not turned on license enforcement yet" before the user bothers pasting a key. Unauthenticated on
 *  the server side, so no license key is needed to call this — only a server URL. */
export async function fetchLicenseConfig(serverUrl: string): Promise<LicenseConfigResult> {
  const url = normalizeServerUrl(serverUrl)
  if (!url) return { ok: false, error: 'network' }
  try {
    const res = await fetch(`${url}/license/config`, { signal: AbortSignal.timeout(CONFIG_FETCH_TIMEOUT_MS) })
    const parsed = LicenseConfigResponseSchema.safeParse(await res.json())
    if (!parsed.success) return { ok: false, error: 'network' }
    return {
      ok: true,
      licenseEnforcement: parsed.data.licenseEnforcement,
      licenseUiEnabled: parsed.data.licenseUiEnabled,
      drift: parsed.data.drift
    }
  } catch {
    return { ok: false, error: 'network' }
  }
}

// Member-pass foundation (Phase 5). Extends this module; does not replace phone-home above.
// LICENSE_ACTIVATION_OPEN=false — Activate is honest ActivationUnavailable. See
// src/main/license/activate.ts and docs/design/IDENTITY-CARD.md.
export {
  activate as activateMemberLicense,
  deactivate as deactivateMemberLicense,
  status as memberLicenseStatus,
  verifyCached as verifyCachedMemberLicense,
  identitySnapshot,
  importLicenseMetis,
  maybeRegisterInstall
} from './license/activate'
export { hashDeviceId, formatSerialDisplay, resolveDeviceIdentity } from './license/device'
export { verifyLicenseJws, signLicenseJws } from './license/jws'
export { LICENSE_ACTIVATION_OPEN } from '@shared/license-types'
