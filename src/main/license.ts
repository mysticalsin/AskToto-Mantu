/**
 * Phone-home license activation against a self-hosted license server (server side lives in
 * license-server/, built separately — this file only ever speaks its fixed JSON contract).
 *
 * Nothing here is wired into a startup gate yet. checkLicenseGrace() exists and is fully tested, but is
 * called from nowhere except its own test — a future task adds the actual app-launch enforcement once
 * activation has been verified end to end against a real deployed server.
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
  const r = await postJson(`${serverUrl.replace(/\/+$/, '')}/activate`, {
    licenseKey,
    machineId: getMachineId(),
    machineName: hostname()
  })
  if (r.ok) {
    setSettings({
      licenseServerUrl: serverUrl,
      licenseKey,
      licenseCompanyName: r.companyName ?? '',
      licenseSeatCap: r.seatCap ?? 0,
      licenseExpiresAt: r.expiresAt ?? null,
      licenseValid: true,
      licenseLastValidatedAt: Date.now()
    })
  }
  return r
}

/** Re-validate the already-saved activation. Called by checkLicenseGrace() in the background once the
 *  7-day soft grace has passed, never awaited by it (a launch must never block on this network call). */
export async function heartbeat(): Promise<LicenseActivateResult> {
  const s = getSettings()
  if (!s.licenseServerUrl || !s.licenseKey) return { ok: false, error: 'not_activated' }
  const r = await postJson(`${s.licenseServerUrl.replace(/\/+$/, '')}/heartbeat`, {
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
  } else if (r.error === 'revoked' || r.error === 'expired') {
    // Only an explicit revoked/expired verdict from the server un-licenses the device. Every other
    // failure here — network, timeout, malformed response — leaves licenseValid untouched, otherwise a
    // flaky connection alone would brick a working install.
    setSettings({ licenseValid: false })
  }
  return r
}

export interface LicenseGraceResult {
  allowed: boolean
  reason?: 'not_activated' | 'expired_grace'
}

/** Called once at app startup (only meaningful once a future gate actually enforces its result — see the
 *  file header). Offline-first: a valid, recently-checked license never touches the network. */
export function checkLicenseGrace(): LicenseGraceResult {
  const s = getSettings()
  if (!s.licenseGateEnabled) return { allowed: true }
  if (!s.licenseValid) return { allowed: false, reason: 'not_activated' }

  const age = Date.now() - s.licenseLastValidatedAt
  if (age < GRACE_MS) return { allowed: true } // soft grace — no network call, so launch never waits on connectivity

  if (age < HARD_CAP_MS) {
    void heartbeat() // background re-check only; the launch itself never waits on it
    return { allowed: true }
  }

  return { allowed: false, reason: 'expired_grace' }
}
