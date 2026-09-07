/** Real Métis seats vs synthetic import rows. Tony-only approval for platform keys. */

import { parseLicenseId } from '../../src/shared/operator-license'
import type { IssuedLicenseRow, OperatorStore } from './store'

export { parseLicenseId }

export const SEAT_APPROVALS = ['pending', 'approved', 'revoked'] as const
export type SeatApproval = (typeof SEAT_APPROVALS)[number]

export const LICENSE_STATUSES = [
  'licensed',
  'unlicensed',
  'grace',
  'expired',
  'trial',
  'approved',
  'pending',
  'revoked'
] as const
export type LicenseStatus = (typeof LICENSE_STATUSES)[number]

export const SEAT_NOT_APPROVED =
  'This seat is not approved. Tony must approve this device in Operator before platform keys work.'

export const LICENSES_EMPTY = 'No licenses in D1'

export type FleetSeat = {
  device_id: string
  os?: string | null
  app_version?: string | null
  hostname?: string | null
  sso_email?: string | null
  license?: string | null
  approval?: string | null
  license_jti?: string | null
}

export function isRealSeat(row: FleetSeat): boolean {
  const id = (row.device_id || '').trim().toLowerCase()
  if (!id) return false
  if (id.startsWith('usage-')) return false
  const ver = (row.app_version || '').trim().toLowerCase()
  if (ver === 'usage-import') return false
  const os = (row.os || '').trim().toLowerCase()
  if (os === 'unknown' && !row.hostname && !row.sso_email) return false
  return true
}

export function parseApproval(raw: unknown): SeatApproval | null {
  if (typeof raw !== 'string') return null
  const v = raw.trim().toLowerCase()
  return (SEAT_APPROVALS as readonly string[]).includes(v) ? (v as SeatApproval) : null
}

export function parseLicenseStatus(raw: unknown): LicenseStatus | null {
  if (typeof raw !== 'string') return null
  const v = raw.trim().toLowerCase().slice(0, 32)
  if ((LICENSE_STATUSES as readonly string[]).includes(v)) return v as LicenseStatus
  if (/^[a-z0-9]{2,8}$/i.test(v)) return v as LicenseStatus
  return null
}

export function parseLicenseLast4(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const v = raw.trim().replace(/[^a-zA-Z0-9]/g, '')
  if (v.length < 2 || v.length > 8) return null
  return v.slice(-4)
}

function isUnlicensedLabel(raw: string | null | undefined): boolean {
  const v = (raw || '').trim().toLowerCase()
  return v === 'unlicensed' || v.startsWith('unlicensed ·') || v.startsWith('unlicensed·')
}

function last4FromLicenseLabel(raw: string | null | undefined): string | null {
  if (!raw) return null
  const sep = raw.indexOf('·')
  if (sep < 0) return null
  return parseLicenseLast4(raw.slice(sep + 1))
}

function licensedLabel(last4: string | null): string {
  return last4 ? `licensed · ${last4}` : 'licensed'
}

/**
 * Heartbeat may send member-pass status, Operator last4, and Operator jti.
 * Never a raw key. Never self-approve.
 * Member-pass `unlicensed` is not the Operator seat state when a jti or last4 is present.
 */
export function licenseFromIngest(body: Record<string, unknown>): string | null {
  const status = parseLicenseStatus(body.license)
  if (status === 'approved') return null
  const last4 = parseLicenseLast4(body.licenseLast4)
  const jti = parseLicenseId(body.licenseId)
  const operatorBound = Boolean(jti || last4)
  const effective =
    operatorBound && (status == null || status === 'unlicensed') ? 'licensed' : status
  if (effective && last4) return `${effective} · ${last4}`
  if (effective) return effective
  if (last4) return last4
  return null
}

/** Keep a jti-backed licensed label when a later heartbeat still sends member-pass unlicensed. */
export function mergeSeatLicenseLabel(
  incoming: string | null | undefined,
  previous: string | null | undefined,
  jti: string | null | undefined
): string | null {
  const next = incoming ?? null
  const prev = previous ?? null
  if (!parseLicenseId(jti) || !next || !isUnlicensedLabel(next)) return next ?? prev
  if (prev && !isUnlicensedLabel(prev)) return prev
  return licensedLabel(last4FromLicenseLabel(next) ?? last4FromLicenseLabel(prev))
}

/** Portal display: an active issued license bound by license_jti wins over a stored unlicensed label. */
export function seatLicenseLabel(
  seat: Pick<FleetSeat, 'license' | 'license_jti'>,
  issued: ReadonlyArray<Pick<IssuedLicenseRow, 'jti' | 'last4' | 'revoked' | 'exp'>>,
  now: number
): string | null {
  const jti = parseLicenseId(seat.license_jti)
  const row = jti ? issued.find((l) => l.jti === jti) : undefined
  if (row && issuedLicenseActive(row, now)) return licensedLabel(parseLicenseLast4(row.last4))
  const raw = (seat.license || '').trim()
  return raw || null
}

export function isApprovedSeat(row: Pick<FleetSeat, 'approval' | 'license'>): boolean {
  const approval = (row.approval || '').trim().toLowerCase()
  if (approval === 'approved') return true
  if (approval === 'revoked' || approval === 'pending') return false
  return (row.license || '').trim().toLowerCase() === 'approved'
}

export function issuedLicenseActive(
  row: Pick<IssuedLicenseRow, 'revoked' | 'exp'> | null | undefined,
  now: number
): boolean {
  if (!row || row.revoked) return false
  return row.exp * 1000 > now
}

/** Approve click or an active Operator-issued license. Revoke always wins. */
export async function seatAuthorizedForKeys(
  store: Pick<OperatorStore, 'getIssuedLicense'>,
  seat: Pick<FleetSeat, 'approval' | 'license' | 'license_jti'> | null | undefined,
  now = Date.now()
): Promise<boolean> {
  if (!seat) return false
  if ((seat.approval || '').trim().toLowerCase() === 'revoked') return false
  if (isApprovedSeat(seat)) return true
  const jti = parseLicenseId(seat.license_jti)
  if (!jti) return false
  return issuedLicenseActive(await store.getIssuedLicense(jti), now)
}

export function approvalOf(row: Pick<FleetSeat, 'approval' | 'license'>): SeatApproval {
  const parsed = parseApproval(row.approval)
  if (parsed) return parsed
  if ((row.license || '').trim().toLowerCase() === 'approved') return 'approved'
  return 'pending'
}
