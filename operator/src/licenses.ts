/**
 * Métis ATK license keys for the Operator platform.
 * Same contract as license-server + src/main/license.ts:
 *   POST /activate  { licenseKey, machineId, machineName? }
 *   POST /heartbeat { licenseKey, machineId }
 *   ok → { ok:true, companyName, seatCap, seatsUsed, expiresAt }
 *   err → { ok:false, error: invalid|revoked|expired|seat_limit_reached|not_activated }
 */
import type { LicenseActivationRow, LicenseRow, OperatorStore } from './store'

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

export type LicenseStatus = 'ok' | 'invalid' | 'revoked' | 'expired'

export interface LicenseListItem {
  licenseKey: string
  companyName: string
  seatCap: number
  seatsUsed: number
  revoked: boolean
  expiresAt: number | null
  createdAt: number
  contactName: string
  contactEmail: string
  notes: string
  status: LicenseStatus | 'seat_full'
}

export function generateLicenseKey(): string {
  const bytes = new Uint8Array(20)
  crypto.getRandomValues(bytes)
  let suffix = ''
  for (let i = 0; i < bytes.length; i++) {
    suffix += CROCKFORD[bytes[i]! % 32]
  }
  return `ATK-${suffix}`
}

export function licenseStatus(row: LicenseRow | null | undefined, now: number): LicenseStatus {
  if (!row) return 'invalid'
  if (row.revoked) return 'revoked'
  if (row.expires_at != null && row.expires_at < now) return 'expired'
  return 'ok'
}

export function successPayload(row: LicenseRow, seatsUsed: number) {
  return {
    ok: true as const,
    companyName: row.company_name,
    seatCap: row.seat_cap,
    seatsUsed,
    expiresAt: row.expires_at
  }
}

function clip(raw: unknown, max: number): string {
  if (typeof raw !== 'string') return ''
  return raw.trim().slice(0, max)
}

function seatCapOf(raw: unknown): number | null {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN
  if (!Number.isInteger(n) || n < 1 || n > 10_000) return null
  return n
}

function expiresAtOf(raw: unknown): number | null | undefined {
  if (raw === undefined) return undefined
  if (raw === null || raw === '') return null
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) return Math.floor(raw)
  if (typeof raw === 'string') {
    const t = Date.parse(raw)
    if (Number.isFinite(t)) return t
  }
  return undefined
}

export async function listLicenseItems(store: OperatorStore, now: number): Promise<LicenseListItem[]> {
  const rows = await store.listLicenses()
  const out: LicenseListItem[] = []
  for (const row of rows) {
    const activations = await store.listLicenseActivations(row.license_key)
    const status = licenseStatus(row, now)
    out.push({
      licenseKey: row.license_key,
      companyName: row.company_name,
      seatCap: row.seat_cap,
      seatsUsed: activations.length,
      revoked: row.revoked === 1,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
      contactName: row.contact_name,
      contactEmail: row.contact_email,
      notes: row.notes,
      status: status === 'ok' && activations.length >= row.seat_cap ? 'seat_full' : status
    })
  }
  return out
}

export async function createLicense(
  store: OperatorStore,
  email: string,
  now: number,
  body: Record<string, unknown>
): Promise<
  | { ok: true; licenseKey: string; companyName: string; seatCap: number; expiresAt: number | null }
  | { ok: false; error: string; status: number }
