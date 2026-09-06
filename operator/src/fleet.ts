/** Real Métis seats vs synthetic import rows. Tony-only approval for platform keys. */

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

/** Heartbeat may send status or last4. Never a raw key. Never self-approve. */
export function licenseFromIngest(body: Record<string, unknown>): string | null {
  const status = parseLicenseStatus(body.license)
  if (status === 'approved') return null
  const last4 = parseLicenseLast4(body.licenseLast4)
  if (status && last4) return `${status} · ${last4}`
  if (status) return status
  if (last4) return last4
  return null
}

export function isApprovedSeat(row: Pick<FleetSeat, 'approval' | 'license'>): boolean {
  const approval = (row.approval || '').trim().toLowerCase()
  if (approval === 'approved') return true
  if (approval === 'revoked' || approval === 'pending') return false
  return (row.license || '').trim().toLowerCase() === 'approved'
}

export function approvalOf(row: Pick<FleetSeat, 'approval' | 'license'>): SeatApproval {
  const parsed = parseApproval(row.approval)
  if (parsed) return parsed
  if ((row.license || '').trim().toLowerCase() === 'approved') return 'approved'
  return 'pending'
}
