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
 */
import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { getSettings, setSettings } from './store'
import type { LicenseActivateResult } from '@shared/ipc'

const ACTIVATE_TIMEOUT_MS = 10_000
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
  expiresAt: z.number().nullable()
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
    return { ok: true, companyName: parsed.data.companyName, seatCap: parsed.data.seatCap, expiresAt: parsed.data.expiresAt }
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
      licenseLastValidatedAt: Date.now()
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
      licenseLastValidatedAt: Date.now()
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
  reason?: 'not_activated' | 'expired_grace'
}

/** Called by the license:gate IPC handler (main/index.ts), which backs the renderer's boot gate
 *  (App.tsx's <LicenseGate/>). Offline-first: a valid, recently-checked license never touches the network. */
export function checkLicenseGrace(): LicenseGraceResult {
  const s = getSettings()
  if (!s.licenseGateEnabled) return { allowed: true }
  if (!s.licenseValid) return { allowed: false, reason: 'not_activated' }

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