> {
  const companyName = clip(body.companyName ?? body.company, 120)
  if (!companyName) return { ok: false, error: 'companyName required', status: 400 }
  const seatCap = seatCapOf(body.seatCap ?? body.seats)
  if (seatCap == null) return { ok: false, error: 'seatCap must be a positive integer', status: 400 }
  const expiresParsed = expiresAtOf(body.expiresAt ?? body.expires)
  if (expiresParsed === undefined && body.expiresAt !== undefined && body.expires !== undefined) {
    return { ok: false, error: 'expiresAt invalid', status: 400 }
  }
  const expiresAt = expiresParsed === undefined ? null : expiresParsed
  const contactName = clip(body.contactName, 120)
  const contactEmail = clip(body.contactEmail, 160)
  const notes = clip(body.notes, 500)

  let licenseKey = generateLicenseKey()
  for (let i = 0; i < 8; i++) {
    if (!(await store.getLicense(licenseKey))) break
    licenseKey = generateLicenseKey()
  }
  if (await store.getLicense(licenseKey)) {
    return { ok: false, error: 'could not mint unique key', status: 500 }
  }

  const row: LicenseRow = {
    license_key: licenseKey,
    company_name: companyName,
    seat_cap: seatCap,
    created_at: now,
    expires_at: expiresAt,
    revoked: 0,
    contact_name: contactName,
    contact_email: contactEmail,
    notes,
    created_by: email
  }
  await store.putLicense(row)
  await store.audit(crypto.randomUUID(), now, email, 'license-create', null, `${companyName} ${licenseKey}`)
  return {
    ok: true,
    licenseKey,
    companyName,
    seatCap,
    expiresAt
  }
}

export async function revokeLicense(
  store: OperatorStore,
  email: string,
  now: number,
  licenseKey: string
): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
  const row = await store.getLicense(licenseKey)
  if (!row) return { ok: false, error: 'not found', status: 404 }
  if (row.revoked === 1) return { ok: true }
  await store.putLicense({ ...row, revoked: 1 })
  await store.audit(crypto.randomUUID(), now, email, 'license-revoke', null, licenseKey)
  return { ok: true }
}

export async function activateLicense(
  store: OperatorStore,
  now: number,
  body: Record<string, unknown>
): Promise<Response> {
  const licenseKey = clip(body.licenseKey ?? body.license_key, 64)
  const machineId = clip(body.machineId ?? body.machine_id, 128)
  const machineName = clip(body.machineName ?? body.machine_name, 120)
  if (!licenseKey || !machineId) {
    return Response.json({ ok: false, error: 'invalid' }, { status: 200 })
  }
  const row = await store.getLicense(licenseKey)
  const status = licenseStatus(row, now)
  if (status !== 'ok' || !row) {
    return Response.json({ ok: false, error: status === 'ok' ? 'invalid' : status }, { status: 200 })
  }
  const activations = await store.listLicenseActivations(licenseKey)
  const existing = activations.find((a) => a.machine_id === machineId)
  if (existing) {
    await store.putLicenseActivation({
      ...existing,
      machine_name: machineName || existing.machine_name,
      last_seen_at: now
    })
    return Response.json(successPayload(row, activations.length))
  }
  if (activations.length >= row.seat_cap) {
    return Response.json({ ok: false, error: 'seat_limit_reached' }, { status: 200 })
  }
  await store.putLicenseActivation({
    license_key: licenseKey,
    machine_id: machineId,
    machine_name: machineName,
    activated_at: now,
    last_seen_at: now
  })
  return Response.json(successPayload(row, activations.length + 1))
}

export async function heartbeatLicense(
  store: OperatorStore,
  now: number,
  body: Record<string, unknown>
): Promise<Response> {
  const licenseKey = clip(body.licenseKey ?? body.license_key, 64)
  const machineId = clip(body.machineId ?? body.machine_id, 128)
  if (!licenseKey || !machineId) {
    return Response.json({ ok: false, error: 'invalid' }, { status: 200 })
  }
  const row = await store.getLicense(licenseKey)
  const status = licenseStatus(row, now)
  if (status !== 'ok' || !row) {
    return Response.json({ ok: false, error: status === 'ok' ? 'invalid' : status }, { status: 200 })
  }
  const activations = await store.listLicenseActivations(licenseKey)
  const existing = activations.find((a) => a.machine_id === machineId)
  if (!existing) {
    return Response.json({ ok: false, error: 'not_activated' }, { status: 200 })
  }
  await store.putLicenseActivation({ ...existing, last_seen_at: now })
  return Response.json(successPayload(row, activations.length))
}
